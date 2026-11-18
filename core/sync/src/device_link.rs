//! "Approve on your other device" (device link), the network part: the
//! rendezvous and `/mvs/device-link/1`. The keys, the SAS, the transcript
//! and the sealed transfer are the core's (dev-identity); here the bytes are
//! public keys and ciphertext, never a secret.
//!
//! - **Rendezvous:** the new device announces itself as a DHT provider of
//!   [`rendezvous`]`(code)` for [`DEVICE_LINK_TTL`]; the signed-in device
//!   looks the providers up. The record names a peer, nothing more.
//! - **Circuit only:** a link peer is reached only through our relay's
//!   circuit, on both sides. The node's dial guard refuses any connection to
//!   a link peer that isn't relayed (a hole punch included), and while a
//!   link is open on the new device it makes no direct dials at all. So an
//!   approving device never shows its address to the new one.
//!
//! `/mvs/device-link/1`, request-response, at most [`MAX_DEVICE_LINK`]
//! bytes each way:
//! - `0x01 ‖ e_old_pub[32]` → `e_new_pub[32]` (Hello);
//! - `0x02 ‖ ciphertext` → `0x01` (Sealed, the transfer).
//!
//! With no open link (none, expired, or its transfer done) the answer is
//! `0x00`, which the signed-in device reports as not found. Anything else, a
//! peer other than the first Hello's, or past the request cap gets an empty
//! answer (refused). So for a link's life an asker can tell "no link open"
//! from "an open link held by another device", that is, that this peer is
//! mid-link (Security Lead on #406: acceptable). One session per link: the first
//! Hello locks it to that peer. A stranger who caught the code can only make
//! the link fail (the user starts again); the SAS covers a man in the middle.

use std::collections::HashMap;
use std::io;
use std::time::{Duration, Instant};

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::{request_response, PeerId, StreamProtocol};

pub(crate) const DEVICE_LINK_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/device-link/1");
/// The largest request or answer, kind byte included.
pub const MAX_DEVICE_LINK: usize = 8 * 1024;
/// How long a link (and its provider record) lives.
pub const DEVICE_LINK_TTL: Duration = Duration::from_secs(300);
/// How long a provider lookup for a code waits.
pub const DEVICE_LINK_FIND_WAIT: Duration = Duration::from_secs(10);
#[cfg(any(test, feature = "test-util"))]
const RV_CONTEXT: &str = "mvs/device-link-rv/v1";
const HELLO: u8 = 0x01;
const SEALED: u8 = 0x02;
/// The answer when no link is open (none, expired, or already used): the
/// caller gets [`LinkError::NotFound`]. An empty answer (held by another
/// device, or over the caps) is [`LinkError::Refused`].
pub(crate) const GONE: u8 = 0x00;

/// What an answer means to the signed-in device.
pub(crate) fn outcome(answer: Vec<u8>) -> Result<Vec<u8>, LinkError> {
    match answer.as_slice() {
        [] => Err(LinkError::Refused),
        [GONE] => Err(LinkError::NotFound),
        _ => Ok(answer),
    }
}
/// Requests one link answers, per peer and in all.
const PER_PEER: u8 = 10;
const ALL: usize = 32;
/// Different peers tracked per link (refused ones included).
const MAX_PEERS: usize = 16;

/// The rendezvous key for a short code: `blake3::derive_key(
/// "mvs/device-link-rv/v1", code)`. The core normalises the code (as
/// typed, upper case, no spaces or dashes) before calling.
/// Tests only: the core (`api::devicelink`) computes the same key from the
/// normalised code, and is the one the app uses.
#[cfg(any(test, feature = "test-util"))]
pub fn rendezvous(code: &str) -> [u8; 32] {
    blake3::derive_key(RV_CONTEXT, code.as_bytes())
}

/// What reached the new device on its link, in order. The network already
/// answered each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// The signed-in device's one-time key; answered with `e_new_pub`.
    Hello { e_old_pub: [u8; 32] },
    /// The sealed transfer from that same peer; answered "received".
    Sealed { ciphertext: Vec<u8> },
}

/// Why a request from the signed-in device failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkError {
    /// Nobody provides that code (no such link, or it expired).
    NotFound,
    /// No circuit, a timeout, or the node is gone.
    Network,
    /// The new device answered empty: link closed, locked to another peer,
    /// or over its cap.
    Refused,
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            LinkError::NotFound => "no such device link",
            LinkError::Network => "device link unreachable",
            LinkError::Refused => "device link refused",
        })
    }
}

impl std::error::Error for LinkError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Request {
    Hello([u8; 32]),
    Sealed(Vec<u8>),
}

/// The new device's one open link.
pub(crate) struct Host {
    pub(crate) rv: [u8; 32],
    e_new_pub: [u8; 32],
    until: Instant,
    locked: Option<PeerId>,
    asked: HashMap<PeerId, u8>,
    answered: usize,
    done: bool,
}

impl Host {
    pub(crate) fn new(rv: [u8; 32], e_new_pub: [u8; 32], now: Instant) -> Self {
        Host { rv, e_new_pub, until: now + DEVICE_LINK_TTL, locked: None, asked: HashMap::new(), answered: 0, done: false }
    }

    pub(crate) fn expired(&self, now: Instant) -> bool {
        now >= self.until
    }

    /// The peer the link is locked to, if any.
    #[cfg(test)]
    pub(crate) fn peer(&self) -> Option<PeerId> {
        self.locked
    }

    /// The answer to one request, and what to hand the core. A refusal is an
    /// empty answer and nothing for the core.
    pub(crate) fn answer(&mut self, peer: PeerId, request: Request, now: Instant) -> (Vec<u8>, Option<Inbound>) {
        // No open link any more (expired, or its one transfer done): a
        // distinct "gone" answer, so the signed-in device says "not found"
        // rather than "locked out" (QA, 0.4.6).
        if self.done || self.expired(now) {
            return (vec![GONE], None);
        }
        if self.answered >= ALL {
            return (Vec::new(), None);
        }
        if !self.asked.contains_key(&peer) && self.asked.len() >= MAX_PEERS {
            return (Vec::new(), None);
        }
        let count = self.asked.entry(peer).or_insert(0);
        if *count >= PER_PEER {
            return (Vec::new(), None);
        }
        *count += 1;
        self.answered += 1;
        if self.locked.is_some_and(|locked| locked != peer) {
            return (Vec::new(), None);
        }
        match request {
            Request::Hello(e_old_pub) => {
                let first = self.locked.is_none();
                self.locked = Some(peer);
                // A repeated Hello (a retry after a lost answer) gets the same
                // answer; the core hears only the first.
                (self.e_new_pub.to_vec(), first.then_some(Inbound::Hello { e_old_pub }))
            }
            Request::Sealed(_) if self.locked.is_none() => (Vec::new(), None),
            Request::Sealed(ciphertext) => {
                self.done = true;
                (vec![1], Some(Inbound::Sealed { ciphertext }))
            }
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct LinkCodec;

pub(crate) type LinkBehaviour = request_response::Behaviour<LinkCodec>;

pub(crate) fn behaviour() -> LinkBehaviour {
    request_response::Behaviour::new(
        [(DEVICE_LINK_PROTOCOL, request_response::ProtocolSupport::Full)],
        request_response::Config::default().with_request_timeout(Duration::from_secs(20)),
    )
}

async fn read_capped<T: AsyncRead + Unpin + Send>(io: &mut T) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    io.take(MAX_DEVICE_LINK as u64 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > MAX_DEVICE_LINK {
        return Err(invalid("device link message too large"));
    }
    Ok(bytes)
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_owned())
}

#[async_trait::async_trait]
impl request_response::Codec for LinkCodec {
    type Protocol = StreamProtocol;
    type Request = Request;
    type Response = Vec<u8>;

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Request>
    where
        T: AsyncRead + Unpin + Send,
    {
        let bytes = read_capped(io).await?;
        match bytes.split_first() {
            Some((&HELLO, key)) => key.try_into().map(Request::Hello).map_err(|_| invalid("a hello key is 32 bytes")),
            Some((&SEALED, body)) if !body.is_empty() => Ok(Request::Sealed(body.to_vec())),
            _ => Err(invalid("unknown device link request")),
        }
    }

    async fn read_response<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Vec<u8>>
    where
        T: AsyncRead + Unpin + Send,
    {
        read_capped(io).await
    }

    async fn write_request<T>(&mut self, _: &StreamProtocol, io: &mut T, request: Request) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        match request {
            Request::Hello(key) => {
                io.write_all(&[HELLO]).await?;
                io.write_all(&key).await
            }
            Request::Sealed(body) if !body.is_empty() && body.len() < MAX_DEVICE_LINK => {
                io.write_all(&[SEALED]).await?;
                io.write_all(&body).await
            }
            Request::Sealed(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "device link transfer size")),
        }
    }

    async fn write_response<T>(&mut self, _: &StreamProtocol, io: &mut T, answer: Vec<u8>) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        if answer.len() > MAX_DEVICE_LINK {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "device link answer too large"));
        }
        io.write_all(&answer).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::request_response::Codec as _;

    fn host() -> (Host, Instant) {
        let now = Instant::now();
        (Host::new(rendezvous("ABCDEFGHJK"), [7; 32], now), now)
    }

    #[test]
    fn the_rendezvous_is_derived_from_the_code() {
        assert_eq!(rendezvous("ABCDEFGHJK"), blake3::derive_key("mvs/device-link-rv/v1", b"ABCDEFGHJK"));
        assert_ne!(rendezvous("ABCDEFGHJK"), rendezvous("ABCDEFGHJM"));
    }

    #[test]
    fn the_first_hello_locks_the_link_and_others_are_refused() {
        let (mut host, now) = host();
        let (a, b) = (PeerId::random(), PeerId::random());
        assert_eq!(host.answer(a, Request::Hello([1; 32]), now), (vec![7; 32], Some(Inbound::Hello { e_old_pub: [1; 32] })));
        // A retry from the same peer: the same answer, nothing new for the core.
        assert_eq!(host.answer(a, Request::Hello([1; 32]), now), (vec![7; 32], None));
        assert_eq!(host.answer(b, Request::Hello([2; 32]), now), (Vec::new(), None));
        assert_eq!(host.answer(b, Request::Sealed(vec![9]), now), (Vec::new(), None));
        assert_eq!(host.peer(), Some(a));
        assert_eq!(host.answer(a, Request::Sealed(vec![9; 40]), now), (vec![1], Some(Inbound::Sealed { ciphertext: vec![9; 40] })));
        // One transfer per link; after it, the link is gone (not refused).
        assert_eq!(host.answer(a, Request::Sealed(vec![9]), now), (vec![GONE], None));
        assert_eq!(host.answer(a, Request::Hello([1; 32]), now), (vec![GONE], None));
    }

    #[test]
    fn a_transfer_before_any_hello_is_refused() {
        let (mut host, now) = host();
        assert_eq!(host.answer(PeerId::random(), Request::Sealed(vec![9]), now), (Vec::new(), None));
        assert_eq!(host.peer(), None);
    }

    #[test]
    fn the_link_expires_after_five_minutes() {
        let (mut host, now) = host();
        let later = now + DEVICE_LINK_TTL;
        assert!(host.expired(later));
        assert_eq!(host.answer(PeerId::random(), Request::Hello([1; 32]), later), (vec![GONE], None));
    }

    #[test]
    fn requests_are_capped_per_peer_and_in_all() {
        let (mut host, now) = host();
        let a = PeerId::random();
        for _ in 0..PER_PEER {
            assert!(!host.answer(a, Request::Hello([1; 32]), now).0.is_empty());
        }
        assert!(host.answer(a, Request::Hello([1; 32]), now).0.is_empty());
        // Past the per-link request cap nobody, the locked peer included,
        // gets an answer.
        let (mut host, now) = self::host();
        let peers: Vec<PeerId> = (0..4).map(|_| PeerId::random()).collect();
        for peer in &peers {
            for _ in 0..ALL / 4 {
                host.answer(*peer, Request::Hello([1; 32]), now);
            }
        }
        assert_eq!(host.peer(), Some(peers[0]));
        assert_eq!(host.answer(peers[0], Request::Hello([1; 32]), now), (Vec::new(), None));
        // Different peers tracked are capped too.
        let (mut host, now) = self::host();
        for _ in 0..MAX_PEERS + 5 {
            host.answer(PeerId::random(), Request::Sealed(vec![1]), now);
        }
        assert_eq!(host.asked.len(), MAX_PEERS);
    }

    /// QA, 0.4.6: an expired or used link reads "not found", a link held by
    /// another device "refused" (locked out).
    #[test]
    fn a_gone_link_and_a_refusal_are_told_apart() {
        assert_eq!(outcome(vec![GONE]), Err(LinkError::NotFound));
        assert_eq!(outcome(Vec::new()), Err(LinkError::Refused));
        assert_eq!(outcome(vec![1]), Ok(vec![1]));
        assert_eq!(outcome(vec![7; 32]), Ok(vec![7; 32]));
    }

    #[test]
    fn the_codec_keeps_to_the_wire_format_and_size() {
        futures::executor::block_on(async {
            let mut codec = LinkCodec;
            let p = DEVICE_LINK_PROTOCOL;
            for request in [Request::Hello([3; 32]), Request::Sealed(vec![5; MAX_DEVICE_LINK - 1])] {
                let mut wire = Vec::new();
                codec.write_request(&p, &mut wire, request.clone()).await.unwrap();
                assert_eq!(codec.read_request(&p, &mut wire.as_slice()).await.unwrap(), request);
            }
            let mut wire = Vec::new();
            assert!(codec.write_request(&p, &mut wire, Request::Sealed(vec![5; MAX_DEVICE_LINK])).await.is_err());
            assert!(codec.write_request(&p, &mut wire, Request::Sealed(Vec::new())).await.is_err());
            let mut long = vec![SEALED];
            long.extend(vec![0; MAX_DEVICE_LINK]);
            assert!(codec.read_request(&p, &mut long.as_slice()).await.is_err());
            assert!(codec.read_request(&p, &mut [HELLO, 1, 2].as_slice()).await.is_err());
            assert!(codec.read_request(&p, &mut [9u8, 1].as_slice()).await.is_err());
            assert!(codec.read_response(&p, &mut vec![0; MAX_DEVICE_LINK + 1].as_slice()).await.is_err());
        });
    }
}
