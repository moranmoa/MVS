//! Member recovery, the holder's side (`docs/design/member-recovery.md`,
//! §1, §4 and §10; the wiring rules from the Tech Lead and the Security
//! Lead on #431). Pure: `service.rs` keeps one [`HolderStore`] in the core
//! database and feeds it what dev-sync's share store and notice slot bring.
//!
//! - **Sealed at rest** (§10, GAP-11): a share's `y` is kept only in a box
//!   to my holder key (`Identity::recovery_holder_secret`, X25519). Storing
//!   needs only the public key, so a share that arrives while the app is
//!   locked is sealed at once; the secret opens a box only to answer a
//!   valid release, and the share then leaves sealed to the new device.
//! - **Bounded:** at most [`MAX_HANDLES_PER_HOLDER`] handles, at most
//!   [`HANDLES_PER_SENDER`] per sending identity, and a handle nobody
//!   refreshed for [`EVICT_MS`] is dropped (unless a recovery is pending).
//! - **The hold** runs only on a mailer-signed pending ([`PendingNotice`]),
//!   per handle, on this holder's clock (M1). Cancels and deletes count
//!   only while fresh.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as X25519Public, StaticSecret};
use zeroize::Zeroizing;

use crate::recovery::{
    open_from, seal_release, seal_to, Hold, Order, ReleaseToken, ShareRecord, HOLDER_SEAL, HOLD_MS,
    MAX_HANDLES_PER_HOLDER, TOKEN_MAX_MS,
};

const DAY_MS: u64 = 24 * 60 * 60_000;
/// Handles one sending identity may keep at this holder (Tech Lead on #431).
pub const HANDLES_PER_SENDER: usize = 2;
/// A handle not refreshed for this long is dropped (Tech Lead on #431).
pub const EVICT_MS: u64 = 90 * DAY_MS;
const PENDING_SIG: &[u8] = b"mvs/member-recovery-pending/v1";

/// My holder key pair. The secret is wiped when it's dropped.
pub struct HolderKey {
    secret: StaticSecret,
    public: [u8; 32],
}

impl HolderKey {
    /// From `Identity::recovery_holder_secret`.
    pub fn from_secret(secret: &[u8; 32]) -> HolderKey {
        let secret = StaticSecret::from(*secret);
        let public = X25519Public::from(&secret).to_bytes();
        HolderKey { secret, public }
    }

    /// What storing needs; kept in the clear so it works while locked.
    pub fn public(&self) -> [u8; 32] {
        self.public
    }
}

/// The mailer's `pending(h)` for one new device, signed with its pinned key.
/// A holder starts its own hold only on one of these (Security Lead on
/// #431): an unsigned pending could restart the clock at will.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingNotice {
    pub h: [u8; 32],
    pub new_device_pub: [u8; 32],
    pub hold_started: u64,
    pub until: u64,
}

impl PendingNotice {
    fn message(&self) -> Vec<u8> {
        let mut m = PENDING_SIG.to_vec();
        m.extend_from_slice(&self.h);
        m.extend_from_slice(&self.new_device_pub);
        m.extend_from_slice(&self.hold_started.to_be_bytes());
        m.extend_from_slice(&self.until.to_be_bytes());
        m
    }

    pub fn sign(&self, mailer: &SigningKey) -> [u8; 64] {
        mailer.sign(&self.message()).to_bytes()
    }

    /// The mailer's signature, a window that hasn't ended, and one no longer
    /// than the hold plus the token's validity.
    pub fn check(&self, sig: &[u8; 64], mailer: &VerifyingKey, now: u64) -> bool {
        now <= self.until
            && self.hold_started <= self.until
            && self.until - self.hold_started <= HOLD_MS + TOKEN_MAX_MS
            && mailer.verify_strict(&self.message(), &Signature::from_bytes(sig)).is_ok()
    }
}

/// One handle at this holder: the record without its `y`, the `y` sealed to
/// my holder key, who sent it, and the hold.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Held {
    pub h: [u8; 32],
    pub version: u64,
    pub x: u8,
    pub w_pub: [u8; 32],
    pub created: u64,
    /// `w_r`'s signature over the whole record (64 bytes).
    pub sig: Vec<u8>,
    /// `y`, in a [`HOLDER_SEAL`] box to my holder key.
    pub sealed_y: Vec<u8>,
    /// The identity whose device delivered it, for the per-sender cap.
    pub sender: [u8; 32],
    /// The last time the account stored or re-sent this record.
    pub refreshed: u64,
    #[serde(default)]
    pub hold: Hold,
    /// The signed `at` of the last delete taken for this handle.
    #[serde(default)]
    pub last_delete: Option<u64>,
}

/// The `y` box binds the record it belongs to.
fn y_aad(h: &[u8; 32], version: u64, x: u8, w_pub: &[u8; 32]) -> Vec<u8> {
    let mut aad = h.to_vec();
    aad.extend_from_slice(&version.to_be_bytes());
    aad.push(x);
    aad.extend_from_slice(w_pub);
    aad
}

impl Held {
    fn seal(record: &ShareRecord, sender: [u8; 32], holder_pub: &[u8; 32], now: u64) -> Option<Held> {
        let aad = y_aad(&record.h, record.version, record.x, &record.w_pub);
        Some(Held {
            h: record.h,
            version: record.version,
            x: record.x,
            w_pub: record.w_pub,
            created: record.created,
            sig: record.sig.to_vec(),
            sealed_y: seal_to(holder_pub, HOLDER_SEAL, &aad, record.y.as_ref())?,
            sender,
            refreshed: now,
            hold: Hold::default(),
            last_delete: None,
        })
    }

    /// The whole record back, verified. Only to answer a release.
    fn open(&self, key: &HolderKey) -> Option<ShareRecord> {
        let aad = y_aad(&self.h, self.version, self.x, &self.w_pub);
        let plain = open_from(&key.secret, HOLDER_SEAL, &aad, &self.sealed_y)?;
        let mut y = Zeroizing::new([0u8; 32]);
        if plain.len() != 32 {
            return None;
        }
        y.copy_from_slice(&plain);
        let record = ShareRecord {
            h: self.h,
            version: self.version,
            x: self.x,
            y,
            w_pub: self.w_pub,
            created: self.created,
            sig: self.sig.as_slice().try_into().ok()?,
        };
        record.verify().then_some(record)
    }

    fn same_record(&self, record: &ShareRecord) -> bool {
        self.version == record.version
            && self.x == record.x
            && self.created == record.created
            && self.sig.as_slice() == record.sig.as_slice()
    }
}

/// What [`HolderStore::offer`] did with an incoming record.
#[derive(Debug, PartialEq, Eq)]
pub enum Offer {
    /// New, or newer than what was kept (the hold carries over).
    Stored,
    /// The same record again: its refresh time moves.
    Refreshed,
    /// Older, or the same version with other contents.
    Stale,
    /// A bad signature, or a handle not bound to the signing key.
    BadSignature,
    /// [`MAX_HANDLES_PER_HOLDER`] handles already.
    Full,
    /// The sender already has [`HANDLES_PER_SENDER`] handles here.
    SenderFull,
    /// My holder key is a low-order point (never for a real key).
    Unsealable,
}

/// Every handle this holder keeps. Serialised whole into the core database;
/// bounded by [`MAX_HANDLES_PER_HOLDER`].
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HolderStore {
    pub held: Vec<Held>,
}

impl HolderStore {
    fn find(&self, h: &[u8; 32]) -> Option<usize> {
        self.held.iter().position(|e| e.h == *h)
    }

    /// Drops handles nobody refreshed for [`EVICT_MS`], except one with a
    /// pending recovery (the account's devices are gone then; that's when
    /// the share is needed). Returns how many went.
    pub fn evict(&mut self, now: u64) -> usize {
        let before = self.held.len();
        self.held.retain(|e| e.hold.pending_since.is_some() || now.saturating_sub(e.refreshed) <= EVICT_MS);
        before - self.held.len()
    }

    /// An incoming record from `sender`'s device. Checked against the
    /// handle bound to its key, then the version, then the caps; the `y` is
    /// sealed to `holder_pub` before it's kept. A newer version keeps the
    /// handle's hold and order state: a re-share doesn't reset a recovery.
    pub fn offer(&mut self, record: &ShareRecord, sender: [u8; 32], holder_pub: &[u8; 32], now: u64) -> Offer {
        if !record.verify() {
            return Offer::BadSignature;
        }
        self.evict(now);
        let others_from = |store: &HolderStore| {
            store.held.iter().filter(|e| e.sender == sender && e.h != record.h).count()
        };
        match self.find(&record.h) {
            Some(i) => {
                let old = &self.held[i];
                if old.same_record(record) {
                    self.held[i].refreshed = now;
                    return Offer::Refreshed;
                }
                if record.version <= old.version {
                    return Offer::Stale;
                }
                if old.sender != sender && others_from(self) >= HANDLES_PER_SENDER {
                    return Offer::SenderFull;
                }
                let Some(mut new) = Held::seal(record, sender, holder_pub, now) else { return Offer::Unsealable };
                new.hold = old.hold;
                new.last_delete = old.last_delete;
                self.held[i] = new;
                Offer::Stored
            }
            None => {
                if others_from(self) >= HANDLES_PER_SENDER {
                    return Offer::SenderFull;
                }
                if self.held.len() >= MAX_HANDLES_PER_HOLDER {
                    return Offer::Full;
                }
                let Some(new) = Held::seal(record, sender, holder_pub, now) else { return Offer::Unsealable };
                self.held.push(new);
                Offer::Stored
            }
        }
    }

    /// A mailer-signed pending seen. Starts (or, for another device,
    /// restarts) this holder's own hold. False if it isn't valid or the
    /// handle isn't held here.
    pub fn on_pending(&mut self, notice: &PendingNotice, sig: &[u8; 64], mailer: &VerifyingKey, now: u64) -> bool {
        if !notice.check(sig, mailer, now) {
            return false;
        }
        let Some(i) = self.find(&notice.h) else { return false };
        self.held[i].hold.on_pending(notice.new_device_pub, now);
        true
    }

    /// A `w_r`-signed order. A cancel voids the pending (if fresh); a delete
    /// (if fresh) drops the handle when its record is below the version.
    /// Returns whether it was taken.
    pub fn on_order(&mut self, order: &Order, sig: &[u8; 64], now: u64) -> bool {
        let Some(i) = self.find(&order.h()) else { return false };
        if !order.verify_for(sig, &self.held[i].w_pub) {
            return false;
        }
        match *order {
            Order::Cancel { at, .. } => self.held[i].hold.on_cancel(at, now),
            Order::Delete { below_version, at, .. } => {
                if !order.delete_is_fresh(self.held[i].last_delete, now) {
                    return false;
                }
                if self.held[i].version < below_version {
                    self.held.remove(i);
                } else {
                    self.held[i].last_delete = Some(at);
                }
                true
            }
        }
    }

    /// Answers a release request: a valid mailer token for this handle, and
    /// this holder's own hold for that token's device ran its 72 hours with
    /// no cancel. Then the record, opened with my holder key, goes out
    /// sealed to the token's device only.
    pub fn release(
        &self,
        token: &ReleaseToken,
        token_sig: &[u8; 64],
        mailer: &VerifyingKey,
        key: &HolderKey,
        now: u64,
    ) -> Option<Vec<u8>> {
        let held = &self.held[self.find(&token.h)?];
        if !token.check(token_sig, mailer, &held.h, now) || !held.hold.may_release(&token.new_device_pub, now) {
            return None;
        }
        seal_release(&held.open(key)?, &token.new_device_pub)
    }

    /// How many people's pieces I hold (Settings → Privacy).
    pub fn count(&self) -> usize {
        self.held.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::{open_release, split, CANCEL_WINDOW_MS};

    const NOW: u64 = 1_000 * DAY_MS;

    fn w(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    fn record(w_r: &SigningKey, version: u64) -> ShareRecord {
        let share = split(&[3; 32], 3, 3).unwrap().remove(0);
        ShareRecord::sign(w_r, version, &share, NOW)
    }

    fn holder() -> HolderKey {
        HolderKey::from_secret(&[42; 32])
    }

    fn mailer() -> SigningKey {
        SigningKey::from_bytes(&[5; 32])
    }

    fn pending(h: [u8; 32], device: [u8; 32], at: u64) -> (PendingNotice, [u8; 64]) {
        let notice = PendingNotice { h, new_device_pub: device, hold_started: at, until: at + HOLD_MS + DAY_MS };
        let sig = notice.sign(&mailer());
        (notice, sig)
    }

    fn token(h: [u8; 32], device: [u8; 32], at: u64) -> (ReleaseToken, [u8; 64]) {
        let token = ReleaseToken { h, new_device_pub: device, hold_started: at, valid_until: at + HOLD_MS + TOKEN_MAX_MS };
        let sig = token.sign(&mailer());
        (token, sig)
    }

    /// A one-time device key and its public half.
    fn device() -> (StaticSecret, [u8; 32]) {
        let secret = StaticSecret::from([77; 32]);
        let public = X25519Public::from(&secret).to_bytes();
        (secret, public)
    }

    #[test]
    fn y_is_never_kept_in_the_clear() {
        let key = holder();
        let mut store = HolderStore::default();
        let rec = record(&w(1), 1);
        assert_eq!(store.offer(&rec, [1; 32], &key.public(), NOW), Offer::Stored);
        let json = serde_json::to_string(&store).unwrap();
        let y_bytes: Vec<String> = rec.y.iter().map(|b| b.to_string()).collect();
        assert!(!json.contains(&y_bytes.join(",")), "y must not be in the stored form");
        // The box opens with my key only, and to the same record.
        let opened = store.held[0].open(&key).unwrap();
        assert_eq!(*opened.y, *rec.y);
        assert!(store.held[0].open(&HolderKey::from_secret(&[43; 32])).is_none());
        // The box is bound to its record: moved under another version, it fails.
        let mut moved = store.held[0].clone();
        moved.version = 2;
        assert!(moved.open(&key).is_none());
    }

    #[test]
    fn records_refresh_replace_and_go_stale() {
        let key = holder();
        let mut store = HolderStore::default();
        let (v1, v2) = (record(&w(1), 1), record(&w(1), 2));
        assert_eq!(store.offer(&v1, [1; 32], &key.public(), NOW), Offer::Stored);
        assert_eq!(store.offer(&v1, [1; 32], &key.public(), NOW + DAY_MS), Offer::Refreshed);
        assert_eq!(store.held[0].refreshed, NOW + DAY_MS);
        assert_eq!(store.offer(&v2, [1; 32], &key.public(), NOW + 2 * DAY_MS), Offer::Stored);
        assert_eq!(store.offer(&v1, [1; 32], &key.public(), NOW + 3 * DAY_MS), Offer::Stale);
        // Same version, other contents: stale, never a silent swap.
        let other = ShareRecord::sign(&w(1), 2, &split(&[4; 32], 3, 3).unwrap().remove(1), NOW);
        assert_eq!(store.offer(&other, [1; 32], &key.public(), NOW + 3 * DAY_MS), Offer::Stale);
        assert_eq!(store.count(), 1);
        assert_eq!(store.held[0].version, 2);

        let mut forged = v2.clone();
        forged.version = 9;
        assert_eq!(store.offer(&forged, [1; 32], &key.public(), NOW), Offer::BadSignature);
    }

    #[test]
    fn caps_per_sender_and_per_holder() {
        let key = holder();
        let mut store = HolderStore::default();
        let sender = [1u8; 32];
        assert_eq!(store.offer(&record(&w(1), 1), sender, &key.public(), NOW), Offer::Stored);
        assert_eq!(store.offer(&record(&w(2), 1), sender, &key.public(), NOW), Offer::Stored);
        assert_eq!(store.offer(&record(&w(3), 1), sender, &key.public(), NOW), Offer::SenderFull);
        // Its existing handles still update.
        assert_eq!(store.offer(&record(&w(2), 2), sender, &key.public(), NOW), Offer::Stored);
        // And a newer version can't move a handle to a sender who is full.
        let other = [2u8; 32];
        assert_eq!(store.offer(&record(&w(4), 1), other, &key.public(), NOW), Offer::Stored);
        assert_eq!(store.offer(&record(&w(5), 1), other, &key.public(), NOW), Offer::Stored);
        assert_eq!(store.offer(&record(&w(1), 2), other, &key.public(), NOW), Offer::SenderFull);

        let mut full = HolderStore::default();
        for n in 0..MAX_HANDLES_PER_HOLDER {
            let sender = [n as u8; 32];
            assert_eq!(full.offer(&record(&w(n as u8 + 100), 1), sender, &key.public(), NOW), Offer::Stored);
        }
        assert_eq!(full.offer(&record(&w(250), 1), [250; 32], &key.public(), NOW), Offer::Full);
    }

    #[test]
    fn unrefreshed_handles_are_evicted_unless_pending() {
        let key = holder();
        let mut store = HolderStore::default();
        let (a, b) = (record(&w(1), 1), record(&w(2), 1));
        store.offer(&a, [1; 32], &key.public(), NOW);
        store.offer(&b, [2; 32], &key.public(), NOW);
        let (notice, sig) = pending(b.h, [7; 32], NOW + EVICT_MS);
        assert!(store.on_pending(&notice, &sig, &mailer().verifying_key(), NOW + EVICT_MS));
        assert_eq!(store.evict(NOW + EVICT_MS), 0, "90 days exactly still counts");
        assert_eq!(store.evict(NOW + EVICT_MS + 1), 1);
        assert_eq!(store.held[0].h, b.h, "the pending one stays");
        // A sender's slot frees up with the eviction.
        let mut store = HolderStore::default();
        store.offer(&record(&w(1), 1), [1; 32], &key.public(), NOW);
        store.offer(&record(&w(2), 1), [1; 32], &key.public(), NOW);
        let late = NOW + EVICT_MS + 1;
        assert_eq!(store.offer(&record(&w(3), 1), [1; 32], &key.public(), late), Offer::Stored);
    }

    #[test]
    fn only_a_mailer_signed_pending_starts_the_hold() {
        let key = holder();
        let mut store = HolderStore::default();
        let rec = record(&w(1), 1);
        store.offer(&rec, [1; 32], &key.public(), NOW);
        let mailer_pub = mailer().verifying_key();
        let (notice, sig) = pending(rec.h, [7; 32], NOW);
        let forged = notice.sign(&SigningKey::from_bytes(&[6; 32]));
        assert!(!store.on_pending(&notice, &forged, &mailer_pub, NOW), "not the mailer");
        assert_eq!(store.held[0].hold.pending_since, None);
        let swapped = PendingNotice { new_device_pub: [8; 32], ..notice.clone() };
        assert!(!store.on_pending(&swapped, &sig, &mailer_pub, NOW), "bound to the device");
        assert!(!store.on_pending(&notice, &sig, &mailer_pub, notice.until + 1), "over");
        let long = PendingNotice { until: NOW + HOLD_MS + TOKEN_MAX_MS + 1, ..notice.clone() };
        assert!(!store.on_pending(&long, &long.sign(&mailer()), &mailer_pub, NOW), "too long");
        let elsewhere = PendingNotice { h: [9; 32], ..notice.clone() };
        assert!(!store.on_pending(&elsewhere, &elsewhere.sign(&mailer()), &mailer_pub, NOW), "not held here");
        assert!(store.on_pending(&notice, &sig, &mailer_pub, NOW));
        assert_eq!(store.held[0].hold.pending_since, Some(NOW));
    }

    #[test]
    fn release_after_the_hold_to_the_device_only() {
        let key = holder();
        let mut store = HolderStore::default();
        let rec = record(&w(1), 1);
        store.offer(&rec, [1; 32], &key.public(), NOW);
        let mailer_pub = mailer().verifying_key();
        let (dev_secret, dev_pub) = device();
        let (notice, nsig) = pending(rec.h, dev_pub, NOW);
        let (tok, tsig) = token(rec.h, dev_pub, NOW);

        assert!(store.release(&tok, &tsig, &mailer_pub, &key, NOW + HOLD_MS).is_none(), "no pending seen");
        store.on_pending(&notice, &nsig, &mailer_pub, NOW);
        assert!(store.release(&tok, &tsig, &mailer_pub, &key, NOW + HOLD_MS - 1).is_none(), "72 hours not up");
        let sealed = store.release(&tok, &tsig, &mailer_pub, &key, NOW + HOLD_MS).unwrap();
        let back = open_release(&dev_secret, &rec.h, &sealed).unwrap();
        assert!(back.verify());
        assert_eq!(*back.y, *rec.y);
        assert!(open_release(&StaticSecret::from([78; 32]), &rec.h, &sealed).is_none(), "another device");
        assert!(open_release(&dev_secret, &[9; 32], &sealed).is_none(), "another handle");

        // A token for another device gets nothing.
        let (other_tok, osig) = token(rec.h, [8; 32], NOW);
        assert!(store.release(&other_tok, &osig, &mailer_pub, &key, NOW + HOLD_MS).is_none());
        // A forged token neither.
        let bad = tok.sign(&SigningKey::from_bytes(&[6; 32]));
        assert!(store.release(&tok, &bad, &mailer_pub, &key, NOW + HOLD_MS).is_none());
    }

    #[test]
    fn a_fresh_cancel_blocks_the_release_and_a_newer_record_keeps_the_hold() {
        let key = holder();
        let mut store = HolderStore::default();
        let rec = record(&w(1), 1);
        store.offer(&rec, [1; 32], &key.public(), NOW);
        let mailer_pub = mailer().verifying_key();
        let (_, dev_pub) = device();
        let (notice, nsig) = pending(rec.h, dev_pub, NOW);
        store.on_pending(&notice, &nsig, &mailer_pub, NOW);

        // A re-share during the pending doesn't reset the hold.
        store.offer(&record(&w(1), 2), [1; 32], &key.public(), NOW + DAY_MS);
        assert_eq!(store.held[0].hold.pending_since, Some(NOW));

        let cancel = Order::Cancel { h: rec.h, at: NOW + DAY_MS };
        assert!(!store.on_order(&cancel, &cancel.sign(&w(2)), NOW + DAY_MS), "another key");
        assert!(store.on_order(&cancel, &cancel.sign(&w(1)), NOW + DAY_MS));
        assert!(!store.on_order(&cancel, &cancel.sign(&w(1)), NOW + DAY_MS), "counts once");
        let (tok, tsig) = token(rec.h, dev_pub, NOW);
        assert!(store.release(&tok, &tsig, &mailer_pub, &key, NOW + HOLD_MS).is_none());
    }

    #[test]
    fn deletes_drop_older_versions_only_while_fresh() {
        let key = holder();
        let mut store = HolderStore::default();
        let rec = record(&w(1), 2);
        store.offer(&rec, [1; 32], &key.public(), NOW);
        let delete = |below, at| Order::Delete { h: rec.h, below_version: below, at };

        let old = delete(3, NOW - CANCEL_WINDOW_MS - 1);
        assert!(!store.on_order(&old, &old.sign(&w(1)), NOW), "replayed");
        let keep = delete(2, NOW);
        assert!(store.on_order(&keep, &keep.sign(&w(1)), NOW), "taken, but v2 isn't below 2");
        assert_eq!(store.count(), 1);
        assert!(!store.on_order(&keep, &keep.sign(&w(1)), NOW), "once");
        let gone = delete(3, NOW + 1);
        assert!(!store.on_order(&gone, &gone.sign(&w(2)), NOW + 1), "another key");
        assert!(store.on_order(&gone, &gone.sign(&w(1)), NOW + 1));
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn the_store_round_trips_through_json() {
        let key = holder();
        let mut store = HolderStore::default();
        let rec = record(&w(1), 1);
        store.offer(&rec, [1; 32], &key.public(), NOW);
        let back: HolderStore = serde_json::from_slice(&serde_json::to_vec(&store).unwrap()).unwrap();
        assert_eq!(*back.held[0].open(&key).unwrap().y, *rec.y);
    }

    #[test]
    fn record_bytes_round_trip() {
        let rec = record(&w(1), 7);
        let bytes = rec.to_bytes();
        assert_eq!(bytes.len(), crate::recovery::RECORD_LEN);
        let back = ShareRecord::from_bytes(&bytes).unwrap();
        assert!(back.verify());
        assert_eq!((back.h, back.version, back.x, *back.y), (rec.h, rec.version, rec.x, *rec.y));
        assert!(ShareRecord::from_bytes(&bytes[1..]).is_none());
    }

    #[test]
    fn a_low_order_key_is_refused() {
        // The all-zero point: the shared secret would be zero.
        assert!(seal_to(&[0; 32], HOLDER_SEAL, b"", b"y").is_none());
        let mut store = HolderStore::default();
        assert_eq!(store.offer(&record(&w(1), 1), [1; 32], &[0; 32], NOW), Offer::Unsealable);
        assert_eq!(store.count(), 0);
    }
}
