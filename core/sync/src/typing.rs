//! "Is typing…" transport (G-29, piece A): `/mvs/typing/1`.
//!
//! The same pattern as `/mvs/voice/1` (`voice`), in its own protocol with
//! its own caps, so typing can never spend the voice budget:
//! - One request carries one opaque blob (the api's signed envelope) of at
//!   most [`MAX_TYPING_BLOB`] bytes; the answer is empty.
//! - Ephemeral: never stored, never gossiped, never forwarded.
//! - Only between verified current members (the voice and punch check).
//!   A request from anyone else, over a rate cap or over the size cap, is
//!   dropped unanswered. What passes becomes
//!   [`crate::NodeEvent::TypingSignal`] with the identity the peer is bound to.
//! - Older peers don't speak the protocol: negotiation fails, harmlessly.
//!
//! Caps: per peer a burst of [`PER_PEER_BURST`], then one every
//! [`PER_PEER_EVERY_SECS`] s (a typer repeats at most every 3 s); all peers
//! together a burst of [`ALL_BURST`], then [`ALL_RATE`] a second.

use std::io;
use std::time::Instant;

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::{request_response, PeerId, StreamProtocol};

use crate::limits::RateLimiter;

pub(crate) const TYPING_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/typing/1");
/// Largest blob, in bytes.
pub const MAX_TYPING_BLOB: usize = 512;
pub(crate) const PER_PEER_BURST: u32 = 3;
pub(crate) const PER_PEER_EVERY_SECS: u32 = 2;
pub(crate) const ALL_BURST: u32 = 30;
pub(crate) const ALL_RATE: u32 = 10;
/// Per-peer buckets remembered.
const MAX_TRACKED: usize = 1024;

/// Why a typing signal wasn't sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypingError {
    /// Over [`MAX_TYPING_BLOB`].
    TooLarge,
    /// No connected peer is bound to that identity as a current member.
    NotMember,
    /// The node has stopped.
    Stopped,
}

impl std::fmt::Display for TypingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TypingError::TooLarge => "typing signal too large",
            TypingError::NotMember => "no connected member with that identity",
            TypingError::Stopped => "the node has stopped",
        })
    }
}

impl std::error::Error for TypingError {}

/// Per-peer and overall caps on accepted typing signals.
pub(crate) struct TypingLimits {
    per_peer: RateLimiter<PeerId>,
    all: RateLimiter<()>,
}

impl TypingLimits {
    pub(crate) fn new() -> Self {
        TypingLimits {
            per_peer: RateLimiter::per_minute(PER_PEER_BURST, 60 / PER_PEER_EVERY_SECS, MAX_TRACKED),
            all: RateLimiter::new(ALL_BURST, ALL_RATE, 1),
        }
    }

    /// Spends one of `peer`'s budget and the overall one; false (and
    /// nothing spent overall) if `peer` is over its cap.
    pub(crate) fn allow(&mut self, peer: PeerId, now: Instant) -> bool {
        self.per_peer.allow(peer, now) && self.all.allow((), now)
    }
}

/// The wire format: the request is the blob itself, up to the end of the
/// stream; the answer is empty. Reading stops after [`MAX_TYPING_BLOB`] + 1
/// bytes, and a longer blob fails the stream (so it goes unanswered).
#[derive(Clone, Default)]
pub(crate) struct TypingCodec;

pub(crate) type TypingBehaviour = request_response::Behaviour<TypingCodec>;

pub(crate) fn behaviour() -> TypingBehaviour {
    request_response::Behaviour::new(
        [(TYPING_PROTOCOL, request_response::ProtocolSupport::Full)],
        request_response::Config::default().with_request_timeout(std::time::Duration::from_secs(10)),
    )
}

#[async_trait::async_trait]
impl request_response::Codec for TypingCodec {
    type Protocol = StreamProtocol;
    type Request = Vec<u8>;
    type Response = ();

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Vec<u8>>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut blob = Vec::new();
        io.take(MAX_TYPING_BLOB as u64 + 1).read_to_end(&mut blob).await?;
        if blob.len() > MAX_TYPING_BLOB {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "typing signal too large"));
        }
        Ok(blob)
    }

    async fn read_response<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<()>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut rest = Vec::new();
        io.take(1).read_to_end(&mut rest).await?;
        Ok(())
    }

    async fn write_request<T>(&mut self, _: &StreamProtocol, io: &mut T, blob: Vec<u8>) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        if blob.len() > MAX_TYPING_BLOB {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "typing signal too large"));
        }
        io.write_all(&blob).await
    }

    async fn write_response<T>(&mut self, _: &StreamProtocol, _: &mut T, _: ()) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::request_response::Codec as _;
    use std::time::Duration;

    #[test]
    fn a_blob_over_512_bytes_is_refused_both_ways() {
        let protocol = TYPING_PROTOCOL;
        futures::executor::block_on(async {
            let ok = vec![7u8; MAX_TYPING_BLOB];
            let got = TypingCodec.read_request(&protocol, &mut futures::io::Cursor::new(ok.clone())).await.unwrap();
            assert_eq!(got, ok);
            let big = vec![7u8; MAX_TYPING_BLOB + 1];
            assert!(TypingCodec.read_request(&protocol, &mut futures::io::Cursor::new(big.clone())).await.is_err());
            let mut sink = futures::io::Cursor::new(Vec::new());
            assert!(TypingCodec.write_request(&protocol, &mut sink, big).await.is_err());
            assert!(sink.into_inner().is_empty());
        });
    }

    #[test]
    fn per_peer_a_burst_of_3_then_one_every_2_seconds() {
        let mut limits = TypingLimits::new();
        let (peer, other) = (PeerId::random(), PeerId::random());
        let start = Instant::now();
        assert_eq!((0..10).filter(|_| limits.allow(peer, start)).count(), 3);
        // One second later: nothing yet; two seconds: one more.
        assert!(!limits.allow(peer, start + Duration::from_secs(1)));
        assert!(limits.allow(peer, start + Duration::from_secs(2)));
        assert!(!limits.allow(peer, start + Duration::from_secs(2)));
        assert!(limits.allow(other, start), "its own budget");
        // Over 60 s a peer gets at most the burst plus one every 2 s.
        let mut limits = TypingLimits::new();
        let accepted: usize = (0..600u64)
            .map(|tenth| (0..5).filter(|_| limits.allow(peer, start + Duration::from_millis(tenth * 100))).count())
            .sum();
        assert!(accepted <= 3 + 30, "{accepted}");
    }

    #[test]
    fn all_peers_together_a_burst_of_30_then_10_a_second() {
        let mut limits = TypingLimits::new();
        let peers: Vec<PeerId> = (0..40).map(|_| PeerId::random()).collect();
        let start = Instant::now();
        assert_eq!(peers.iter().filter(|p| limits.allow(**p, start)).count(), 30);
        let mut accepted = 0;
        for tenth in 1..=600u64 {
            let now = start + Duration::from_millis(tenth * 100);
            accepted += peers.iter().filter(|p| limits.allow(**p, now)).count();
        }
        assert!(accepted <= 10 * 60 + 1, "{accepted}");
    }
}
