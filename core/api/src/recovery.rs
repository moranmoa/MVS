//! Member recovery, the parts that need no email and no network
//! (`docs/design/member-recovery.md`; its §10, the Security Lead's verdict,
//! wins where it differs). Pure functions only: `service.rs` will hold the
//! state machine and the API, dev-sync the share store and the rendezvous,
//! devops the mailer.
//!
//! - **Shamir** over GF(2^8) (the AES field, `x^8 + x^4 + x^3 + x + 1`),
//!   byte by byte, constant time in the secret bytes: no tables, no
//!   secret-dependent branches.
//! - **Keys:** `k_mr = HKDF-SHA256(s ‖ r_m, info "mvs/member-recovery/v1" ‖ h)`,
//!   the envelope under `tag_mr = derive_key("mvs/member-recovery-tag/v1", h)`,
//!   the release rendezvous at `derive_key("mvs/member-recovery-rv/v1", h)`.
//! - **The threshold is never below 3:** 3-of-5, 3-of-4, or 3-of-3 (weak).
//!   Fewer than 3 owner groups: unavailable.
//! - **Records are signed by `w_r`** (`Identity::recovery_write_key`), not
//!   the backup write key, and the handle is bound to it:
//!   `h = derive_key("mvs/member-recovery-handle/v1", w_r_pub)`. So a
//!   recovery holder can't compute my backup tag, and nobody can claim my
//!   handle first (Tech Lead on #431).
//! - **Holders run their own 72-hour hold** (M1): the mailer's token is
//!   necessary, not sufficient. A cancel counts only while fresh.
//!
//! **What a holder can link.** The handle `h` is unlinkable to my identity
//! key, my backup and my email *in the records*, but holders are picked from members who
//! share servers with me, and a share arrives from one of my devices. A
//! holder can therefore usually tell that `h` is mine. What it can't get is
//! the seed: that needs 3 shares and the mailer's `r_m`.

use chacha20poly1305::aead::{Aead, KeyInit, Payload as Aad};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::devicelink::Payload;

/// Shares needed to rebuild `s`. Never lower (§10).
pub const THRESHOLD: usize = 3;
/// The most holders, one per owner group.
pub const MAX_HOLDERS: usize = 5;
const DAY_MS: u64 = 24 * 60 * 60_000;
/// A holder's own hold, from its first sighting of `pending(h)` (M1).
pub const HOLD_MS: u64 = 3 * DAY_MS;
/// A candidate must have been seen within this to be picked.
pub const PICK_SEEN_MS: u64 = 14 * DAY_MS;
/// A holder unseen this long is stale.
pub const STALE_MS: u64 = 30 * DAY_MS;
/// Re-share when this many holders are stale (§10).
pub const STALE_RESHARE: usize = 2;
/// At most one routine re-share a day (Tech Lead on #401).
pub const RESHARE_GAP_MS: u64 = DAY_MS;
/// The longest a mailer release token may be valid for.
pub const TOKEN_MAX_MS: u64 = 7 * DAY_MS;
/// Share records one holder keeps, at most one per handle.
pub const MAX_HANDLES_PER_HOLDER: usize = 64;
/// How far a cancel's `at` may be from the holder's clock, and how long
/// before the pending's first sighting it may be (Tech Lead on #431): an
/// old cancel replayed later must not block a real recovery.
pub const CANCEL_WINDOW_MS: u64 = 10 * 60_000;

const KEY_INFO: &[u8] = b"mvs/member-recovery/v1";
const HANDLE_CONTEXT: &str = "mvs/member-recovery-handle/v1";
const TAG_CONTEXT: &str = "mvs/member-recovery-tag/v1";
const RV_CONTEXT: &str = "mvs/member-recovery-rv/v1";
const ENVELOPE_AAD: &[u8] = b"mvs/member-recovery-envelope/v1";
const SHARE_SIG: &[u8] = b"mvs/member-recovery-share/v1";
const ORDER_SIG: &[u8] = b"mvs/member-recovery-order/v1";
const TOKEN_SIG: &[u8] = b"mvs/member-recovery-release/v1";

// ---------------------------------------------------------------- GF(2^8)

/// Multiplication in GF(2^8), constant time: eight rounds, masks instead
/// of branches.
fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut product = 0u8;
    for _ in 0..8 {
        product ^= a & 0u8.wrapping_sub(b & 1);
        let carry = 0u8.wrapping_sub(a >> 7);
        a = (a << 1) ^ (0x1b & carry);
        b >>= 1;
    }
    product
}

/// The inverse, `a^254`, by a fixed square-and-multiply chain (the exponent
/// is public, so the branches are too). `gf_inv(0)` is 0; callers never
/// divide by 0.
fn gf_inv(a: u8) -> u8 {
    let mut result = 1u8;
    let mut base = a;
    let mut exp = 254u8;
    while exp > 0 {
        if exp & 1 == 1 {
            result = gf_mul(result, base);
        }
        base = gf_mul(base, base);
        exp >>= 1;
    }
    result
}

// ----------------------------------------------------------------- Shamir

/// One share: the point `x` (1..=255, public) and 32 bytes of `f(x)`.
#[derive(Clone)]
pub struct Share {
    pub x: u8,
    pub y: Zeroizing<[u8; 32]>,
}

/// Splits `secret` into `n` shares, any `k` of which rebuild it. `None`
/// unless `THRESHOLD <= k <= n <= MAX_HOLDERS`.
pub fn split(secret: &[u8; 32], k: usize, n: usize) -> Option<Vec<Share>> {
    if !(THRESHOLD..=n).contains(&k) || n > MAX_HOLDERS {
        return None;
    }
    let mut coeffs = Zeroizing::new(vec![[0u8; 32]; k - 1]);
    for c in coeffs.iter_mut() {
        OsRng.fill_bytes(c);
    }
    Some(split_with(secret, &coeffs, n))
}

/// The split with given coefficients `a_1..a_{k-1}` (tests use fixed ones).
/// Share `i` is at `x = i`, `i` in 1..=n.
fn split_with(secret: &[u8; 32], coeffs: &[[u8; 32]], n: usize) -> Vec<Share> {
    (1..=n as u8)
        .map(|x| {
            let mut y = Zeroizing::new([0u8; 32]);
            for (b, out) in y.iter_mut().enumerate() {
                // Horner: ((a_{k-1}·x + a_{k-2})·x + … )·x + s.
                let mut acc = 0u8;
                for c in coeffs.iter().rev() {
                    acc = gf_mul(acc, x) ^ c[b];
                }
                *out = gf_mul(acc, x) ^ secret[b];
            }
            Share { x, y }
        })
        .collect()
}

/// Rebuilds the secret from shares by Lagrange interpolation at 0. `None`
/// for no shares, an `x` of 0 or a repeated `x`. With fewer than the
/// threshold it returns a wrong secret, not an error: the envelope's
/// authentication is what rejects it.
pub fn combine(shares: &[Share]) -> Option<Zeroizing<[u8; 32]>> {
    if shares.is_empty() || shares.iter().any(|s| s.x == 0) {
        return None;
    }
    for (i, a) in shares.iter().enumerate() {
        if shares[i + 1..].iter().any(|b| b.x == a.x) {
            return None;
        }
    }
    let mut secret = Zeroizing::new([0u8; 32]);
    for (i, share) in shares.iter().enumerate() {
        // l_i(0) = Π_{j≠i} x_j / (x_i ⊕ x_j); the x are public.
        let mut basis = 1u8;
        for (j, other) in shares.iter().enumerate() {
            if i != j {
                basis = gf_mul(basis, gf_mul(other.x, gf_inv(share.x ^ other.x)));
            }
        }
        for (out, y) in secret.iter_mut().zip(share.y.iter()) {
            *out ^= gf_mul(basis, *y);
        }
    }
    Some(secret)
}

// --------------------------------------------------------- keys, envelope

/// The recovery handle, bound to the recovery write key `w_r`.
pub fn handle(w_r_pub: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(HANDLE_CONTEXT, w_r_pub)
}

/// 32 random bytes: `s` or `r_m`.
pub fn random32() -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(out.as_mut());
    out
}

/// `k_mr = HKDF-SHA256(s ‖ r_m, info "mvs/member-recovery/v1" ‖ h)`.
pub fn recovery_key(s: &[u8; 32], r_m: &[u8; 32], h: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let mut ikm = Zeroizing::new([0u8; 64]);
    ikm[..32].copy_from_slice(s);
    ikm[32..].copy_from_slice(r_m);
    let mut info = KEY_INFO.to_vec();
    info.extend_from_slice(h);
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, ikm.as_ref()).expand(&info, key.as_mut()).expect("32 bytes is a valid length");
    key
}

/// Where the envelope lives at the backup holders.
pub fn envelope_tag(h: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(TAG_CONTEXT, h)
}

/// Where a new device asks the holders for their shares.
pub fn rendezvous(h: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(RV_CONTEXT, h)
}

fn envelope_aad(h: &[u8; 32], version: u64) -> Vec<u8> {
    let mut aad = ENVELOPE_AAD.to_vec();
    aad.extend_from_slice(h);
    aad.extend_from_slice(&version.to_be_bytes());
    aad
}

/// Seals the account (the device-link payload) under `k_mr`, bound to `h`
/// and `version`: a random 24-byte nonce, then the box.
pub fn seal_envelope(key: &[u8; 32], h: &[u8; 32], version: u64, account: &Payload) -> Vec<u8> {
    let plain = Zeroizing::new(serde_json::to_vec(account).expect("plain struct"));
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let aad = envelope_aad(h, version);
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), Aad { msg: plain.as_slice(), aad: &aad })
        .expect("in-memory encryption");
    let mut out = nonce.to_vec();
    out.extend(sealed);
    out
}

/// Opens what [`seal_envelope`] made. `None` for a wrong key (too few or
/// stale shares), another handle or version, or tampering.
pub fn open_envelope(key: &[u8; 32], h: &[u8; 32], version: u64, sealed: &[u8]) -> Option<Payload> {
    if sealed.len() < 24 {
        return None;
    }
    let (nonce, body) = sealed.split_at(24);
    let aad = envelope_aad(h, version);
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(nonce), Aad { msg: body, aad: &aad }).ok()?,
    );
    serde_json::from_slice(&plain).ok()
}

// ----------------------------------------------- signed records (by `w_r`)

/// What a holder stores per handle, signed by my recovery write key `w_r`
/// (`w_pub` here is `w_r`'s public key, and `h` is derived from it).
#[derive(Clone)]
pub struct ShareRecord {
    pub h: [u8; 32],
    pub version: u64,
    pub x: u8,
    pub y: Zeroizing<[u8; 32]>,
    pub w_pub: [u8; 32],
    pub created: u64,
    pub sig: [u8; 64],
}

impl ShareRecord {
    fn message(h: &[u8; 32], version: u64, x: u8, y: &[u8; 32], w_pub: &[u8; 32], created: u64) -> Zeroizing<Vec<u8>> {
        let mut m = Zeroizing::new(SHARE_SIG.to_vec());
        m.extend_from_slice(h);
        m.extend_from_slice(&version.to_be_bytes());
        m.push(x);
        m.extend_from_slice(y);
        m.extend_from_slice(w_pub);
        m.extend_from_slice(&created.to_be_bytes());
        m
    }

    /// `w_r` signs; the handle is the one bound to it.
    pub fn sign(w_r: &SigningKey, version: u64, share: &Share, created: u64) -> ShareRecord {
        let w_pub = w_r.verifying_key().to_bytes();
        let h = handle(&w_pub);
        let sig = w_r.sign(&Self::message(&h, version, share.x, &share.y, &w_pub, created)).to_bytes();
        ShareRecord { h, version, x: share.x, y: share.y.clone(), w_pub, created, sig }
    }

    /// `h` is the handle of `w_pub`, the signature checks against `w_pub`,
    /// and `x` isn't 0. Since `h` is bound to the key, nobody can store a
    /// record under someone else's handle first.
    pub fn verify(&self) -> bool {
        let Ok(key) = VerifyingKey::from_bytes(&self.w_pub) else { return false };
        self.x != 0
            && self.h == handle(&self.w_pub)
            && key
                .verify_strict(
                    &Self::message(&self.h, self.version, self.x, &self.y, &self.w_pub, self.created),
                    &Signature::from_bytes(&self.sig),
                )
                .is_ok()
    }

    pub fn share(&self) -> Share {
        Share { x: self.x, y: self.y.clone() }
    }
}

/// A later instruction from the account to its holders, signed by `w_r`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    /// Void the pending recovery; refuse releases for 72 hours. Taken only
    /// while fresh ([`Hold::on_cancel`]).
    Cancel { h: [u8; 32], at: u64 },
    /// Drop share records below this version (after a re-share or disable).
    /// Taken only while fresh ([`Order::delete_is_fresh`]), like a cancel.
    Delete { h: [u8; 32], below_version: u64, at: u64 },
}

impl Order {
    fn message(&self) -> Vec<u8> {
        let mut m = ORDER_SIG.to_vec();
        match self {
            Order::Cancel { h, at } => {
                m.push(1);
                m.extend_from_slice(h);
                m.extend_from_slice(&at.to_be_bytes());
            }
            Order::Delete { h, below_version, at } => {
                m.push(2);
                m.extend_from_slice(h);
                m.extend_from_slice(&below_version.to_be_bytes());
                m.extend_from_slice(&at.to_be_bytes());
            }
        }
        m
    }

    pub fn h(&self) -> [u8; 32] {
        match self {
            Order::Cancel { h, .. } | Order::Delete { h, .. } => *h,
        }
    }

    pub fn sign(&self, w_r: &SigningKey) -> [u8; 64] {
        w_r.sign(&self.message()).to_bytes()
    }

    /// True only if `h` is the handle of the stored record's `w_r`, and the
    /// order is for that handle and signed by that key.
    pub fn verify(&self, sig: &[u8; 64], stored: &ShareRecord) -> bool {
        let Ok(key) = VerifyingKey::from_bytes(&stored.w_pub) else { return false };
        self.h() == stored.h
            && self.h() == handle(&stored.w_pub)
            && key.verify_strict(&self.message(), &Signature::from_bytes(sig)).is_ok()
    }

    /// A delete counts only with `at` within [`CANCEL_WINDOW_MS`] of the
    /// holder's clock and later than the last order taken for the handle
    /// (the same freshness as a cancel, Tech Lead on #431).
    pub fn delete_is_fresh(&self, last_taken: Option<u64>, now: u64) -> bool {
        match self {
            Order::Delete { at, .. } => {
                now.abs_diff(*at) <= CANCEL_WINDOW_MS && last_taken.is_none_or(|last| *at > last)
            }
            Order::Cancel { .. } => false,
        }
    }
}

/// Whether a holder takes an incoming share record.
#[derive(Debug, PartialEq, Eq)]
pub enum Accept {
    Store,
    /// A bad signature, or a handle not bound to the signing key.
    BadSignature,
    /// Not newer than what's stored.
    Stale,
    /// This holder already keeps [`MAX_HANDLES_PER_HOLDER`] handles.
    Full,
}

/// The holder's rule for an incoming record: signed with the handle bound
/// to its key, newer than the stored record for that handle, and within
/// the handle cap. `stored` is what the holder keeps under `incoming.h`;
/// the binding makes it the same writer. (The per-sender cap is the
/// wiring PR's, at the store.)
pub fn accept_share(incoming: &ShareRecord, stored: Option<&ShareRecord>, handles_held: usize) -> Accept {
    if !incoming.verify() {
        return Accept::BadSignature;
    }
    debug_assert!(stored.is_none_or(|old| old.h == incoming.h && old.w_pub == incoming.w_pub));
    match stored {
        Some(old) if incoming.version <= old.version => Accept::Stale,
        Some(_) => Accept::Store,
        None if handles_held >= MAX_HANDLES_PER_HOLDER => Accept::Full,
        None => Accept::Store,
    }
}

// --------------------------------------------------------- holder choice

/// A co-member, as seen through one server. The same member through two
/// servers is two rows; the pick uses each member at most once.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub member: [u8; 32],
    /// The genesis key of the server's owner: the owner group.
    pub owner: [u8; 32],
    /// An accepted 18+ age claim in that server.
    pub adult: bool,
    /// Not kicked, not left, the server not closed.
    pub current: bool,
    pub blocked: bool,
    /// Me on another device.
    pub mine: bool,
    pub last_seen: u64,
    /// Members of that server besides me.
    pub others_in_server: u32,
    /// Since when this member and I have both been in that server.
    pub shared_since: u64,
    /// Since when I've been in that server.
    pub my_join: u64,
}

impl Candidate {
    fn eligible(&self, now: u64, adult_required: bool) -> bool {
        (self.adult || !adult_required)
            && self.current
            && !self.blocked
            && !self.mine
            && now.saturating_sub(self.last_seen) <= PICK_SEEN_MS
            && self.others_in_server >= 2
    }
}

/// A chosen holder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub member: [u8; 32],
    pub owner: [u8; 32],
}

/// The share plan for the current candidates.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Fewer than 3 owner groups: "not enough independent servers yet".
    Unavailable,
    /// 3-of-`holders.len()`; `weak` at 3-of-3.
    Shares { holders: Vec<Pick>, weak: bool },
}

impl Plan {
    pub fn threshold(&self) -> Option<usize> {
        matches!(self, Plan::Shares { .. }).then_some(THRESHOLD)
    }
}

/// The greedy pick (§2, with §10's thresholds):
/// 1. eligible candidates, grouped by owner;
/// 2. groups in the order I joined that owner's servers, earliest first;
/// 3. from each group, the member with the longest shared membership, then
///    the most recently seen, then the lowest key; a member already picked
///    through another owner is skipped;
/// 4. at most 5, at least 3, and no two holders under one owner.
pub fn pick_holders(candidates: &[Candidate], now: u64) -> Plan {
    let holders = pick_owner_groups(candidates, now, MAX_HOLDERS, true);
    if holders.len() < THRESHOLD {
        return Plan::Unavailable;
    }
    let weak = holders.len() == THRESHOLD;
    Plan::Shares { holders, weak }
}

/// The pick shared by member recovery and backup buddies (G-91, Tech Lead):
/// at most `max` members, at most one per owner group, in the order of
/// [`pick_holders`]. `adult_required`: recovery holders must be 18+;
/// buddies hold a sealed blob, so age doesn't matter there.
pub fn pick_owner_groups(candidates: &[Candidate], now: u64, max: usize, adult_required: bool) -> Vec<Pick> {
    let mut owners: Vec<([u8; 32], u64)> = Vec::new();
    for c in candidates.iter().filter(|c| c.eligible(now, adult_required)) {
        match owners.iter_mut().find(|(o, _)| *o == c.owner) {
            Some((_, joined)) => *joined = (*joined).min(c.my_join),
            None => owners.push((c.owner, c.my_join)),
        }
    }
    owners.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    let mut holders: Vec<Pick> = Vec::new();
    for (owner, _) in owners {
        if holders.len() == max {
            break;
        }
        let best = candidates
            .iter()
            .filter(|c| c.owner == owner && c.eligible(now, adult_required) && !holders.iter().any(|p| p.member == c.member))
            .min_by(|a, b| {
                a.shared_since.cmp(&b.shared_since).then(b.last_seen.cmp(&a.last_seen)).then(a.member.cmp(&b.member))
            });
        if let Some(c) = best {
            holders.push(Pick { member: c.member, owner });
        }
    }
    holders
}

// --------------------------------------------------------------- re-share

/// A current holder as my device sees it on a sync round.
#[derive(Clone, Debug)]
pub struct HolderStatus {
    pub member: [u8; 32],
    /// The owner it counts under now (an ownership transfer changes it).
    pub owner: [u8; 32],
    /// Left, kicked, deleted the account, or the server it was picked
    /// through closed.
    pub gone: bool,
    pub last_seen: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reshare {
    /// A holder is gone.
    Gone,
    /// Two holders now share an owner.
    SharedOwner,
    /// [`STALE_RESHARE`] or more holders unseen for [`STALE_MS`].
    Stale,
    /// On 3-of-3 while a plan with more holders exists.
    Grow,
}

/// Why to re-share now, if at all. `possible` is how many holders a fresh
/// pick would give. A gone holder or two under one owner is acted on at
/// once; the routine reasons (stale, grow) wait [`RESHARE_GAP_MS`] after
/// the last re-share (Tech Lead on #431 and G-91). The caller also
/// re-shares at once after a recovery or a cancel.
pub fn reshare_reason(holders: &[HolderStatus], possible: usize, last_reshare: u64, now: u64) -> Option<Reshare> {
    if holders.iter().any(|h| h.gone) {
        return Some(Reshare::Gone);
    }
    if holders.iter().enumerate().any(|(i, a)| holders[i + 1..].iter().any(|b| b.owner == a.owner)) {
        return Some(Reshare::SharedOwner);
    }
    if now.saturating_sub(last_reshare) < RESHARE_GAP_MS {
        return None;
    }
    if holders.iter().filter(|h| now.saturating_sub(h.last_seen) > STALE_MS).count() >= STALE_RESHARE {
        return Some(Reshare::Stale);
    }
    if holders.len() == THRESHOLD && possible > THRESHOLD {
        return Some(Reshare::Grow);
    }
    None
}

// ----------------------------------------------------- the holder's hold

/// The mailer's release token, signed with its pinned key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseToken {
    pub h: [u8; 32],
    pub new_device_pub: [u8; 32],
    pub hold_started: u64,
    pub valid_until: u64,
}

impl ReleaseToken {
    fn message(&self) -> Vec<u8> {
        let mut m = TOKEN_SIG.to_vec();
        m.extend_from_slice(&self.h);
        m.extend_from_slice(&self.new_device_pub);
        m.extend_from_slice(&self.hold_started.to_be_bytes());
        m.extend_from_slice(&self.valid_until.to_be_bytes());
        m
    }

    pub fn sign(&self, mailer: &SigningKey) -> [u8; 64] {
        mailer.sign(&self.message()).to_bytes()
    }

    /// The signature, the handle, and a validity window that hasn't ended
    /// and is no longer than [`TOKEN_MAX_MS`] from the hold's start.
    pub fn check(&self, sig: &[u8; 64], mailer: &VerifyingKey, h: &[u8; 32], now: u64) -> bool {
        self.h == *h
            && now <= self.valid_until
            && self.hold_started <= self.valid_until
            && self.valid_until - self.hold_started <= HOLD_MS + TOKEN_MAX_MS
            && mailer.verify_strict(&self.message(), &Signature::from_bytes(sig)).is_ok()
    }
}

/// One holder's own view of a handle's recovery, on its own clock (M1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Hold {
    /// When this holder first saw the current `pending(h)`.
    pub pending_since: Option<u64>,
    /// The new device that pending is for: the hold runs for it alone
    /// (Security Lead on #431).
    #[serde(default)]
    pub pending_device: Option<[u8; 32]>,
    /// When this holder last took a valid cancel.
    pub cancelled_at: Option<u64>,
    /// The signed `at` of the last cancel taken: one cancel counts once.
    #[serde(default)]
    pub last_cancel: Option<u64>,
}

impl Hold {
    /// `pending(h)` for `device` seen. The clock starts at the first
    /// sighting; a pending for a *different* device restarts it, with its
    /// own 72 hours (and the notice shows the new device).
    pub fn on_pending(&mut self, device: [u8; 32], now: u64) {
        if self.pending_device != Some(device) || self.pending_since.is_none() {
            self.pending_device = Some(device);
            self.pending_since = Some(now);
        }
    }

    /// A `w_r`-signed cancel (the caller checked the signature) with its
    /// signed time `at`. Taken only if fresh (Tech Lead on #431):
    /// - `at` within [`CANCEL_WINDOW_MS`] of this holder's clock;
    /// - not older than the pending's first sighting minus the window;
    /// - later than the last cancel taken.
    ///
    /// So a cancel recorded earlier and replayed later can't block a real
    /// recovery. Taken: the pending is void, and the next one starts a
    /// fresh clock. Returns whether it was taken.
    pub fn on_cancel(&mut self, at: u64, now: u64) -> bool {
        let fresh = now.abs_diff(at) <= CANCEL_WINDOW_MS
            && self.pending_since.is_none_or(|since| at.saturating_add(CANCEL_WINDOW_MS) >= since)
            && self.last_cancel.is_none_or(|last| at > last);
        if fresh {
            self.pending_since = None;
            self.pending_device = None;
            self.cancelled_at = Some(now);
            self.last_cancel = Some(at);
        }
        fresh
    }

    /// Release only to `token_device` (the valid [`ReleaseToken`]'s
    /// `new_device_pub`), and only if this holder itself has seen the
    /// pending *for that device* for [`HOLD_MS`], with no cancel in the
    /// last [`HOLD_MS`]. The token is necessary, not sufficient; the share
    /// is then sealed to that key only.
    pub fn may_release(&self, token_device: &[u8; 32], now: u64) -> bool {
        let same = self.pending_device.as_ref() == Some(token_device);
        let held = self.pending_since.is_some_and(|since| now.saturating_sub(since) >= HOLD_MS);
        let quiet = self.cancelled_at.is_none_or(|at| now.saturating_sub(at) >= HOLD_MS);
        same && held && quiet
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devicelink::PayloadProfile;

    #[test]
    fn field_matches_the_aes_vectors() {
        // FIPS-197 §4.2: {57}·{83} = {c1}, {57}·{13} = {fe}; §5.1.1: {53}⁻¹ = {ca}.
        assert_eq!(gf_mul(0x57, 0x83), 0xc1);
        assert_eq!(gf_mul(0x57, 0x13), 0xfe);
        assert_eq!(gf_inv(0x53), 0xca);
        for a in 1..=255u8 {
            assert_eq!(gf_mul(a, gf_inv(a)), 1, "{a:#04x}");
        }
        assert_eq!(gf_inv(0), 0);
    }

    #[test]
    fn split_matches_hand_computed_shares() {
        // f(x) = 0x2a + 0x01·x + 0x02·x² in every byte:
        // f(1) = 2a^01^02 = 29, f(2) = 2a^02^08 = 20, f(3) = 2a^03^(02·05) = 23.
        let shares = split_with(&[0x2a; 32], &[[0x01; 32], [0x02; 32]], 3);
        let ys: Vec<u8> = shares.iter().map(|s| s.y[0]).collect();
        assert_eq!(ys, [0x29, 0x20, 0x23]);
        assert!(shares.iter().all(|s| s.y.iter().all(|b| *b == s.y[0])));
        assert_eq!(*combine(&shares).unwrap(), [0x2a; 32]);
    }

    #[test]
    fn any_three_of_five_rebuild_and_two_do_not() {
        let secret = random32();
        let shares = split(&secret, 3, 5).unwrap();
        for a in 0..5 {
            for b in a + 1..5 {
                for c in b + 1..5 {
                    let pick = [shares[a].clone(), shares[b].clone(), shares[c].clone()];
                    assert_eq!(*combine(&pick).unwrap(), *secret);
                }
                assert_ne!(*combine(&[shares[a].clone(), shares[b].clone()]).unwrap(), *secret);
            }
        }
        // All five work too; order doesn't matter.
        let mut all = shares.clone();
        all.reverse();
        assert_eq!(*combine(&all).unwrap(), *secret);
    }

    #[test]
    fn shares_from_different_splits_of_one_secret_do_not_combine() {
        // The re-share case (Security Lead on #431): same secret, new split.
        let secret = random32();
        let first = split(&secret, 3, 5).unwrap();
        let second = split(&secret, 3, 5).unwrap();
        let mixed = [first[0].clone(), first[1].clone(), second[2].clone()];
        assert_ne!(*combine(&mixed).unwrap(), *secret);
        let mixed = [first[0].clone(), second[1].clone(), second[2].clone()];
        assert_ne!(*combine(&mixed).unwrap(), *secret);
    }

    #[test]
    fn split_and_combine_refuse_bad_input() {
        let s = [7u8; 32];
        assert!(split(&s, 2, 3).is_none(), "the threshold is never below 3");
        assert!(split(&s, 4, 3).is_none());
        assert!(split(&s, 3, 6).is_none());
        assert!(split(&s, 3, 3).is_some());
        let shares = split(&s, 3, 4).unwrap();
        assert!(combine(&[]).is_none());
        assert!(combine(&[shares[0].clone(), shares[0].clone(), shares[1].clone()]).is_none());
        assert!(combine(&[Share { x: 0, y: Zeroizing::new([1; 32]) }]).is_none());
    }

    fn account() -> Payload {
        Payload {
            seed: Zeroizing::new("legal winner thank year wave sausage worth useful legal winner thank yellow".into()),
            profile: PayloadProfile { display_name: "Me".into(), avatar_small: None, color: None },
            birth_date: "1990-05-01".into(),
            birth_date_trusted: true,
            country: "IL".into(),
        }
    }

    #[test]
    fn envelope_needs_three_shares_and_r_m_and_the_right_version() {
        let (s, r_m, h) = (random32(), random32(), random32());
        let key = recovery_key(&s, &r_m, &h);
        let sealed = seal_envelope(&key, &h, 4, &account());
        let shares = split(&s, 3, 5).unwrap();

        let rebuilt = combine(&shares[1..4]).unwrap();
        let opened = open_envelope(&recovery_key(&rebuilt, &r_m, &h), &h, 4, &sealed).unwrap();
        assert_eq!(opened.seed.as_str(), account().seed.as_str());
        assert!(opened.birth_date_trusted);

        let two = combine(&shares[..2]).unwrap();
        assert!(open_envelope(&recovery_key(&two, &r_m, &h), &h, 4, &sealed).is_none(), "2 shares");
        assert!(open_envelope(&recovery_key(&s, &random32(), &h), &h, 4, &sealed).is_none(), "no r_m");
        assert!(open_envelope(&key, &h, 3, &sealed).is_none(), "another version");
        assert!(open_envelope(&key, &random32(), 4, &sealed).is_none(), "another handle");
        let mut bent = sealed.clone();
        *bent.last_mut().unwrap() ^= 1;
        assert!(open_envelope(&key, &h, 4, &bent).is_none());
        assert!(open_envelope(&key, &h, 4, &sealed[..10]).is_none());
    }

    #[test]
    fn a_reshare_is_a_fresh_split() {
        let (r_m, h) = (random32(), random32());
        let (s1, s2) = (random32(), random32());
        let old = split(&s1, 3, 5).unwrap();
        let new = split(&s2, 3, 5).unwrap();
        let sealed = seal_envelope(&recovery_key(&s2, &r_m, &h), &h, 2, &account());
        // Old holders together, or old mixed with new, never open the new envelope.
        for mix in [[old[0].clone(), old[1].clone(), old[2].clone()], [old[0].clone(), new[1].clone(), new[2].clone()]] {
            let s = combine(&mix).unwrap();
            assert!(open_envelope(&recovery_key(&s, &r_m, &h), &h, 2, &sealed).is_none());
        }
        assert_ne!(envelope_tag(&h), rendezvous(&h));
    }

    fn w() -> SigningKey {
        SigningKey::from_bytes(&[9; 32])
    }

    #[test]
    fn holders_take_only_signed_newer_records_bound_to_their_handle() {
        let share = split(&[3; 32], 3, 3).unwrap().remove(0);
        let v1 = ShareRecord::sign(&w(), 1, &share, 100);
        let v2 = ShareRecord::sign(&w(), 2, &share, 200);
        assert!(v1.verify());
        assert_eq!(v1.h, handle(&w().verifying_key().to_bytes()));
        assert_eq!(accept_share(&v1, None, 0), Accept::Store);
        assert_eq!(accept_share(&v2, Some(&v1), 1), Accept::Store);
        assert_eq!(accept_share(&v1, Some(&v2), 1), Accept::Stale);
        assert_eq!(accept_share(&v1, None, MAX_HANDLES_PER_HOLDER), Accept::Full);

        let mut forged = v2.clone();
        forged.version = 9;
        assert_eq!(accept_share(&forged, Some(&v1), 1), Accept::BadSignature);
        let mut moved = v2.clone();
        moved.y[0] ^= 1;
        assert!(!moved.verify());

        // Squatting: another key can't put a record under my handle, even
        // with a valid signature of its own.
        let thief = SigningKey::from_bytes(&[8; 32]);
        let mut squat = ShareRecord::sign(&thief, 5, &share, 300);
        assert!(squat.verify(), "its own handle is fine");
        squat.h = v1.h;
        squat.sig = thief
            .sign(&ShareRecord::message(&squat.h, 5, squat.x, &squat.y, &squat.w_pub, 300))
            .to_bytes();
        assert!(!squat.verify());
        assert_eq!(accept_share(&squat, None, 0), Accept::BadSignature);
    }

    #[test]
    fn recovery_records_use_their_own_key_not_the_backup_writer() {
        let phrase = identity::RecoveryPhrase::parse(
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
        )
        .unwrap();
        let id = phrase.identity();
        let w_r = id.recovery_write_key();
        let backup = id.backup_keys();
        assert_ne!(w_r.to_bytes(), backup.write_key().to_bytes());
        let h = handle(&w_r.verifying_key().to_bytes());
        // The handle tells nothing about the backup tag, and vice versa.
        assert_ne!(h, backup.tag());
        assert_ne!(identity::backup_tag(&w_r.verifying_key().to_bytes()), backup.tag());
        assert_eq!(phrase.identity().recovery_write_key().to_bytes(), w_r.to_bytes(), "deterministic");
    }

    #[test]
    fn orders_count_only_from_the_stored_writer_for_that_handle() {
        let share = split(&[3; 32], 3, 3).unwrap().remove(0);
        let stored = ShareRecord::sign(&w(), 1, &share, 100);
        let h = stored.h;
        let cancel = Order::Cancel { h, at: 500 };
        assert!(cancel.verify(&cancel.sign(&w()), &stored));
        assert!(!cancel.verify(&cancel.sign(&SigningKey::from_bytes(&[8; 32])), &stored));
        let delete = Order::Delete { h, below_version: 2, at: 500 };
        let sig = delete.sign(&w());
        assert!(delete.verify(&sig, &stored));
        // A signature can't be moved to another order or handle.
        assert!(!Order::Delete { h, below_version: 3, at: 500 }.verify(&sig, &stored));
        assert!(!Order::Cancel { h, at: 2 }.verify(&sig, &stored));
        let elsewhere = Order::Delete { h: [2; 32], below_version: 2, at: 500 };
        assert!(!elsewhere.verify(&elsewhere.sign(&w()), &stored));
        // A stored record whose h isn't bound to its key backs no order.
        let mut unbound = stored.clone();
        unbound.h = [2; 32];
        assert!(!elsewhere.verify(&elsewhere.sign(&w()), &unbound));
    }

    #[test]
    fn only_a_fresh_delete_counts() {
        let h = [1u8; 32];
        let delete = |at| Order::Delete { h, below_version: 2, at };
        assert!(delete(NOW).delete_is_fresh(None, NOW + CANCEL_WINDOW_MS));
        assert!(!delete(NOW).delete_is_fresh(None, NOW + CANCEL_WINDOW_MS + 1), "old, replayed");
        assert!(!delete(NOW + CANCEL_WINDOW_MS + 1).delete_is_fresh(None, NOW), "from the future");
        assert!(!delete(NOW).delete_is_fresh(Some(NOW), NOW), "taken once");
        assert!(delete(NOW + 1).delete_is_fresh(Some(NOW), NOW));
        assert!(!Order::Cancel { h, at: NOW }.delete_is_fresh(None, NOW));
    }

    const NOW: u64 = 1_000 * DAY_MS;
    const DEV: [u8; 32] = [7; 32];

    fn cand(member: u8, owner: u8) -> Candidate {
        Candidate {
            member: [member; 32],
            owner: [owner; 32],
            adult: true,
            current: true,
            blocked: false,
            mine: false,
            last_seen: NOW - DAY_MS,
            others_in_server: 5,
            shared_since: 10 * DAY_MS,
            my_join: owner as u64 * DAY_MS,
        }
    }

    fn holders(plan: &Plan) -> Vec<u8> {
        match plan {
            Plan::Shares { holders, .. } => holders.iter().map(|p| p.member[0]).collect(),
            Plan::Unavailable => vec![],
        }
    }

    #[test]
    fn one_holder_per_owner_and_the_threshold_never_below_three() {
        // One owner with many members (sock puppets) gives one holder.
        let puppets: Vec<Candidate> = (1..=9).map(|m| cand(m, 1)).collect();
        assert_eq!(pick_holders(&puppets, NOW), Plan::Unavailable);

        let two: Vec<Candidate> = vec![cand(1, 1), cand(2, 2), cand(3, 2)];
        assert_eq!(pick_holders(&two, NOW), Plan::Unavailable);

        let three = vec![cand(1, 1), cand(2, 2), cand(3, 3)];
        let plan = pick_holders(&three, NOW);
        assert!(matches!(plan, Plan::Shares { weak: true, .. }));
        assert_eq!(plan.threshold(), Some(3));

        let four: Vec<Candidate> = (1..=4).map(|o| cand(o, o)).collect();
        assert!(matches!(pick_holders(&four, NOW), Plan::Shares { weak: false, ref holders } if holders.len() == 4));

        // Seven owners: the five whose servers I joined first.
        let seven: Vec<Candidate> = (1..=7).map(|o| cand(10 + o, o)).collect();
        assert_eq!(holders(&pick_holders(&seven, NOW)), [11, 12, 13, 14, 15]);
    }

    #[test]
    fn buddies_take_one_per_owner_and_ignore_age() {
        // G-91 (Tech Lead): one owner's 5 sock puppets yield at most 1 buddy.
        let puppets: Vec<Candidate> = (1..=5).map(|m| cand(m, 1)).collect();
        assert_eq!(pick_owner_groups(&puppets, NOW, 3, false).len(), 1);
        let mut list: Vec<Candidate> = (1..=4).map(|o| cand(o, o)).collect();
        list.iter_mut().for_each(|c| c.adult = false);
        assert!(pick_owner_groups(&list, NOW, 3, true).is_empty(), "recovery needs 18+");
        let buddies: Vec<u8> = pick_owner_groups(&list, NOW, 3, false).iter().map(|p| p.member[0]).collect();
        assert_eq!(buddies, [1, 2, 3], "buddies don't, and stop at 3");
    }

    #[test]
    fn ineligible_candidates_are_skipped() {
        let mut list: Vec<Candidate> = (1..=3).map(|o| cand(o, o)).collect();
        assert_ne!(pick_holders(&list, NOW), Plan::Unavailable);
        type Bend = fn(&mut Candidate);
        let bends: [Bend; 6] = [
            |c| c.adult = false,
            |c| c.current = false,
            |c| c.blocked = true,
            |c| c.mine = true,
            |c| c.last_seen = NOW - PICK_SEEN_MS - 1,
            |c| c.others_in_server = 1,
        ];
        for bend in bends {
            let mut bent = list.clone();
            bend(&mut bent[2]);
            assert_eq!(pick_holders(&bent, NOW), Plan::Unavailable);
        }
        list[2].last_seen = NOW - PICK_SEEN_MS;
        assert_ne!(pick_holders(&list, NOW), Plan::Unavailable, "14 days exactly still counts");
    }

    #[test]
    fn the_pick_prefers_long_membership_and_never_uses_a_member_twice() {
        let mut a = cand(1, 1);
        a.shared_since = 50 * DAY_MS;
        let mut b = cand(2, 1);
        b.shared_since = 20 * DAY_MS;
        let mut c = cand(3, 1);
        c.shared_since = 20 * DAY_MS;
        c.last_seen = NOW - 2 * DAY_MS;
        // Member 2 is also in owner 2's server; owner 2 must pick someone else.
        let list = vec![a, b, c, cand(2, 2), cand(4, 2), cand(5, 3)];
        assert_eq!(holders(&pick_holders(&list, NOW)), [2, 4, 5]);
    }

    fn status(member: u8, owner: u8) -> HolderStatus {
        HolderStatus { member: [member; 32], owner: [owner; 32], gone: false, last_seen: NOW - DAY_MS }
    }

    #[test]
    fn reshare_triggers_and_the_daily_gap() {
        let base: Vec<HolderStatus> = (1..=5).map(|i| status(i, i)).collect();
        let long_ago = NOW - 10 * DAY_MS;
        assert_eq!(reshare_reason(&base, 5, long_ago, NOW), None);

        let mut gone = base.clone();
        gone[0].gone = true;
        assert_eq!(reshare_reason(&gone, 5, long_ago, NOW), Some(Reshare::Gone));
        let just_now = NOW - DAY_MS + 1;
        assert_eq!(reshare_reason(&gone, 5, just_now, NOW), Some(Reshare::Gone), "gone: at once");

        let mut shared = base.clone();
        shared[4].owner = [1; 32];
        assert_eq!(reshare_reason(&shared, 5, just_now, NOW), Some(Reshare::SharedOwner), "at once");

        let mut stale = base.clone();
        stale[0].last_seen = NOW - STALE_MS - 1;
        assert_eq!(reshare_reason(&stale, 5, long_ago, NOW), None, "one stale holder isn't enough");
        stale[1].last_seen = NOW - STALE_MS - 1;
        assert_eq!(reshare_reason(&stale, 5, long_ago, NOW), Some(Reshare::Stale));
        assert_eq!(reshare_reason(&stale, 5, just_now, NOW), None, "routine: at most once a day");

        assert_eq!(reshare_reason(&base[..3], 3, long_ago, NOW), None);
        assert_eq!(reshare_reason(&base[..3], 4, long_ago, NOW), Some(Reshare::Grow));
        assert_eq!(reshare_reason(&base[..3], 4, just_now, NOW), None);
    }

    #[test]
    fn holders_keep_their_own_hold_and_a_cancel_wins() {
        let mut hold = Hold::default();
        assert!(!hold.may_release(&DEV, NOW), "nothing pending");
        hold.on_pending(DEV, NOW);
        hold.on_pending(DEV, NOW + DAY_MS); // seeing it again doesn't restart the clock
        assert!(!hold.may_release(&DEV, NOW + HOLD_MS - 1));
        assert!(hold.may_release(&DEV, NOW + HOLD_MS));

        assert!(hold.on_cancel(NOW + HOLD_MS - 5_000, NOW + HOLD_MS));
        assert!(!hold.may_release(&DEV, NOW + 10 * HOLD_MS), "a cancel voids the pending");
        hold.on_pending(DEV, NOW + HOLD_MS + 1);
        assert!(!hold.may_release(&DEV, NOW + 2 * HOLD_MS), "within 72 hours of the cancel");
        assert!(hold.may_release(&DEV, NOW + 2 * HOLD_MS + 1));
    }

    #[test]
    fn only_a_fresh_cancel_counts() {
        let start = NOW;
        // A cancel signed long ago, replayed during a later real recovery.
        let old_at = start - 30 * DAY_MS;
        let mut hold = Hold::default();
        hold.on_pending(DEV, start);
        assert!(!hold.on_cancel(old_at, start + DAY_MS), "far from the clock");
        assert!(hold.may_release(&DEV, start + HOLD_MS), "the old cancel didn't block it");

        // Within the clock window but from before this pending: refused.
        let mut hold = Hold::default();
        hold.on_pending(DEV, start);
        let late = start + CANCEL_WINDOW_MS + 1;
        assert!(!hold.on_cancel(start - CANCEL_WINDOW_MS - 1, start), "older than the pending");
        assert!(hold.on_cancel(start - CANCEL_WINDOW_MS, start), "just inside the window");
        // The same cancel again later, and an older one, count no more.
        hold.on_pending(DEV, late);
        assert!(!hold.on_cancel(start - CANCEL_WINDOW_MS, late));
        assert!(!hold.on_cancel(start - CANCEL_WINDOW_MS - 2, late));
        assert_eq!(hold.pending_since, Some(late));

        // A cancel from the future beyond the window: refused.
        let mut hold = Hold::default();
        hold.on_pending(DEV, start);
        assert!(!hold.on_cancel(start + CANCEL_WINDOW_MS + 1, start));
        assert!(hold.on_cancel(start + CANCEL_WINDOW_MS, start));
    }

    #[test]
    fn the_hold_is_for_one_device() {
        let other = [8u8; 32];
        let mut hold = Hold::default();
        hold.on_pending(DEV, NOW);
        assert!(hold.may_release(&DEV, NOW + HOLD_MS));
        assert!(!hold.may_release(&other, NOW + HOLD_MS), "a token for another device");

        // A pending for another device restarts the clock, for that device.
        hold.on_pending(other, NOW + DAY_MS);
        assert!(!hold.may_release(&DEV, NOW + HOLD_MS), "the first device's hold is gone");
        assert!(!hold.may_release(&other, NOW + HOLD_MS), "a fresh 72 hours");
        assert!(hold.may_release(&other, NOW + DAY_MS + HOLD_MS));
        assert_eq!(hold.pending_device, Some(other));
    }

    #[test]
    fn release_tokens_are_bound_and_bounded() {
        let mailer = SigningKey::from_bytes(&[5; 32]);
        let h = [1u8; 32];
        let token = ReleaseToken { h, new_device_pub: [2; 32], hold_started: NOW, valid_until: NOW + HOLD_MS + TOKEN_MAX_MS };
        let sig = token.sign(&mailer);
        let key = mailer.verifying_key();
        assert!(token.check(&sig, &key, &h, NOW + HOLD_MS));
        assert!(!token.check(&sig, &key, &[3; 32], NOW + HOLD_MS), "another handle");
        assert!(!token.check(&sig, &key, &h, token.valid_until + 1), "expired");
        assert!(!token.check(&sig, &SigningKey::from_bytes(&[6; 32]).verifying_key(), &h, NOW), "another mailer");
        let swapped = ReleaseToken { new_device_pub: [4; 32], ..token.clone() };
        assert!(!swapped.check(&sig, &key, &h, NOW + HOLD_MS), "bound to the new device");
        let backwards = ReleaseToken { hold_started: NOW + 2 * DAY_MS, valid_until: NOW + DAY_MS, ..token.clone() };
        assert!(!backwards.check(&backwards.sign(&mailer), &key, &h, NOW), "ends before the hold starts");
        let long = ReleaseToken { valid_until: token.valid_until + 1, ..token };
        assert!(!long.check(&long.sign(&mailer), &key, &h, NOW), "validity too long");
    }
}
