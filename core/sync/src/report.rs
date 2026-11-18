//! Report delivery (G-48): `/mvs/report/1`.
//!
//! The typing pattern (`typing`), in its own protocol with its own caps:
//! - One request carries one opaque blob (the api's sealed box) of at most
//!   [`MAX_REPORT_BLOB`] bytes. The answer is empty: the ack the sender's
//!   outbox waits for.
//! - Never stored, gossiped or forwarded here. The api stores what it keeps.
//! - Only between verified current members (the voice and typing check). A
//!   request from anyone else, over a rate cap or over the size cap, is
//!   dropped unanswered.
//! - What passes is acked at once, before the api tries to open it, so the
//!   answer is the same whatever the box holds (the security lead's R7).
//!   It becomes [`crate::NodeEvent::ReportBox`] with the identity the peer is
//!   bound to.
//! - Older peers don't speak the protocol: negotiation fails, and the
//!   sender's outbox keeps the row.
//!
//! Caps: per peer a burst of [`PER_PEER_BURST`], then one every
//! [`PER_PEER_EVERY_SECS`] s; all peers together a burst of [`ALL_BURST`],
//! then [`ALL_RATE`] a second.

use std::io;
use std::time::Instant;

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::{request_response, PeerId, StreamProtocol};

use crate::limits::RateLimiter;

pub(crate) const REPORT_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/report/1");
/// Largest box, in bytes: a report with the largest evidence, sealed.
pub const MAX_REPORT_BLOB: usize = 20 * 1024;
pub(crate) const PER_PEER_BURST: u32 = 3;
pub(crate) const PER_PEER_EVERY_SECS: u32 = 10;
pub(crate) const ALL_BURST: u32 = 20;
pub(crate) const ALL_RATE: u32 = 2;
/// Per-peer buckets remembered.
const MAX_TRACKED: usize = 1024;

/// Why a report box wasn't delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportError {
    /// Over [`MAX_REPORT_BLOB`].
    TooLarge,
    /// No connected peer is bound to that identity as a current member.
    NotMember,
    /// Sent, but no ack came back (timeout, refused, or an older peer).
    NotAcked,
    /// The node has stopped.
    Stopped,
}

impl std::fmt::Display for ReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ReportError::TooLarge => "report box too large",
            ReportError::NotMember => "no connected member with that identity",
            ReportError::NotAcked => "the report box wasn't acknowledged",
            ReportError::Stopped => "the node has stopped",
        })
    }
}

impl std::error::Error for ReportError {}

/// Per-peer and overall caps on accepted report boxes.
pub(crate) struct ReportLimits {
    per_peer: RateLimiter<PeerId>,
    all: RateLimiter<()>,
}

impl ReportLimits {
    pub(crate) fn new() -> Self {
        ReportLimits {
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

/// The wire format: the request is the box itself, up to the end of the
/// stream; the answer is empty. Reading stops after [`MAX_REPORT_BLOB`] + 1
/// bytes, and a longer box fails the stream (so it goes unanswered).
#[derive(Clone, Default)]
pub(crate) struct ReportCodec;

pub(crate) type ReportBehaviour = request_response::Behaviour<ReportCodec>;

pub(crate) fn behaviour() -> ReportBehaviour {
    request_response::Behaviour::new(
        [(REPORT_PROTOCOL, request_response::ProtocolSupport::Full)],
        request_response::Config::default().with_request_timeout(std::time::Duration::from_secs(30)),
    )
}

#[async_trait::async_trait]
impl request_response::Codec for ReportCodec {
    type Protocol = StreamProtocol;
    type Request = Vec<u8>;
    type Response = ();

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Vec<u8>>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut blob = Vec::new();
        io.take(MAX_REPORT_BLOB as u64 + 1).read_to_end(&mut blob).await?;
        if blob.len() > MAX_REPORT_BLOB {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "report box too large"));
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
        if blob.len() > MAX_REPORT_BLOB {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "report box too large"));
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
    fn a_box_over_20_kib_is_refused_both_ways() {
        let protocol = REPORT_PROTOCOL;
        futures::executor::block_on(async {
            let ok = vec![7u8; MAX_REPORT_BLOB];
            let got = ReportCodec.read_request(&protocol, &mut futures::io::Cursor::new(ok.clone())).await.unwrap();
            assert_eq!(got, ok);
            let big = vec![7u8; MAX_REPORT_BLOB + 1];
            assert!(ReportCodec.read_request(&protocol, &mut futures::io::Cursor::new(big.clone())).await.is_err());
            let mut sink = futures::io::Cursor::new(Vec::new());
            assert!(ReportCodec.write_request(&protocol, &mut sink, big).await.is_err());
            assert!(sink.into_inner().is_empty());
        });
    }

    #[test]
    fn per_peer_a_burst_of_3_then_one_every_10_seconds() {
        let mut limits = ReportLimits::new();
        let (peer, other) = (PeerId::random(), PeerId::random());
        let start = Instant::now();
        assert_eq!((0..10).filter(|_| limits.allow(peer, start)).count(), 3);
        assert!(!limits.allow(peer, start + Duration::from_secs(5)));
        assert!(limits.allow(peer, start + Duration::from_secs(10)));
        assert!(!limits.allow(peer, start + Duration::from_secs(10)));
        assert!(limits.allow(other, start), "its own budget");
    }

    #[test]
    fn all_peers_together_a_burst_of_20_then_2_a_second() {
        let mut limits = ReportLimits::new();
        let peers: Vec<PeerId> = (0..40).map(|_| PeerId::random()).collect();
        let start = Instant::now();
        assert_eq!(peers.iter().filter(|p| limits.allow(**p, start)).count(), 20);
        let mut accepted = 0;
        for tenth in 1..=600u64 {
            let now = start + Duration::from_millis(tenth * 100);
            accepted += peers.iter().filter(|p| limits.allow(**p, now)).count();
        }
        assert!(accepted <= 2 * 60 + 1, "{accepted}");
    }
}
