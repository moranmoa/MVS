//! Relay in the app, R1 (`docs/design/relay-in-app.md` §1 and §6): is my
//! node publicly reachable? `/mvs/dialback/1` asks a member to dial me back.
//!
//! - **Members only, both ways** (TL 4): asked only of, and answered only
//!   for, a peer bound to a current member of a server we share, over a
//!   direct connection that already exists. Never offered to strangers.
//! - **Not a reflector** (SL RR1, TL on #565): the helper dials the IP of
//!   its existing direct connection with the asker, authenticated as the
//!   asker by Noise, never an IP the asker names. The asker names only the
//!   port it listens on (and TCP or QUIC), since the IP is the asker's own.
//!   The address must be global (no private, loopback, link-local, CGNAT,
//!   documentation or unspecified address). The dial expects the asker's
//!   peer ID, so a wrong host gets at most one failed Noise handshake. It's
//!   one address only, from a **new source port**, so a port-restricted NAT
//!   that only lets the existing peer back in doesn't pass as open. At most
//!   one dial-back per asker every 10 minutes ([`PER_ASKER_EVERY`]), and
//!   [`ALL_PER_HOUR`] for everyone together.
//! - **The asker** asks at most 2 members at a time. It believes a
//!   `Reached(addr)` only if `addr` is its own ([`own_candidate`]: an IP
//!   peers observed for it, a port it listens on) **and** an inbound
//!   connection from that helper actually arrived. It keeps the
//!   confirmation for [`CONFIRMED_FOR`]; a listen-address or public-IP
//!   change drops it. Only a confirmed node serves and offers itself as a
//!   member relay.
//! - Wire: the request is 3 bytes (QUIC or TCP, then the port); the answer
//!   is one status byte, then the address dialled if it was reached
//!   ([`MAX_ANSWER`] bytes in all).

use std::io;
use std::net::IpAddr;
use std::time::Duration;

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::multiaddr::Protocol;
use libp2p::{request_response, Multiaddr, StreamProtocol};

pub(crate) const DIALBACK_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/dialback/1");
/// One dial-back per asker this often (SL RR1).
pub(crate) const PER_ASKER_EVERY: Duration = Duration::from_secs(600);
/// An asker's first retry after a round that confirmed nothing; it doubles
/// up to [`PER_ASKER_EVERY`].
pub(crate) const FIRST_RETRY: Duration = Duration::from_secs(15);
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

/// The IP and (transport, port) of a direct address.
fn split(addr: &Multiaddr) -> Option<(IpAddr, (u8, u16))> {
    let mut parts = addr.iter();
    let ip = match parts.next()? {
        Protocol::Ip4(ip) => IpAddr::V4(ip),
        Protocol::Ip6(ip) => IpAddr::V6(ip),
        _ => return None,
    };
    let transport = match parts.next()? {
        Protocol::Tcp(port) => (0, port),
        Protocol::Udp(port) if parts.next() == Some(Protocol::QuicV1) => (1, port),
        _ => return None,
    };
    // Direct only: at most a trailing peer ID, never a circuit (a relay's
    // own port must never pass for ours).
    match (parts.next(), parts.next()) {
        (None, None) | (Some(Protocol::P2p(_)), None) => Some((ip, transport)),
        _ => None,
    }
}

/// SL on #565: an address a helper says it reached me at is believed only
/// if it is one of mine: its IP one that peers observed for me
/// (identify's observed addresses), its transport and port one I listen
/// on. A helper naming anyone else's address is ignored, so it can't make
/// me advertise a victim as my relay.
pub(crate) fn own_candidate(addr: &Multiaddr, observed_ips: &[IpAddr], listening: &[Multiaddr]) -> bool {
    let Some((ip, transport)) = split(addr) else { return false };
    observed_ips.contains(&ip) && listening.iter().any(|l| split(l).is_some_and(|(_, ours)| ours == transport))
}

/// Same transport and port (TL on #565: the probe must have come in on
/// the port the helper says it dialled).
pub(crate) fn same_port(a: &Multiaddr, b: &Multiaddr) -> bool {
    matches!((split(a), split(b)), (Some((_, x)), Some((_, y))) if x == y)
}

/// What the asker asks: dial me back on this port of mine, over QUIC or TCP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ask {
    pub quic: bool,
    pub port: u16,
}

/// The one address a helper dials for `ask`: the asker's IP as the
/// helper's own connection with it shows, and the port the asker listens on.
pub(crate) fn target(ip: IpAddr, ask: Ask) -> Multiaddr {
    let addr = Multiaddr::empty().with(match ip {
        IpAddr::V4(ip) => Protocol::Ip4(ip),
        IpAddr::V6(ip) => Protocol::Ip6(ip),
    });
    if ask.quic {
        addr.with(Protocol::Udp(ask.port)).with(Protocol::QuicV1)
    } else {
        addr.with(Protocol::Tcp(ask.port))
    }
}

/// The IP of a direct address.
pub(crate) fn ip_of(addr: &Multiaddr) -> Option<IpAddr> {
    split(addr).map(|(ip, _)| ip)
}

/// My `Ask`: a TCP port I listen on (else a QUIC one), off any circuit.
pub(crate) fn ask_for(listening: &[Multiaddr]) -> Option<Ask> {
    let ports: Vec<(u8, u16)> = listening.iter().filter_map(split).map(|(_, t)| t).filter(|(_, p)| *p != 0).collect();
    ports
        .iter()
        .find(|(kind, _)| *kind == 0)
        .or_else(|| ports.first())
        .map(|(kind, port)| Ask { quic: *kind == 1, port: *port })
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
    type Request = Ask;
    type Response = Answer;

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Ask>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut bytes = Vec::new();
        io.take(4).read_to_end(&mut bytes).await?;
        match bytes[..] {
            [kind @ (0 | 1), hi, lo] if u16::from_be_bytes([hi, lo]) != 0 => {
                Ok(Ask { quic: kind == 1, port: u16::from_be_bytes([hi, lo]) })
            }
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, "bad dial-back request")),
        }
    }

    async fn read_response<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Answer>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut answer = Vec::new();
        io.take(MAX_ANSWER as u64 + 1).read_to_end(&mut answer).await?;
        decode(&answer).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad dial-back answer"))
    }

    async fn write_request<T>(&mut self, _: &StreamProtocol, io: &mut T, ask: Ask) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        let [hi, lo] = ask.port.to_be_bytes();
        io.write_all(&[u8::from(ask.quic), hi, lo]).await
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
    fn a_reported_address_counts_only_if_it_is_mine() {
        let observed: [IpAddr; 1] = ["8.8.8.8".parse().unwrap()];
        assert!(same_port(&addr("/ip4/127.0.0.1/tcp/4001"), &addr("/ip4/8.8.8.8/tcp/4001")));
        assert!(!same_port(&addr("/ip4/8.8.8.8/tcp/4001"), &addr("/ip4/8.8.8.8/udp/4001/quic-v1")));
        assert!(!same_port(&addr("/ip4/8.8.8.8/tcp/4001"), &addr("/ip4/8.8.8.8/tcp/4002")));
        let listening = [addr("/ip4/0.0.0.0/tcp/4001"), addr("/ip4/0.0.0.0/udp/4001/quic-v1")];
        assert!(own_candidate(&addr("/ip4/8.8.8.8/tcp/4001"), &observed, &listening));
        assert!(own_candidate(&addr("/ip4/8.8.8.8/udp/4001/quic-v1"), &observed, &listening));
        // A victim's IP, or a port I don't listen on, or another transport.
        assert!(!own_candidate(&addr("/ip4/9.9.9.9/tcp/4001"), &observed, &listening));
        assert!(!own_candidate(&addr("/ip4/8.8.8.8/tcp/22"), &observed, &listening));
        assert!(!own_candidate(&addr("/ip4/8.8.8.8/udp/4001"), &observed, &listening));
        // Nothing observed for me yet: nothing is believed.
        assert!(!own_candidate(&addr("/ip4/8.8.8.8/tcp/4001"), &[], &listening));
    }

    #[test]
    fn the_target_is_the_connection_ip_and_the_asked_port() {
        let ip: IpAddr = "8.8.8.8".parse().unwrap();
        assert_eq!(target(ip, Ask { quic: false, port: 4001 }), addr("/ip4/8.8.8.8/tcp/4001"));
        assert_eq!(target(ip, Ask { quic: true, port: 4001 }), addr("/ip4/8.8.8.8/udp/4001/quic-v1"));
        // My ask: a TCP listen port first, else QUIC; never port 0.
        let tcp_and_quic = [addr("/ip4/0.0.0.0/udp/5000/quic-v1"), addr("/ip4/0.0.0.0/tcp/4001")];
        assert_eq!(ask_for(&tcp_and_quic), Some(Ask { quic: false, port: 4001 }));
        assert_eq!(ask_for(&[addr("/ip4/0.0.0.0/udp/5000/quic-v1")]), Some(Ask { quic: true, port: 5000 }));
        assert_eq!(ask_for(&[addr("/ip4/0.0.0.0/tcp/0")]), None);
        // A circuit listen address is never taken for our own port.
        let circuit = addr("/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA/p2p-circuit");
        assert_eq!(ask_for(&[circuit.clone(), addr("/ip4/0.0.0.0/tcp/5555")]), Some(Ask { quic: false, port: 5555 }));
        assert_eq!(ask_for(&[circuit]), None);
    }

    #[test]
    fn requests_are_three_bytes_and_junk_is_refused() {
        let protocol = DIALBACK_PROTOCOL;
        futures::executor::block_on(async {
            let mut sink = futures::io::Cursor::new(Vec::new());
            request_response::Codec::write_request(&mut DialbackCodec, &protocol, &mut sink, Ask { quic: true, port: 4001 })
                .await
                .unwrap();
            let bytes = sink.into_inner();
            assert_eq!(bytes, [1, 0x0f, 0xa1]);
            let read = |bytes: Vec<u8>| {
                let protocol = protocol.clone();
                async move {
                    request_response::Codec::read_request(&mut DialbackCodec, &protocol, &mut futures::io::Cursor::new(bytes))
                        .await
                }
            };
            assert_eq!(read(bytes).await.unwrap(), Ask { quic: true, port: 4001 });
            for junk in [vec![], vec![0, 0, 0], vec![2, 0, 1], vec![0, 0, 1, 0]] {
                assert!(read(junk).await.is_err());
            }
        });
    }
}
