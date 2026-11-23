//! Relay in the app, R1 (`docs/design/relay-in-app.md` §1 and §6): is my
//! node publicly reachable? `/mvs/dialback/1` asks a member to dial me back.
//!
//! - **Members only, both ways** (TL 4): asked only of, and answered only
//!   for, a peer bound to a current member of a server we share, over a
//!   connection that already exists. Never offered to strangers.
//! - **Not a reflector** (SL RR1): the helper dials **only the address it
//!   observed** for the asker, the remote address of a direct connection
//!   the asker opened to it, never one the asker supplies. That address
//!   must be global (no private, loopback, link-local, CGNAT or unspecified
//!   address), and the dial expects the asker's peer ID, so a wrong host
//!   gets at most one failed Noise handshake. At most one dial-back per
//!   asker every 10 minutes ([`PER_ASKER_EVERY`]), and [`ALL_PER_HOUR`]
//!   for everyone together.
//! - **The asker** asks at most 2 members at a time, and keeps a
//!   confirmation for [`CONFIRMED_FOR`]; a listen-address change drops it.
//!   Only a confirmed node offers itself as a member relay.
//! - Wire: the request is empty; the answer is one status byte, then the
//!   address dialled if it was reached ([`MAX_ANSWER`] bytes in all).

use std::io;
use std::net::IpAddr;
use std::time::Duration;

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::multiaddr::Protocol;
use libp2p::{request_response, Multiaddr, StreamProtocol};

pub(crate) const DIALBACK_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/dialback/1");
/// One dial-back per asker this often (SL RR1).
pub(crate) const PER_ASKER_EVERY: Duration = Duration::from_secs(600);
/// Dial-backs a helper makes in an hour, for everyone together.
pub(crate) const ALL_PER_HOUR: u32 = 30;
/// A dial-back gives up after this long.
pub(crate) const DIAL_FOR: Duration = Duration::from_secs(10);
/// How long a confirmation counts (TL 4: about 30 minutes).
pub(crate) const CONFIRMED_FOR: Duration = Duration::from_secs(1800);
/// Members asked at a time.
pub(crate) const HELPERS: usize = 2;
/// The answer's size cap: a status byte and a multiaddr.
const MAX_ANSWER: usize = 1 + 64;

/// What a helper answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    /// Reached the asker at this (observed) address.
    Reached(Multiaddr),
    /// Tried, and didn't reach it.
    NotReached,
    /// Didn't try: not a member, over a cap, no observed global address,
    /// or the helper is relay-only.
    Declined,
}

/// Whether a helper may dial `addr` back (SL RR1): a direct IP/TCP or
/// IP/UDP/QUIC address, global, with nothing else in it.
pub(crate) fn dialable(addr: &Multiaddr, allow_local: bool) -> bool {
    let mut parts = addr.iter();
    let ip = match parts.next() {
        Some(Protocol::Ip4(ip)) => IpAddr::V4(ip),
        Some(Protocol::Ip6(ip)) => IpAddr::V6(ip),
        _ => return false,
    };
    let transport_ok = match (parts.next(), parts.next(), parts.next()) {
        (Some(Protocol::Tcp(port)), None, None) => port != 0,
        (Some(Protocol::Udp(port)), Some(Protocol::QuicV1), None) => port != 0,
        _ => false,
    };
    transport_ok && (allow_local || global(ip))
}

fn global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_multicast()
                || (a == 100 && (64..128).contains(&b))
                || a == 0)
        }
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            // Global unicast only (2000::/3); IPv4-mapped is judged as IPv4.
            if let Some(v4) = ip.to_ipv4_mapped() {
                return global(IpAddr::V4(v4));
            }
            // Not documentation (2001:db8::/32) nor Teredo (2001::/32).
            (first & 0xe000) == 0x2000 && !(first == 0x2001 && (second == 0x0db8 || second == 0))
        }
    }
}

/// The address to dial back: the remote address of the asker's own
/// direct connection to us, with any `/p2p/...` dropped.
pub(crate) fn observed(send_back: &Multiaddr) -> Multiaddr {
    send_back.iter().filter(|p| !matches!(p, Protocol::P2p(_))).collect()
}

#[derive(Clone, Default)]
pub(crate) struct DialbackCodec;

pub(crate) type DialbackBehaviour = request_response::Behaviour<DialbackCodec>;

pub(crate) fn behaviour() -> DialbackBehaviour {
    request_response::Behaviour::new(
        [(DIALBACK_PROTOCOL, request_response::ProtocolSupport::Full)],
        // The helper dials for up to `DIAL_FOR` before it answers.
        request_response::Config::default().with_request_timeout(DIAL_FOR + Duration::from_secs(10)),
    )
}

#[async_trait::async_trait]
impl request_response::Codec for DialbackCodec {
    type Protocol = StreamProtocol;
    type Request = ();
    type Response = Answer;

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<()>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut rest = Vec::new();
        io.take(1).read_to_end(&mut rest).await?;
        if !rest.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "dial-back requests are empty"));
        }
        Ok(())
    }

    async fn read_response<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Answer>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut answer = Vec::new();
        io.take(MAX_ANSWER as u64 + 1).read_to_end(&mut answer).await?;
        decode(&answer).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad dial-back answer"))
    }

    async fn write_request<T>(&mut self, _: &StreamProtocol, _: &mut T, _: ()) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        Ok(())
    }

    async fn write_response<T>(&mut self, _: &StreamProtocol, io: &mut T, answer: Answer) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        io.write_all(&encode(&answer)).await
    }
}

fn encode(answer: &Answer) -> Vec<u8> {
    match answer {
        Answer::Reached(addr) => [&[1u8][..], &addr.to_vec()].concat(),
        Answer::NotReached => vec![2],
        Answer::Declined => vec![3],
    }
}

fn decode(bytes: &[u8]) -> Option<Answer> {
    if bytes.len() > MAX_ANSWER {
        return None;
    }
    match bytes.split_first()? {
        (1, addr) => Multiaddr::try_from(addr.to_vec()).ok().map(Answer::Reached),
        (2, []) => Some(Answer::NotReached),
        (3, []) => Some(Answer::Declined),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(s: &str) -> Multiaddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_global_direct_addresses_are_dialled_back() {
        for ok in ["/ip4/8.8.8.8/tcp/4001", "/ip4/1.2.3.4/udp/4001/quic-v1", "/ip6/2a00:1450::1/tcp/4001", "/ip6/2001:4860::8888/tcp/4001"] {
            assert!(dialable(&addr(ok), false), "{ok}");
        }
        for bad in [
            "/ip4/192.168.1.5/tcp/4001",
            "/ip4/10.0.0.1/tcp/4001",
            "/ip4/127.0.0.1/tcp/4001",
            "/ip4/169.254.1.1/tcp/4001",
            "/ip4/100.64.0.1/tcp/4001",
            "/ip4/0.0.0.0/tcp/4001",
            "/ip4/8.8.8.8/tcp/0",
            "/ip6/::1/tcp/4001",
            "/ip6/fe80::1/tcp/4001",
            "/ip6/fd00::1/tcp/4001",
            "/ip6/2001:db8::1/tcp/4001",
            "/dns4/example.com/tcp/4001",
            "/ip4/8.8.8.8/tcp/4001/p2p-circuit",
            "/ip4/8.8.8.8/udp/4001",
        ] {
            assert!(!dialable(&addr(bad), false), "{bad}");
        }
        // Tests on one machine only.
        assert!(dialable(&addr("/ip4/127.0.0.1/tcp/4001"), true));
    }

    #[test]
    fn answers_round_trip_and_junk_is_refused() {
        for answer in [Answer::Reached(addr("/ip4/8.8.8.8/tcp/4001")), Answer::NotReached, Answer::Declined] {
            assert_eq!(decode(&encode(&answer)), Some(answer));
        }
        assert_eq!(decode(&[]), None);
        assert_eq!(decode(&[2, 0]), None);
        assert_eq!(decode(&[9]), None);
        assert_eq!(decode(&[1; MAX_ANSWER + 1]), None);
    }

    #[test]
    fn the_observed_address_drops_its_peer_id() {
        let send_back = addr("/ip4/8.8.8.8/tcp/4001/p2p/12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA");
        assert_eq!(observed(&send_back), addr("/ip4/8.8.8.8/tcp/4001"));
    }
}
