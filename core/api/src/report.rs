//! G-48, report to the owners: the signed report and its codec.
//!
//! Design `docs/design/report-to-owners.md`, with the Tech Lead's Amendment
//! 1, the security lead's R1–R7 and the Product Owner's decisions. A report
//! is signed by the reporter, sealed for each staff member separately
//! (`groupkeys::seal_box`) and delivered directly over `/mvs/report/1`, never
//! through a log.
//!
//! The signed bytes (integers little-endian), all of fixed size but the
//! evidence, which is padded to a bucket:
//!
//! ```text
//! v          u8         VERSION
//! server     [u8; 32]
//! reporter   [u8; 32]   the signer
//! kind       u8         1 = message, 2 = member
//! channel    [u8; 32]   a message's channel; zero for a member
//! target     [u8; 32]   the message's record ID, or the member's key
//! reason     u8         Reason
//! ts         u64        ms, the reporter's clock
//! nonce      [u8; 16]
//! text_len   u16        0..=MAX_TEXT_BYTES
//! text       UTF-8, then zeros up to PLAIN_LEN
//! ev_len     u32        0 for a member; 1..=MAX_RECORD_BYTES for a message
//! evidence   the message's signed record, then zeros up to its bucket
//! sig        [u8; 64]   Ed25519 over SIGNING_PREFIX ‖ everything above
//! ```

use ed25519_dalek::{Signature, Signer, VerifyingKey};
use records::{ChannelId, PublicKey, RecordId, ServerId, SigningKey, MAX_RECORD_BYTES};

pub const VERSION: u8 = 1;
const SIGNING_PREFIX: &[u8] = b"mvs/report/v1\0";
const ID_CONTEXT: &str = "mvs/report-id/v1";
/// The fixed part, before the text.
const HEAD_LEN: usize = 1 + 32 + 32 + 1 + 32 + 32 + 1 + 8 + 16 + 2;
/// The fixed part with the text and its padding.
pub const PLAIN_LEN: usize = 1200;
pub const MAX_TEXT_BYTES: usize = 1024;
pub const MAX_TEXT_CHARS: usize = 280;
/// Evidence is padded up to the first bucket it fits, so a box's size says
/// little about the message's length (the Tech Lead's Q2). The last bucket
/// is the largest record, a little over 18 KiB.
pub const BUCKETS: [usize; 4] = [0, 2 * 1024, 8 * 1024, MAX_RECORD_BYTES];
const SIG_LEN: usize = 64;
/// Largest signed report: a box adds `groupkeys::BOX_OVERHEAD` to it.
pub const MAX_SIGNED: usize = PLAIN_LEN + 4 + MAX_RECORD_BYTES + SIG_LEN;
/// A report is accepted up to this long after its `ts` (and dedup IDs are
/// kept a day longer).
pub const MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// ... and at most this far ahead of the receiver's clock.
pub const MAX_AHEAD_MS: u64 = 10 * 60 * 1000;

/// How a core delivers a box to one staff member: `true` once that member's
/// peer acked it (sync, `/mvs/report/1`). Blocking; never called under the
/// core's lock.
pub trait ReportNet: Send + Sync {
    fn deliver(&self, to: PublicKey, blob: Vec<u8>) -> bool;
}

/// Why a report was made. Any other code is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reason {
    Spam,
    Harassment,
    Hate,
    Violence,
    Sexual,
    /// Involves a minor: evidence behind a click, never for staff under 18,
    /// never exported (Product Owner).
    Minor,
    SelfHarm,
    Illegal,
    Impersonation,
    Other,
}

impl Reason {
    pub const ALL: [Reason; 10] = [
        Reason::Spam,
        Reason::Harassment,
        Reason::Hate,
        Reason::Violence,
        Reason::Sexual,
        Reason::Minor,
        Reason::SelfHarm,
        Reason::Illegal,
        Reason::Impersonation,
        Reason::Other,
    ];

    pub fn code(self) -> u8 {
        match self {
            Reason::Spam => 1,
            Reason::Harassment => 2,
            Reason::Hate => 3,
            Reason::Violence => 4,
            Reason::Sexual => 5,
            Reason::Minor => 6,
            Reason::SelfHarm => 7,
            Reason::Illegal => 8,
            Reason::Impersonation => 9,
            Reason::Other => 255,
        }
    }

    pub fn from_code(code: u8) -> Option<Reason> {
        Reason::ALL.into_iter().find(|r| r.code() == code)
    }

    /// The API's name.
    pub fn name(self) -> &'static str {
        match self {
            Reason::Spam => "spam",
            Reason::Harassment => "harassment",
            Reason::Hate => "hate",
            Reason::Violence => "violence",
            Reason::Sexual => "sexual",
            Reason::Minor => "minor",
            Reason::SelfHarm => "self-harm",
            Reason::Illegal => "illegal",
            Reason::Impersonation => "impersonation",
            Reason::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> Option<Reason> {
        Reason::ALL.into_iter().find(|r| r.name() == name)
    }

    /// Reasons 5 and 6: evidence only on an explicit click, never in a
    /// list, an event, a notification or a preview, and never to staff
    /// without an 18+ claim (R6, Product Owner).
    pub fn sensitive(self) -> bool {
        matches!(self, Reason::Sexual | Reason::Minor)
    }
}

/// What a report is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Message { channel: ChannelId, record: RecordId },
    Member(PublicKey),
}

/// A report, signed or opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub server: ServerId,
    pub reporter: PublicKey,
    pub target: Target,
    pub reason: Reason,
    pub ts: u64,
    pub nonce: [u8; 16],
    /// Empty when there is none.
    pub text: String,
    /// The reported message's signed record as the reporter held it; empty
    /// for a member. Checked by [`check_evidence`] on receipt.
    pub evidence: Vec<u8>,
}

/// The report's ID: staff de-duplicate on it.
pub fn report_id(reporter: &PublicKey, nonce: &[u8; 16]) -> [u8; 32] {
    blake3::derive_key(ID_CONTEXT, &[reporter.as_bytes().as_slice(), nonce].concat())
}

/// Whether `text` can be a report's note: empty, or trimmed (Unicode
/// White_Space), at most [`MAX_TEXT_CHARS`] code points and
/// [`MAX_TEXT_BYTES`] bytes, one line and the strict text rule. The same
/// rule as a channel topic, with a longer limit.
pub fn text_ok(text: &str) -> bool {
    text.is_empty()
        || (text.trim() == text
            && text.len() <= MAX_TEXT_BYTES
            && text.chars().count() <= MAX_TEXT_CHARS
            && !text.contains(['\u{2028}', '\u{2029}'])
            && authority::display_text_ok(text))
}

fn bucket(len: usize) -> Option<usize> {
    BUCKETS.into_iter().find(|b| len <= *b)
}

impl Report {
    pub fn id(&self) -> [u8; 32] {
        report_id(&self.reporter, &self.nonce)
    }

    /// The signed bytes. `None` if the text or the evidence don't fit, or
    /// evidence comes with a member report or is missing from a message
    /// report.
    pub fn sign(&self, key: &SigningKey) -> Option<Vec<u8>> {
        if !text_ok(&self.text) || PublicKey::from_bytes(key.verifying_key().to_bytes()) != self.reporter {
            return None;
        }
        let (kind, channel, target) = match self.target {
            Target::Message { channel, record } => (1u8, *channel.as_bytes(), *record.as_bytes()),
            Target::Member(member) => (2u8, [0; 32], *member.as_bytes()),
        };
        if (kind == 1) == self.evidence.is_empty() {
            return None;
        }
        let padded = bucket(self.evidence.len())?;
        let mut out = Vec::with_capacity(MAX_SIGNED);
        out.push(VERSION);
        out.extend_from_slice(self.server.as_bytes());
        out.extend_from_slice(self.reporter.as_bytes());
        out.push(kind);
        out.extend_from_slice(&channel);
        out.extend_from_slice(&target);
        out.push(self.reason.code());
        out.extend_from_slice(&self.ts.to_le_bytes());
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&(self.text.len() as u16).to_le_bytes());
        out.extend_from_slice(self.text.as_bytes());
        out.resize(PLAIN_LEN, 0);
        out.extend_from_slice(&(self.evidence.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.evidence);
        out.resize(PLAIN_LEN + 4 + padded, 0);
        let sig = key.sign(&[SIGNING_PREFIX, out.as_slice()].concat());
        out.extend_from_slice(&sig.to_bytes());
        Some(out)
    }

    /// Parses and verifies signed bytes. `None` for anything [`Self::sign`]
    /// wouldn't produce, or a bad signature.
    pub fn verify(bytes: &[u8]) -> Option<Report> {
        if bytes.len() < PLAIN_LEN + 4 + SIG_LEN || bytes.len() > MAX_SIGNED {
            return None;
        }
        let (signed, sig) = bytes.split_at(bytes.len() - SIG_LEN);
        let take32 = |at: usize| -> [u8; 32] { signed[at..at + 32].try_into().expect("32 bytes") };
        if signed[0] != VERSION {
            return None;
        }
        let server = ServerId::from_bytes(take32(1));
        let reporter = PublicKey::from_bytes(take32(33));
        let kind = signed[65];
        let channel = take32(66);
        let target = take32(98);
        let reason = Reason::from_code(signed[130])?;
        let ts = u64::from_le_bytes(signed[131..139].try_into().expect("8 bytes"));
        let nonce: [u8; 16] = signed[139..155].try_into().expect("16 bytes");
        let text_len = usize::from(u16::from_le_bytes([signed[155], signed[156]]));
        if text_len > MAX_TEXT_BYTES {
            return None;
        }
        let text = std::str::from_utf8(&signed[HEAD_LEN..HEAD_LEN + text_len]).ok()?.to_owned();
        if !text_ok(&text) || signed[HEAD_LEN + text_len..PLAIN_LEN].iter().any(|b| *b != 0) {
            return None;
        }
        let ev_len =
            u32::from_le_bytes(signed[PLAIN_LEN..PLAIN_LEN + 4].try_into().expect("4 bytes")) as usize;
        let padded = bucket(ev_len)?;
        if signed.len() != PLAIN_LEN + 4 + padded {
            return None;
        }
        let evidence = &signed[PLAIN_LEN + 4..PLAIN_LEN + 4 + ev_len];
        if signed[PLAIN_LEN + 4 + ev_len..].iter().any(|b| *b != 0) {
            return None;
        }
        let target = match kind {
            1 if ev_len > 0 => Target::Message {
                channel: ChannelId::from_bytes(channel),
                record: RecordId::from_bytes(target),
            },
            2 if ev_len == 0 && channel == [0; 32] => Target::Member(PublicKey::from_bytes(target)),
            _ => return None,
        };
        let key = VerifyingKey::from_bytes(reporter.as_bytes()).ok()?;
        let sig = Signature::from_bytes(sig.try_into().ok()?);
        key.verify_strict(&[SIGNING_PREFIX, signed].concat(), &sig).ok()?;
        Some(Report { server, reporter, target, reason, ts, nonce, text, evidence: evidence.to_vec() })
    }
}

/// R4: the evidence of a message report, if it is that very message: its
/// ID is `target`, it is a `Message` of the report's server and channel,
/// its author's signature checks, and it is within `MAX_RECORD_BYTES`
/// (`Record::decode` checks the last two). Returns the record. Never fed
/// into a log or a fold.
pub fn check_evidence(report: &Report) -> Option<records::Record> {
    let Target::Message { channel, record } = report.target else { return None };
    let decoded = records::Record::decode(&report.evidence).ok()?;
    (decoded.id() == record
        && decoded.server() == report.server
        && decoded.scope() == records::Scope::Channel(channel)
        && decoded.kind() == records::Kind::Message)
        .then_some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use records::{Draft, Kind, Scope};

    const SERVER: ServerId = ServerId::from_bytes([3; 32]);
    const CHANNEL: ChannelId = ChannelId::from_bytes([4; 32]);

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn public(key: &SigningKey) -> PublicKey {
        PublicKey::from_bytes(key.verifying_key().to_bytes())
    }

    fn message(author: &SigningKey, body_len: usize) -> records::Record {
        Draft {
            server: SERVER,
            scope: Scope::Channel(CHANNEL),
            seq: 1,
            deps: vec![],
            auth_deps: vec![RecordId::from_bytes([9; 32])],
            ts: 5,
            kind: Kind::Message,
            body: vec![1; body_len],
        }
        .sign(author)
        .unwrap()
    }

    fn about(target: Target, evidence: Vec<u8>) -> Report {
        Report {
            server: SERVER,
            reporter: public(&key(1)),
            target,
            reason: Reason::Harassment,
            ts: 1_000,
            nonce: [7; 16],
            text: "he keeps at it".into(),
            evidence,
        }
    }

    #[test]
    fn a_report_round_trips_and_its_evidence_checks() {
        let msg = message(&key(2), 40);
        let report = about(Target::Message { channel: CHANNEL, record: msg.id() }, msg.encode());
        let signed = report.sign(&key(1)).unwrap();
        assert_eq!(signed.len(), PLAIN_LEN + 4 + 2 * 1024 + 64, "the 2 KiB bucket");
        let opened = Report::verify(&signed).unwrap();
        assert_eq!(opened, report);
        assert_eq!(check_evidence(&opened).unwrap().author(), public(&key(2)));
        let member = about(Target::Member(public(&key(2))), vec![]);
        let signed = member.sign(&key(1)).unwrap();
        assert_eq!(signed.len(), PLAIN_LEN + 4 + 64);
        assert_eq!(Report::verify(&signed).unwrap(), member);
    }

    #[test]
    fn evidence_is_padded_to_buckets() {
        for (body, bucket) in [(10, 2048), (3000, 8192), (9000, MAX_RECORD_BYTES), (16 * 1024, MAX_RECORD_BYTES)] {
            let msg = message(&key(2), body);
            let report = about(Target::Message { channel: CHANNEL, record: msg.id() }, msg.encode());
            assert_eq!(report.sign(&key(1)).unwrap().len(), PLAIN_LEN + 4 + bucket + 64, "{body}");
        }
        assert!(MAX_SIGNED + groupkeys::BOX_OVERHEAD <= sync::MAX_REPORT_BLOB);
    }

    #[test]
    fn only_what_sign_makes_verifies() {
        let msg = message(&key(2), 40);
        let good = about(Target::Message { channel: CHANNEL, record: msg.id() }, msg.encode());
        let signed = good.sign(&key(1)).unwrap();
        // Any flipped byte: a bad signature, a bad field or bad padding.
        for i in (0..signed.len()).step_by(7) {
            let mut bad = signed.clone();
            bad[i] ^= 1;
            assert!(Report::verify(&bad).is_none(), "byte {i}");
        }
        assert!(Report::verify(&signed[..signed.len() - 1]).is_none());
        assert!(Report::verify(&[signed.clone(), vec![0]].concat()).is_none());
        // Signed by someone else than the named reporter: not even signed.
        assert!(good.sign(&key(3)).is_none());
        // A message report needs evidence; a member report takes none.
        assert!(about(Target::Message { channel: CHANNEL, record: msg.id() }, vec![]).sign(&key(1)).is_none());
        assert!(about(Target::Member(public(&key(2))), vec![1]).sign(&key(1)).is_none());
        // Text that fails the rule.
        for text in [" lead", "two\nlines", "a\u{2028}b", "a\u{202E}b", &"ש".repeat(281)] {
            let mut bad = about(Target::Member(public(&key(2))), vec![]);
            bad.text = text.to_owned();
            assert!(bad.sign(&key(1)).is_none(), "{text:?}");
        }
        assert!(text_ok("") && text_ok(&"ש".repeat(280)));
        assert_eq!(Reason::from_code(10), None);
        assert_eq!(Reason::from_code(255), Some(Reason::Other));
    }

    #[test]
    fn evidence_must_be_the_reported_message() {
        let msg = message(&key(2), 40);
        let other = message(&key(2), 41);
        let wrong = about(Target::Message { channel: CHANNEL, record: msg.id() }, other.encode());
        assert!(check_evidence(&Report::verify(&wrong.sign(&key(1)).unwrap()).unwrap()).is_none());
        let elsewhere = ChannelId::from_bytes([5; 32]);
        let moved = about(Target::Message { channel: elsewhere, record: msg.id() }, msg.encode());
        assert!(check_evidence(&moved).is_none(), "another channel");
        let mut forged = msg.encode();
        let last = forged.len() - 1;
        forged[last] ^= 1;
        let bad_sig = about(Target::Message { channel: CHANNEL, record: msg.id() }, forged);
        assert!(check_evidence(&bad_sig).is_none(), "the author's signature");
    }

    #[test]
    fn ids_and_names() {
        let a = about(Target::Member(public(&key(2))), vec![]);
        assert_eq!(a.id(), report_id(&a.reporter, &a.nonce));
        for reason in Reason::ALL {
            assert_eq!(Reason::from_name(reason.name()), Some(reason));
            assert_eq!(Reason::from_code(reason.code()), Some(reason));
        }
        assert!(Reason::Sexual.sensitive() && Reason::Minor.sensitive() && !Reason::Spam.sensitive());
    }
}
