//! The holder notice slot (`notice-slot-spec.md`, agreed with both leads):
//! small account notices ("a new device was added", member recovery's
//! pending/cancel/delete) that my other devices fetch.
//!
//! ```text
//! "mvsn1" ‖ tag_n[32] ‖ w_n_pub[32] ‖ at u64le ‖ nonce[24] ‖ sealed body[NOTICE_BODY] ‖ sig[64]
//! ```
//!
//! The body is sealed by the core and opaque here; every notice is exactly
//! [`NOTICE_LEN`] bytes (the core pads the plaintext to 1 KiB).
//!
//! `/mvs/notice/1`, its own protocol ID (Tech Lead: older holders then fail
//! fast at negotiation instead of refusing an unknown opcode):
//! - `0x01 ‖ notice`: keep it. Gated like backup writes (phase A: my own
//!   other devices), [`check`]ed, at most [`WRITES_PER_TAG`] an hour. The
//!   answer is one byte: 1 kept, 0 not, whatever the reason.
//! - `0x02 ‖ tag_n ‖ w_n_pub ‖ minute u64le ‖ sig`: a fetch signed by `w_n`
//!   over [`fetch_message`], bound to the holder's peer ID and the minute
//!   (±[`FETCH_SKEW_MINUTES`]). The answer is the held notices, newest
//!   first, each `u16le length ‖ notice`; anything else, "none" included,
//!   gets the same empty answer (R3).
//!
//! A holder keeps per tag the [`MAX_PER_TAG`] newest by (`at`, sha256),
//! duplicates removed by hash, each for [`RETENTION`] after it was
//! *received* (the holder's clock, never `at`).

use std::io;
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, VerifyingKey};
use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::{request_response, PeerId, StreamProtocol};

use crate::limits::RateLimiter;

pub(crate) const NOTICE_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/notice/1");

const MAGIC: &[u8; 5] = b"mvsn1";
/// The tag's context: `tag_n = derive_key(TAG_CONTEXT, w_n_pub)`.
pub const NOTICE_TAG_CONTEXT: &str = "mvs/notice-tag/v1";
/// What a fetch signature starts with.
pub const FETCH_CONTEXT: &[u8] = b"mvs/notice-fetch/v1";
const HEADER: usize = 5 + 32 + 32 + 8 + 24;
const SIG: usize = 64;
/// The sealed body: 1 KiB of padded plaintext plus a 16-byte AEAD tag.
pub const NOTICE_BODY: usize = 1024 + 16;
/// Every notice is exactly this long.
pub const NOTICE_LEN: usize = HEADER + NOTICE_BODY + SIG;
const PUT: u8 = 0x01;
const GET: u8 = 0x02;
const FETCH_LEN: usize = 32 + 32 + 8 + SIG;
/// Requests, at most (a put is the largest).
const MAX_REQUEST: usize = 1 + NOTICE_LEN;

/// Notices held per tag (Tech Lead, Q4).
pub const MAX_PER_TAG: usize = 16;
/// The largest fetch answer.
const MAX_ANSWER: usize = MAX_PER_TAG * (2 + NOTICE_LEN);
/// How long a holder keeps a notice after receiving it.
pub const RETENTION: Duration = Duration::from_secs(30 * 24 * 3600);
/// How far ahead of the holder's clock `at` may be.
pub const MAX_AHEAD: u64 = 24 * 3600;
/// A fetch's minute may be this far from the holder's.
pub const FETCH_SKEW_MINUTES: u64 = 2;
/// Distinct tags one holder keeps notices for (phase A: one, mine; the
/// bound is for the relay mailbox and phase B).
pub const MAX_TAGS: usize = 64;

/// Writes accepted per tag per hour (Security Lead: someone with the seed
/// can't flood out "device added" before my next 5-minute fetch), per peer,
/// and fetches answered per peer and in all.
pub(crate) const WRITES_PER_TAG: u32 = 4;
pub(crate) const WRITES_PER_PEER: u32 = 12;
pub(crate) const FETCHES_PER_PEER: u32 = 60;
pub(crate) const FETCHES_ALL: u32 = 600;
const MAX_TRACKED: usize = 1024;

/// Signs fetches with `w_n` (the core's, present while unlocked; sync never
/// holds the key). Implementations sign only [`fetch_message`]s.
pub trait NoticeSigner: Send + Sync + 'static {
    /// `w_n_pub`, None while locked (then no fetch is sent).
    fn key(&self) -> Option<[u8; 32]>;
    /// A signature over `message`, which always starts with [`FETCH_CONTEXT`];
    /// None while locked or for anything else.
    fn sign_fetch(&self, message: &[u8]) -> Option<[u8; 64]>;
}

/// A plain key as a signer (tests).
impl NoticeSigner for ed25519_dalek::SigningKey {
    fn key(&self) -> Option<[u8; 32]> {
        Some(self.verifying_key().to_bytes())
    }

    fn sign_fetch(&self, message: &[u8]) -> Option<[u8; 64]> {
        use ed25519_dalek::Signer;
        message.starts_with(FETCH_CONTEXT).then(|| self.sign(message).to_bytes())
    }
}

/// The tag notices for `w_n_pub` are kept under.
pub fn tag_of(w_n_pub: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(NOTICE_TAG_CONTEXT, w_n_pub)
}

/// The bytes a fetch signature covers.
pub fn fetch_message(tag: &[u8; 32], holder: &PeerId, minute: u64) -> Vec<u8> {
    let holder = holder.to_bytes();
    let mut message = FETCH_CONTEXT.to_vec();
    message.extend_from_slice(tag);
    message.extend_from_slice(&holder);
    message.extend_from_slice(&minute.to_le_bytes());
    message
}

/// What a holder checks before keeping a notice: the exact size, the
/// header, the tag is the key's, a strict Ed25519 signature by that key
/// over everything before it, and `at` at most a day ahead of `now`. The
/// tag and `at` on success.
pub fn check(blob: &[u8], now: u64) -> Option<([u8; 32], u64)> {
    if blob.len() != NOTICE_LEN || &blob[..5] != MAGIC {
        return None;
    }
    let tag: [u8; 32] = blob[5..37].try_into().ok()?;
    let w_pub: [u8; 32] = blob[37..69].try_into().ok()?;
    let at = u64::from_le_bytes(blob[69..77].try_into().ok()?);
    if tag_of(&w_pub) != tag || at > now.saturating_add(MAX_AHEAD) {
        return None;
    }
    let (signed, sig) = blob.split_at(blob.len() - SIG);
    let key = VerifyingKey::from_bytes(&w_pub).ok()?;
    key.verify_strict(signed, &Signature::from_bytes(sig.try_into().ok()?)).ok()?;
    Some((tag, at))
}

/// A signed fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Fetch {
    pub tag: [u8; 32],
    pub key: [u8; 32],
    pub minute: u64,
    pub sig: [u8; 64],
}

impl Fetch {
    /// Signed by `signer` for `holder`; None while locked.
    pub(crate) fn sign(signer: &dyn NoticeSigner, holder: &PeerId, minute: u64) -> Option<Fetch> {
        let key = signer.key()?;
        let tag = tag_of(&key);
        let sig = signer.sign_fetch(&fetch_message(&tag, holder, minute))?;
        Some(Fetch { tag, key, minute, sig })
    }

    /// The tag to answer from, if this fetch is for `me`, within the minute
    /// skew of `now_minute`, and signed by the tag's key.
    pub(crate) fn verify(&self, me: &PeerId, now_minute: u64) -> Option<[u8; 32]> {
        if tag_of(&self.key) != self.tag || self.minute.abs_diff(now_minute) > FETCH_SKEW_MINUTES {
            return None;
        }
        let key = VerifyingKey::from_bytes(&self.key).ok()?;
        let message = fetch_message(&self.tag, me, self.minute);
        key.verify_strict(&message, &Signature::from_bytes(&self.sig)).ok()?;
        Some(self.tag)
    }
}

/// One `/mvs/notice/1` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Request {
    Put(Vec<u8>),
    Get(Fetch),
}

/// Held notices as one answer, newest first.
pub(crate) fn encode_answer(notices: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for notice in notices.iter().take(MAX_PER_TAG) {
        out.extend_from_slice(&(notice.len() as u16).to_le_bytes());
        out.extend_from_slice(notice);
    }
    out
}

/// An answer's notices; a malformed tail is dropped (untrusted anyway).
pub(crate) fn decode_answer(mut bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while bytes.len() >= 2 && out.len() < MAX_PER_TAG {
        let len = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
        let Some(notice) = bytes.get(2..2 + len) else { break };
        out.push(notice.to_vec());
        bytes = &bytes[2 + len..];
    }
    out
}

#[derive(Clone, Default)]
pub(crate) struct NoticeCodec;

pub(crate) type NoticeBehaviour = request_response::Behaviour<NoticeCodec>;

pub(crate) fn behaviour() -> NoticeBehaviour {
    request_response::Behaviour::new(
        [(NOTICE_PROTOCOL, request_response::ProtocolSupport::Full)],
        request_response::Config::default().with_request_timeout(Duration::from_secs(20)),
    )
}

async fn read_capped<T: AsyncRead + Unpin + Send>(io: &mut T, max: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    io.take(max as u64 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > max {
        return Err(invalid("notice message too large"));
    }
    Ok(bytes)
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_owned())
}

#[async_trait::async_trait]
impl request_response::Codec for NoticeCodec {
    type Protocol = StreamProtocol;
    type Request = Request;
    /// Put: one byte (1 kept, 0 not). Get: the notices, or empty.
    type Response = Vec<u8>;

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Request>
    where
        T: AsyncRead + Unpin + Send,
    {
        let bytes = read_capped(io, MAX_REQUEST).await?;
        match bytes.split_first() {
            Some((&PUT, blob)) if blob.len() == NOTICE_LEN => Ok(Request::Put(blob.to_vec())),
            Some((&GET, body)) if body.len() == FETCH_LEN => Ok(Request::Get(Fetch {
                tag: body[..32].try_into().expect("32"),
                key: body[32..64].try_into().expect("32"),
                minute: u64::from_le_bytes(body[64..72].try_into().expect("8")),
                sig: body[72..].try_into().expect("64"),
            })),
            _ => Err(invalid("unknown notice request")),
        }
    }

    async fn read_response<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Vec<u8>>
    where
        T: AsyncRead + Unpin + Send,
    {
        read_capped(io, MAX_ANSWER).await
    }

    async fn write_request<T>(&mut self, _: &StreamProtocol, io: &mut T, request: Request) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        match request {
            Request::Put(blob) if blob.len() == NOTICE_LEN => {
                io.write_all(&[PUT]).await?;
                io.write_all(&blob).await
            }
            Request::Put(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "notice size")),
            Request::Get(fetch) => {
                let mut out = vec![GET];
                out.extend_from_slice(&fetch.tag);
                out.extend_from_slice(&fetch.key);
                out.extend_from_slice(&fetch.minute.to_le_bytes());
                out.extend_from_slice(&fetch.sig);
                io.write_all(&out).await
            }
        }
    }

    async fn write_response<T>(&mut self, _: &StreamProtocol, io: &mut T, answer: Vec<u8>) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        if answer.len() > MAX_ANSWER {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "notice answer too large"));
        }
        io.write_all(&answer).await
    }
}

/// Write and fetch caps, per hour.
pub(crate) struct NoticeLimits {
    writes_tag: RateLimiter<[u8; 32]>,
    writes_peer: RateLimiter<PeerId>,
    fetches_peer: RateLimiter<PeerId>,
    fetches_all: RateLimiter<()>,
}

impl NoticeLimits {
    pub(crate) fn new() -> Self {
        NoticeLimits {
            writes_tag: RateLimiter::per_hour(WRITES_PER_TAG, WRITES_PER_TAG, MAX_TRACKED),
            writes_peer: RateLimiter::per_hour(WRITES_PER_PEER, WRITES_PER_PEER, MAX_TRACKED),
            fetches_peer: RateLimiter::per_hour(FETCHES_PER_PEER, FETCHES_PER_PEER, MAX_TRACKED),
            fetches_all: RateLimiter::per_hour(FETCHES_ALL, FETCHES_ALL, 1),
        }
    }

    pub(crate) fn allow_write(&mut self, peer: PeerId, tag: [u8; 32], now: Instant) -> bool {
        self.writes_peer.allow(peer, now) && self.writes_tag.allow(tag, now)
    }

    pub(crate) fn allow_fetch(&mut self, peer: PeerId, now: Instant) -> bool {
        self.fetches_peer.allow(peer, now) && self.fetches_all.allow((), now)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use libp2p::request_response::Codec as _;

    /// A notice as the core makes it (the body is opaque here).
    pub(crate) fn notice(seed: u8, at: u64, fill: u8) -> Vec<u8> {
        let w = SigningKey::from_bytes(&[seed; 32]);
        let w_pub = w.verifying_key().to_bytes();
        let mut out = MAGIC.to_vec();
        out.extend_from_slice(&tag_of(&w_pub));
        out.extend_from_slice(&w_pub);
        out.extend_from_slice(&at.to_le_bytes());
        out.extend_from_slice(&[7; 24]);
        out.extend(std::iter::repeat_n(fill, NOTICE_BODY));
        let sig = w.sign(&out).to_bytes();
        out.extend_from_slice(&sig);
        out
    }

    #[test]
    fn a_holder_refuses_a_bad_signature_tag_size_or_future_time() {
        let now = 1_000_000;
        let good = notice(1, now, 9);
        assert_eq!(good.len(), NOTICE_LEN, "every notice is the same size");
        let (tag, at) = check(&good, now).unwrap();
        assert_eq!((tag, at), (tag_of(&good[37..69].try_into().unwrap()), now));
        for i in [0, 5, 40, 70, HEADER + 1, good.len() - 1] {
            let mut bad = good.clone();
            bad[i] ^= 1;
            assert!(check(&bad, now).is_none(), "byte {i}");
        }
        // A tag that isn't the key's, even signed.
        let w = SigningKey::from_bytes(&[2; 32]);
        let mut wrong = good[..good.len() - SIG].to_vec();
        wrong[5..37].copy_from_slice(&[0; 32]);
        wrong[37..69].copy_from_slice(&w.verifying_key().to_bytes());
        let sig = w.sign(&wrong).to_bytes();
        wrong.extend_from_slice(&sig);
        assert!(check(&wrong, now).is_none());
        // Wrong sizes.
        assert!(check(&good[..NOTICE_LEN - 1], now).is_none());
        assert!(check(&[good.clone(), vec![0]].concat(), now).is_none());
        // `at` more than a day ahead; a day ahead is fine.
        assert!(check(&notice(1, now + MAX_AHEAD + 1, 9), now).is_none());
        assert!(check(&notice(1, now + MAX_AHEAD, 9), now).is_some());
    }

    #[test]
    fn a_fetch_is_signed_for_one_holder_and_minute() {
        let w = SigningKey::from_bytes(&[3; 32]);
        let (holder, other) = (PeerId::random(), PeerId::random());
        let fetch = Fetch::sign(&w, &holder, 100).unwrap();
        assert_eq!(fetch.verify(&holder, 100), Some(tag_of(&w.verifying_key().to_bytes())));
        assert!(fetch.verify(&holder, 102).is_some(), "within the skew");
        assert!(fetch.verify(&holder, 103).is_none(), "a stale minute");
        assert!(fetch.verify(&other, 100).is_none(), "addressed to another holder");
        let mut bad = fetch.clone();
        bad.sig[0] ^= 1;
        assert!(bad.verify(&holder, 100).is_none(), "a wrong signature");
        let mut wrong_tag = fetch.clone();
        wrong_tag.tag[0] ^= 1;
        assert!(wrong_tag.verify(&holder, 100).is_none(), "a tag not the key's");
        // The test signer signs only fetch messages.
        assert!(w.sign_fetch(b"mvs/peer-binding/v1").is_none());
    }

    #[test]
    fn requests_and_answers_round_trip_and_are_capped() {
        futures::executor::block_on(async {
            let mut codec = NoticeCodec;
            let w = SigningKey::from_bytes(&[3; 32]);
            let fetch = Fetch::sign(&w, &PeerId::random(), 5).unwrap();
            for request in [Request::Put(notice(1, 1, 0)), Request::Get(fetch)] {
                let mut wire = futures::io::Cursor::new(Vec::new());
                codec.write_request(&NOTICE_PROTOCOL, &mut wire, request.clone()).await.unwrap();
                let got =
                    codec.read_request(&NOTICE_PROTOCOL, &mut futures::io::Cursor::new(wire.into_inner())).await;
                assert_eq!(got.unwrap(), request);
            }
            for bad in [vec![], vec![3, 1], vec![GET; 32], vec![PUT; 100], vec![PUT; NOTICE_LEN + 2]] {
                let got = codec.read_request(&NOTICE_PROTOCOL, &mut futures::io::Cursor::new(bad.clone())).await;
                assert!(got.is_err(), "{} bytes", bad.len());
            }
            let big = vec![0; MAX_ANSWER + 1];
            assert!(codec.read_response(&NOTICE_PROTOCOL, &mut futures::io::Cursor::new(big)).await.is_err());
        });
        let held = vec![notice(1, 2, 0), notice(1, 1, 0)];
        assert_eq!(decode_answer(&encode_answer(&held)), held);
        assert!(decode_answer(&[]).is_empty());
    }

    #[test]
    fn a_holder_keeps_the_16_newest_without_duplicates_and_expires_by_receipt() {
        let mut store = crate::Store::in_memory().unwrap();
        let tag = tag_of(&SigningKey::from_bytes(&[1; 32]).verifying_key().to_bytes());
        for at in 0..20u64 {
            assert!(store.put_notice(&tag, at, &notice(1, at, 0), 1_000).unwrap());
        }
        // A duplicate is not kept twice; an older one than all 16 isn't kept.
        assert!(!store.put_notice(&tag, 19, &notice(1, 19, 0), 1_000).unwrap());
        assert!(!store.put_notice(&tag, 0, &notice(1, 0, 0), 1_000).unwrap());
        let held = store.notices(&tag).unwrap();
        assert_eq!(held.len(), MAX_PER_TAG);
        let ats: Vec<u64> = held.iter().map(|n| check(n, 100).unwrap().1).collect();
        assert_eq!(ats, (4..20).rev().collect::<Vec<_>>(), "newest first");
        // Expiry by receive time, never by `at`: a far-future `at` received
        // long ago goes, an old `at` received just now stays.
        let other = tag_of(&SigningKey::from_bytes(&[2; 32]).verifying_key().to_bytes());
        assert!(store.put_notice(&other, 5, &notice(2, 5, 0), 2_000_000_000).unwrap());
        store.expire_notices(1_000 + RETENTION.as_secs() + 1, RETENTION.as_secs()).unwrap();
        assert!(store.notices(&tag).unwrap().is_empty());
        assert_eq!(store.notices(&other).unwrap().len(), 1);
        assert_eq!(store.notice_tags().unwrap(), [other]);
    }

    #[test]
    fn the_fifth_write_in_an_hour_is_refused() {
        let mut limits = NoticeLimits::new();
        let now = Instant::now();
        let accepted = (0..6).filter(|_| limits.allow_write(PeerId::random(), [1; 32], now)).count();
        assert_eq!(accepted, WRITES_PER_TAG as usize);
        let peer = PeerId::random();
        assert_eq!((0..100).filter(|_| limits.allow_fetch(peer, now)).count(), FETCHES_PER_PEER as usize);
    }
}
