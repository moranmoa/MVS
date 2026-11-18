//! Member recovery, the account's own devices (`docs/design/member-recovery.md`
//! §3 and §4; the wiring rules from the Tech Lead and the Security Lead on
//! #431). Pure: `service.rs` drives these from its sync round.
//!
//! - **The recovering device** ([`Collector`]): takes released records only
//!   for the one handle it asked for, which binds them to one `w_r_pub`;
//!   keeps at most [`MAX_RECORDS`]; then tries 3-subsets until the envelope
//!   opens (two of my devices racing a re-share can leave mixed splits).
//! - **Re-share pacing** ([`ReshareLog`]): a gone holder or a shared owner
//!   re-shares at once, at most [`URGENT_PER_DAY`] times a day; routine
//!   reasons wait [`RESHARE_GAP_MS`]; after a recovery or a cancel it's
//!   always at once.
//! - **Resends** ([`Outbox`]): each sighting of `pending(h)` re-signs a
//!   fresh cancel; a delete is re-signed and resent each round until every
//!   holder it's for has it (the 10-minute window drops it at a holder that
//!   was offline).

use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use x25519_dalek::StaticSecret;

use crate::devicelink::Payload;
use crate::recovery::{
    combine, open_envelope, open_release, recovery_key, Order, Reshare, ShareRecord, CANCEL_WINDOW_MS, MAX_HOLDERS,
    RESHARE_GAP_MS, THRESHOLD,
};

const DAY_MS: u64 = 24 * 60 * 60_000;
/// Records a recovering device keeps for its handle (Tech Lead on #431).
pub const MAX_RECORDS: usize = MAX_HOLDERS;
/// Immediate (gone, shared-owner) re-shares a day; then the routine gap.
pub const URGENT_PER_DAY: usize = 3;

// ------------------------------------------------- the recovering device

/// What [`Collector::add`] did with a released record.
#[derive(Debug, PartialEq, Eq)]
pub enum Collected {
    Kept,
    /// Not sealed to my key, not for my handle, or not signed by the key the
    /// handle is bound to.
    Refused,
    /// The same record again.
    Duplicate,
    /// Not the envelope's version.
    OtherVersion,
    /// [`MAX_RECORDS`] kept already.
    Full,
}

/// A new device's share collection for one handle and one envelope
/// version. The one-time device key is wiped when it's dropped.
pub struct Collector {
    h: [u8; 32],
    version: u64,
    device: StaticSecret,
    records: Vec<ShareRecord>,
}

impl Collector {
    /// `h` from the mailer's token, `version` from the envelope fetched at
    /// `envelope_tag(h)`, `device` the one-time key the token names.
    pub fn new(h: [u8; 32], version: u64, device: StaticSecret) -> Collector {
        Collector { h, version, device, records: Vec::new() }
    }

    /// A holder's release. Kept only if it opens with my key for my handle
    /// and verifies: `ShareRecord::verify` checks `h == handle(w_pub)`, so
    /// every kept record is bound to the same `w_r_pub`.
    pub fn add(&mut self, sealed: &[u8]) -> Collected {
        let Some(record) = open_release(&self.device, &self.h, sealed) else { return Collected::Refused };
        if !record.verify() {
            return Collected::Refused;
        }
        if record.version != self.version {
            return Collected::OtherVersion;
        }
        if self.records.iter().any(|r| r.x == record.x && *r.y == *record.y) {
            return Collected::Duplicate;
        }
        if self.records.len() >= MAX_RECORDS {
            return Collected::Full;
        }
        self.records.push(record);
        Collected::Kept
    }

    pub fn count(&self) -> usize {
        self.records.len()
    }

    /// Tries every 3-subset with distinct `x` (at most 10 for 5 records)
    /// until the envelope opens. `None` while too few or no subset fits.
    pub fn open(&self, r_m: &[u8; 32], envelope: &[u8]) -> Option<Payload> {
        let n = self.records.len();
        for a in 0..n {
            for b in a + 1..n {
                for c in b + 1..n {
                    let pick = [&self.records[a], &self.records[b], &self.records[c]];
                    if pick[0].x == pick[1].x || pick[0].x == pick[2].x || pick[1].x == pick[2].x {
                        continue;
                    }
                    let shares: Vec<_> = pick.iter().map(|r| r.share()).collect();
                    debug_assert_eq!(shares.len(), THRESHOLD);
                    let Some(s) = combine(&shares) else { continue };
                    let key = recovery_key(&s, r_m, &self.h);
                    if let Some(account) = open_envelope(&key, &self.h, self.version, envelope) {
                        return Some(account);
                    }
                }
            }
        }
        None
    }
}

// ----------------------------------------------------- re-share pacing

/// Why a re-share is wanted, for pacing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReshareCause {
    /// From [`crate::recovery::reshare_reason`].
    Reason(Reshare),
    /// Right after a recovery or a cancel: the released shares and `r_m`
    /// are known to more parties now.
    AfterRelease,
}

/// When my devices re-shared, kept per account (one day of history).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReshareLog {
    pub at: Vec<u64>,
}

impl ReshareLog {
    /// Whether to re-share now:
    /// - after a release or a cancel, always;
    /// - gone or shared owner: at once, up to [`URGENT_PER_DAY`] in the last
    ///   day, then like a routine one;
    /// - routine (stale, grow): only [`RESHARE_GAP_MS`] after the last one.
    pub fn allows(&self, cause: ReshareCause, now: u64) -> bool {
        let last = self.at.iter().max().copied();
        let gap_ok = last.is_none_or(|last| now.saturating_sub(last) >= RESHARE_GAP_MS);
        match cause {
            ReshareCause::AfterRelease => true,
            ReshareCause::Reason(Reshare::Gone | Reshare::SharedOwner) => {
                self.at.iter().filter(|t| now.saturating_sub(**t) < DAY_MS).count() < URGENT_PER_DAY || gap_ok
            }
            ReshareCause::Reason(Reshare::Stale | Reshare::Grow) => gap_ok,
        }
    }

    /// A re-share went out at `now`; history older than a day goes.
    pub fn record(&mut self, now: u64) {
        self.at.retain(|t| now.saturating_sub(*t) < DAY_MS);
        self.at.push(now);
    }

    /// The last re-share, for [`crate::recovery::reshare_reason`].
    pub fn last(&self) -> u64 {
        self.at.iter().max().copied().unwrap_or(0)
    }
}

// --------------------------------------------------------------- resends

/// A delete still owed to some holders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwedDelete {
    pub below_version: u64,
    /// Holders (member keys) that haven't confirmed it yet.
    pub holders: Vec<[u8; 32]>,
}

/// The orders my devices keep sending. Persisted per account.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outbox {
    /// The signed `at` of the last order made: each new one is later, so a
    /// holder's "later than the last taken" rule always lets it through.
    pub last_at: u64,
    pub deletes: Vec<OwedDelete>,
}

impl Outbox {
    /// Strictly later than the last one, unless the last is far ahead of
    /// `now` (one bad clock reading): then from `now` again. Otherwise every
    /// later order would be over a holder's window and refused, and the
    /// account would silently lose its cancel (Security Lead on #506).
    fn next_at(&mut self, now: u64) -> u64 {
        self.last_at = if self.last_at > now.saturating_add(CANCEL_WINDOW_MS / 2) {
            now
        } else {
            now.max(self.last_at + 1)
        };
        self.last_at
    }

    /// `pending(h)` seen (each sighting): a freshly signed cancel to send to
    /// every holder and the mailer.
    pub fn cancel(&mut self, w_r: &SigningKey, h: [u8; 32], now: u64) -> (Order, [u8; 64]) {
        let order = Order::Cancel { h, at: self.next_at(now) };
        let sig = order.sign(w_r);
        (order, sig)
    }

    /// After a re-share or a disable: owe a delete below `below_version` to
    /// `holders`. A newer delete replaces older ones for the same holders.
    pub fn owe_delete(&mut self, below_version: u64, holders: &[[u8; 32]]) {
        for owed in &mut self.deletes {
            owed.holders.retain(|m| !holders.contains(m));
        }
        self.deletes.retain(|d| !d.holders.is_empty());
        if !holders.is_empty() {
            self.deletes.push(OwedDelete { below_version, holders: holders.to_vec() });
        }
    }

    /// Each round: the deletes still owed, freshly signed, with who gets
    /// each one.
    pub fn deletes_due(&mut self, w_r: &SigningKey, h: [u8; 32], now: u64) -> Vec<(Order, [u8; 64], Vec<[u8; 32]>)> {
        let owed = self.deletes.clone();
        owed.into_iter()
            .map(|d| {
                let order = Order::Delete { h, below_version: d.below_version, at: self.next_at(now) };
                let sig = order.sign(w_r);
                (order, sig, d.holders)
            })
            .collect()
    }

    /// `holder` confirmed a delete at or above `below_version`.
    pub fn delete_confirmed(&mut self, holder: &[u8; 32], below_version: u64) {
        for owed in &mut self.deletes {
            if owed.below_version <= below_version {
                owed.holders.retain(|m| m != holder);
            }
        }
        self.deletes.retain(|d| !d.holders.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devicelink::PayloadProfile;
    use crate::recovery::{handle, random32, seal_envelope, seal_release, split, Hold, Share};
    use x25519_dalek::PublicKey as X25519Public;
    use zeroize::Zeroizing;

    const NOW: u64 = 1_000 * DAY_MS;

    fn w() -> SigningKey {
        SigningKey::from_bytes(&[9; 32])
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

    struct World {
        h: [u8; 32],
        r_m: Zeroizing<[u8; 32]>,
        envelope: Vec<u8>,
        records: Vec<ShareRecord>,
        device_pub: [u8; 32],
    }

    fn signed(version: u64, shares: &[Share]) -> Vec<ShareRecord> {
        shares.iter().map(|sh| ShareRecord::sign(&w(), version, sh, NOW)).collect()
    }

    fn world(version: u64) -> (World, StaticSecret) {
        let (s, r_m) = (random32(), random32());
        let h = handle(&w().verifying_key().to_bytes());
        let envelope = seal_envelope(&recovery_key(&s, &r_m, &h), &h, version, &account());
        let records = signed(version, &split(&s, 3, 5).unwrap());
        let device = StaticSecret::from([77; 32]);
        let device_pub = X25519Public::from(&device).to_bytes();
        (World { h, r_m, envelope, records, device_pub }, device)
    }

    fn release(wd: &World, r: &ShareRecord) -> Vec<u8> {
        seal_release(r, &wd.device_pub).unwrap()
    }

    #[test]
    fn three_released_shares_open_the_envelope_and_two_do_not() {
        let (wd, device) = world(4);
        let mut c = Collector::new(wd.h, 4, device);
        for r in &wd.records[1..3] {
            assert_eq!(c.add(&release(&wd, r)), Collected::Kept);
        }
        assert!(c.open(&wd.r_m, &wd.envelope).is_none(), "2 shares");
        assert_eq!(c.add(&release(&wd, &wd.records[1])), Collected::Duplicate);
        assert_eq!(c.add(&release(&wd, &wd.records[4])), Collected::Kept);
        let opened = c.open(&wd.r_m, &wd.envelope).unwrap();
        assert_eq!(opened.seed.as_str(), account().seed.as_str());
        assert!(c.open(&random32(), &wd.envelope).is_none(), "no r_m");
    }

    #[test]
    fn records_bound_to_another_key_or_version_are_refused() {
        let (wd, device) = world(4);
        let mut c = Collector::new(wd.h, 4, device);
        assert_eq!(c.add(&seal_release(&wd.records[0], &[3; 32]).unwrap()), Collected::Refused, "sealed elsewhere");
        // Another account's valid record: its own handle, so not mine.
        let thief = SigningKey::from_bytes(&[8; 32]);
        let theirs = ShareRecord::sign(&thief, 4, &wd.records[0].share(), NOW);
        assert_eq!(c.add(&release(&wd, &theirs)), Collected::Refused);
        // Mine, but with a changed y.
        let mut forged = wd.records[0].clone();
        forged.y[0] ^= 1;
        assert_eq!(c.add(&release(&wd, &forged)), Collected::Refused);
        // An old split's record.
        let old = ShareRecord::sign(&w(), 3, &wd.records[0].share(), NOW);
        assert_eq!(c.add(&release(&wd, &old)), Collected::OtherVersion);
        assert_eq!(c.count(), 0);
    }

    #[test]
    fn mixed_splits_of_one_version_still_open_by_trying_subsets() {
        // Two of my devices raced a re-share at version 4: two splits; the
        // envelope is from the first.
        let (wd, device) = world(4);
        let stray = signed(4, &split(&random32(), 3, 5).unwrap());
        let mut c = Collector::new(wd.h, 4, device);
        for r in [&stray[0], &wd.records[1], &stray[2], &wd.records[3], &wd.records[4]] {
            assert_eq!(c.add(&release(&wd, r)), Collected::Kept);
        }
        assert_eq!(c.add(&release(&wd, &wd.records[2])), Collected::Full, "at most 5");
        assert!(c.open(&wd.r_m, &wd.envelope).is_some());
    }

    #[test]
    fn a_repeated_x_is_never_one_subset() {
        let (wd, device) = world(4);
        let mut c = Collector::new(wd.h, 4, device);
        let twin = ShareRecord::sign(&w(), 4, &Share { x: wd.records[0].x, y: random32() }, NOW);
        for r in [&wd.records[0], &twin, &wd.records[1]] {
            assert_eq!(c.add(&release(&wd, r)), Collected::Kept);
        }
        assert!(c.open(&wd.r_m, &wd.envelope).is_none());
        c.add(&release(&wd, &wd.records[2]));
        assert!(c.open(&wd.r_m, &wd.envelope).is_some());
    }

    #[test]
    fn urgent_reshares_are_capped_and_routine_ones_wait_a_day() {
        let gone = ReshareCause::Reason(Reshare::Gone);
        let shared = ReshareCause::Reason(Reshare::SharedOwner);
        let stale = ReshareCause::Reason(Reshare::Stale);
        let mut log = ReshareLog::default();
        assert!(log.allows(stale, NOW), "never re-shared");
        for i in 0..URGENT_PER_DAY as u64 {
            assert!(log.allows(if i % 2 == 0 { gone } else { shared }, NOW + i));
            log.record(NOW + i);
        }
        assert!(!log.allows(gone, NOW + 10), "a 4th urgent one the same day");
        assert!(!log.allows(stale, NOW + 10));
        assert!(log.allows(ReshareCause::AfterRelease, NOW + 10), "after a recovery or cancel: always");
        let next_day = NOW + 2 + RESHARE_GAP_MS;
        assert!(log.allows(gone, next_day));
        assert!(log.allows(stale, next_day));
        log.record(next_day);
        assert_eq!(log.at, vec![next_day], "a day of history");
        assert_eq!(log.last(), next_day);
    }

    #[test]
    fn each_sighting_gets_a_fresh_later_cancel_that_holders_take() {
        let mut out = Outbox::default();
        let record = ShareRecord::sign(&w(), 1, &split(&[3; 32], 3, 3).unwrap()[0], NOW);
        let (a, sig_a) = out.cancel(&w(), record.h, NOW);
        let (b, sig_b) = out.cancel(&w(), record.h, NOW); // the same clock reading
        assert!(a.verify(&sig_a, &record) && b.verify(&sig_b, &record));
        let (Order::Cancel { at: at_a, .. }, Order::Cancel { at: at_b, .. }) = (a, b) else { panic!("cancels") };
        assert!(at_b > at_a, "always later than the last");
        let mut hold = Hold::default();
        hold.on_pending([7; 32], NOW);
        assert!(hold.on_cancel(at_a, NOW));
        assert!(hold.on_cancel(at_b, NOW), "the resend counts too");
    }

    /// One bad clock reading far ahead must not poison every later order:
    /// past half the window ahead, the next `at` starts from `now` again, and
    /// a holder on a right clock takes it.
    #[test]
    fn a_far_future_last_at_is_dropped() {
        let record = ShareRecord::sign(&w(), 1, &split(&[3; 32], 3, 3).unwrap()[0], NOW);
        let mut out = Outbox::default();
        let (bad, _) = out.cancel(&w(), record.h, NOW + 365 * DAY_MS);
        assert!(matches!(bad, Order::Cancel { at, .. } if at == NOW + 365 * DAY_MS));
        let (next, sig) = out.cancel(&w(), record.h, NOW);
        assert!(matches!(next, Order::Cancel { at, .. } if at == NOW), "{next:?}");
        let mut hold = Hold::default();
        hold.on_pending([7; 32], NOW);
        assert!(next.verify(&sig, &record));
        let Order::Cancel { at, .. } = next else { panic!("a cancel") };
        assert!(hold.on_cancel(at, NOW), "a holder takes it");
        // Deletes too.
        out.owe_delete(2, &[[1; 32]]);
        out.next_at(NOW + 365 * DAY_MS);
        let due = out.deletes_due(&w(), record.h, NOW);
        assert!(matches!(due[0].0, Order::Delete { at, .. } if at == NOW));

        // A little ahead (within half the window) still counts: strictly later.
        let mut out = Outbox::default();
        out.cancel(&w(), record.h, NOW + CANCEL_WINDOW_MS / 2);
        let (later, _) = out.cancel(&w(), record.h, NOW);
        assert!(matches!(later, Order::Cancel { at, .. } if at == NOW + CANCEL_WINDOW_MS / 2 + 1));
    }

    fn below(o: &Order) -> u64 {
        match o {
            Order::Delete { below_version, .. } => *below_version,
            Order::Cancel { .. } => panic!("a delete"),
        }
    }

    #[test]
    fn deletes_are_resent_until_every_holder_confirms() {
        let mut out = Outbox::default();
        let h = [1; 32];
        let (p, q, r) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        out.owe_delete(2, &[p, q, r]);
        let first = out.deletes_due(&w(), h, NOW);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].2, [p, q, r]);
        out.delete_confirmed(&p, 2);
        let second = out.deletes_due(&w(), h, NOW + 60_000);
        assert_eq!(second[0].2, [q, r]);
        let (Order::Delete { at: a1, .. }, Order::Delete { at: a2, .. }) = (first[0].0, second[0].0) else {
            panic!("deletes")
        };
        assert!(a2 > a1, "re-signed fresh each round");

        // A newer delete replaces the older one for the same holders.
        out.owe_delete(3, &[q]);
        let due: Vec<(u64, Vec<[u8; 32]>)> =
            out.deletes_due(&w(), h, NOW + 120_000).into_iter().map(|d| (below(&d.0), d.2)).collect();
        assert_eq!(due, [(2, vec![r]), (3, vec![q])]);
        // Confirming a newer delete covers an older one too.
        out.delete_confirmed(&r, 5);
        out.delete_confirmed(&q, 3);
        assert!(out.deletes.is_empty());
        assert!(out.deletes_due(&w(), h, NOW).is_empty());
    }
}
