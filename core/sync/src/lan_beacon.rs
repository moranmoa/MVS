//! The member-only LAN beacon (relay-down resilience, item 3 part 2;
//! `relay-down-resilience-design.md` §2 and the Security Lead's rules in
//! `sec-lead-relay-down-resilience.md` §B). Two members on one LAN find
//! each other with no relay and nothing remembered.
//!
//! Every [`BEACON_EVERY`] (± jitter) a node sends one UDP multicast packet,
//! link-local ([`GROUP`], TTL 1):
//!
//! ```text
//! "mvsl1" ‖ tcp port u16le ‖ SLOTS × ( tag[16] ‖ nonce[24] ‖ sealed( peer ID[38] ‖ 4 × IPv4 )[54 + 16] )
//! ```
//!
//! - `k_lan = derive_key("mvs/lan-beacon/v1", server secret)`: only members
//!   (who hold the secret) can make or read a tag.
//! - `tag = BLAKE3-keyed(k_lan, epoch ‖ port)[..16]`, epochs of
//!   [`EPOCH_SECS`]; the current epoch and one either side are accepted.
//! - The peer ID and the sender's LAN IPv4 addresses (up to [`MAX_IPS`],
//!   zero-padded) are sealed with XChaCha20-Poly1305 under
//!   `derive_key("mvs/lan-beacon-id/v1", k_lan ‖ epoch)` and a random nonce,
//!   so the beacon is unlinkable and keeps one size.
//! - A member dials only a **LAN-scope** source (RFC 1918, CGNAT,
//!   link-local, loopback) that is **one of the sealed addresses**, at that
//!   address, expecting the sealed peer ID. A replay from any other host is
//!   never dialled: libp2p-noise sends the dialer's identity (message 3)
//!   before the swarm's `WrongPeerId` check, so an aborted dial would
//!   still give our peer ID away (Tech Lead, Security Lead on #460).
//! - Always [`SLOTS`] slots, unused ones random, so the size never shows how
//!   many servers someone is in; with more open servers they take turns.
//! - Passive: a beacon is never answered. Off under relay-only, with "LAN
//!   allowed" off, and with no server open. Reads, dials and per-address
//!   dials are capped.
//!
//! Residual (accepted, as GAP-4b): a kicked member keeps the old secret until
//! rotation on kick, so on the same LAN it can tell "a member of X is
//! here"; binding still refuses it.
//! Residual (accepted, beside GAP-4b): a host that can spoof a sealed
//! address on the LAN (ARP spoofing, a man in the middle) can still be
//! dialled and learn the dialer's peer ID.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use libp2p::PeerId;
use rand_core::{OsRng, RngCore};
use records::ServerId;

use crate::access::ServerSecret;
use crate::limits::RateLimiter;

/// The multicast group (administratively scoped, never routed off the LAN).
pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 83);
/// The UDP port beacons go to.
pub const BEACON_PORT: u16 = 47_183;
/// How often a node sends its beacon (plus up to [`BEACON_JITTER`]).
pub const BEACON_EVERY: Duration = Duration::from_secs(30);
const BEACON_JITTER_MS: u64 = 5_000;
/// One tag epoch.
pub const EPOCH_SECS: u64 = 600;
/// Tag slots in every beacon.
pub const SLOTS: usize = 8;

const MAGIC: &[u8; 5] = b"mvsl1";
const TAG: usize = 16;
const NONCE: usize = 24;
/// An Ed25519 peer ID's bytes.
const PEER_ID: usize = 38;
/// Sender addresses sealed in each slot.
pub const MAX_IPS: usize = 4;
const PLAIN: usize = PEER_ID + MAX_IPS * 4;
const SEALED: usize = PLAIN + 16;
const SLOT: usize = TAG + NONCE + SEALED;
/// Every beacon is exactly this long.
pub const PACKET_LEN: usize = MAGIC.len() + 2 + SLOTS * SLOT;

/// Beacons read a second, dials made a minute from beacons, and how often
/// one address may be dialled (design §2, Tech Lead).
const READS_PER_SEC: u32 = 50;
const DIALS_PER_MIN: u32 = 8;
const REDIAL_ADDR: Duration = Duration::from_secs(300);
const MAX_ADDRS: usize = 256;

/// A server's beacon key.
pub(crate) fn k_lan(secret: &ServerSecret) -> [u8; 32] {
    blake3::derive_key("mvs/lan-beacon/v1", secret.as_bytes())
}

/// The epoch of `unix` seconds.
pub(crate) fn epoch_of(unix: u64) -> u64 {
    unix / EPOCH_SECS
}

fn tag(k_lan: &[u8; 32], epoch: u64, port: u16) -> [u8; TAG] {
    let mut input = epoch.to_le_bytes().to_vec();
    input.extend_from_slice(&port.to_le_bytes());
    blake3::keyed_hash(k_lan, &input).as_bytes()[..TAG].try_into().expect("16")
}

fn id_cipher(k_lan: &[u8; 32], epoch: u64) -> XChaCha20Poly1305 {
    let mut input = k_lan.to_vec();
    input.extend_from_slice(&epoch.to_le_bytes());
    XChaCha20Poly1305::new(&blake3::derive_key("mvs/lan-beacon-id/v1", &input).into())
}

/// One beacon for `keys` (at most [`SLOTS`] are used; the rest are random),
/// announcing `me` at TCP `port` on our LAN addresses `ips` (the first
/// [`MAX_IPS`] LAN-scope ones). None if our peer ID isn't Ed25519 or we
/// have no LAN address.
pub(crate) fn encode(keys: &[[u8; 32]], epoch: u64, port: u16, me: &PeerId, ips: &[Ipv4Addr]) -> Option<Vec<u8>> {
    let id = me.to_bytes();
    if id.len() != PEER_ID {
        return None;
    }
    let ips: Vec<Ipv4Addr> = ips.iter().copied().filter(|ip| lan_scope(*ip)).take(MAX_IPS).collect();
    if ips.is_empty() {
        return None;
    }
    let mut plain = id.clone();
    for i in 0..MAX_IPS {
        plain.extend_from_slice(&ips.get(i).map_or([0; 4], |ip| ip.octets()));
    }
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&port.to_le_bytes());
    let mut slots: Vec<Vec<u8>> = Vec::with_capacity(SLOTS);
    for k in keys.iter().take(SLOTS) {
        let mut nonce = [0; NONCE];
        OsRng.fill_bytes(&mut nonce);
        let sealed = id_cipher(k, epoch).encrypt(XNonce::from_slice(&nonce), plain.as_slice()).ok()?;
        slots.push([tag(k, epoch, port).as_slice(), &nonce, &sealed].concat());
    }
    while slots.len() < SLOTS {
        let mut dummy = vec![0; SLOT];
        OsRng.fill_bytes(&mut dummy);
        slots.push(dummy);
    }
    // Real slots don't always come first.
    let start = (OsRng.next_u32() as usize) % SLOTS;
    slots.rotate_left(start);
    for slot in slots {
        out.extend_from_slice(&slot);
    }
    Some(out)
}

/// A beacon's port, peer ID and sealed sender addresses, and the server
/// it was found for, if one of its slots is a tag of `keys` in `epoch` or
/// one either side.
pub(crate) fn decode(packet: &[u8], keys: &[(ServerId, [u8; 32])], epoch: u64) -> Option<Beacon> {
    if packet.len() != PACKET_LEN || &packet[..5] != MAGIC {
        return None;
    }
    let port = u16::from_le_bytes([packet[5], packet[6]]);
    let slots: Vec<&[u8]> = packet[7..].chunks(SLOT).collect();
    for (server, k) in keys {
        for e in [epoch, epoch.wrapping_sub(1), epoch + 1] {
            let want = tag(k, e, port);
            for slot in &slots {
                if slot[..TAG] != want {
                    continue;
                }
                let nonce = XNonce::from_slice(&slot[TAG..TAG + NONCE]);
                let Ok(plain) = id_cipher(k, e).decrypt(nonce, &slot[TAG + NONCE..]) else { continue };
                let Ok(peer) = PeerId::from_bytes(&plain[..PEER_ID]) else { continue };
                let ips = plain[PEER_ID..]
                    .chunks(4)
                    .map(|o| Ipv4Addr::new(o[0], o[1], o[2], o[3]))
                    .filter(|ip| !ip.is_unspecified())
                    .collect();
                return Some(Beacon { port, peer, server: *server, ips });
            }
        }
    }
    None
}

/// What a member's beacon says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Beacon {
    pub port: u16,
    pub peer: PeerId,
    pub server: ServerId,
    /// The sender's LAN addresses, as it sealed them.
    pub ips: Vec<Ipv4Addr>,
}

/// LAN scope: RFC 1918, CGNAT (100.64/10), link-local, loopback.
pub(crate) fn lan_scope(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private() || ip.is_link_local() || ip.is_loopback() || (a == 100 && (64..128).contains(&b))
}

/// Where to dial a beacon heard from `source`: only a LAN-scope source
/// that is one of the addresses the sender sealed (a replay from any other
/// host is never dialled).
pub(crate) fn dial_target(source: IpAddr, beacon: &Beacon) -> Option<Ipv4Addr> {
    let IpAddr::V4(source) = source else { return None };
    (lan_scope(source) && beacon.ips.contains(&source)).then_some(source)
}

/// When the next beacon is due.
pub(crate) fn next_beacon(now: Instant) -> Instant {
    now + BEACON_EVERY + Duration::from_millis(OsRng.next_u64() % BEACON_JITTER_MS)
}

/// The caps: beacons read a second, dials a minute, and per address.
pub(crate) struct BeaconLimits {
    reads: RateLimiter<()>,
    dials: RateLimiter<()>,
    dialled: HashMap<SocketAddr, Instant>,
}

impl BeaconLimits {
    pub(crate) fn new() -> Self {
        BeaconLimits {
            reads: RateLimiter::new(READS_PER_SEC, READS_PER_SEC, 1),
            dials: RateLimiter::per_minute(DIALS_PER_MIN, DIALS_PER_MIN, 1),
            dialled: HashMap::new(),
        }
    }

    pub(crate) fn allow_read(&mut self, now: Instant) -> bool {
        self.reads.allow((), now)
    }

    /// One dial to `addr`: at most once per [`REDIAL_ADDR`] each, and
    /// [`DIALS_PER_MIN`] a minute in all.
    pub(crate) fn allow_dial(&mut self, addr: SocketAddr, now: Instant) -> bool {
        if self.dialled.get(&addr).is_some_and(|at| now.saturating_duration_since(*at) < REDIAL_ADDR) {
            return false;
        }
        if !self.dials.allow((), now) {
            return false;
        }
        if self.dialled.len() >= MAX_ADDRS {
            self.dialled.retain(|_, at| now.saturating_duration_since(*at) < REDIAL_ADDR);
        }
        self.dialled.insert(addr, now);
        true
    }
}

/// The beacon socket on `port`: shared with other nodes on this host, in
/// the group, link-local (TTL 1), hearing our own host's beacons too (two
/// nodes on one machine; our own are ignored by peer ID).
pub(crate) fn socket(port: u16) -> io::Result<tokio::net::UdpSocket> {
    use socket2::{Domain, Protocol as SockProto, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(SockProto::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)).into())?;
    socket.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED)?;
    socket.set_multicast_ttl_v4(1)?;
    socket.set_multicast_loop_v4(true)?;
    socket.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(socket.into())
}

/// Reads beacons into `to` (dropped when the node is busy); ends with the
/// node.
pub(crate) fn spawn_reader(
    socket: std::sync::Arc<tokio::net::UdpSocket>,
    to: tokio::sync::mpsc::Sender<(IpAddr, Vec<u8>)>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0; PACKET_LEN + 1];
        loop {
            match socket.recv_from(&mut buf).await {
                Ok((len, from)) if len == PACKET_LEN => {
                    if let Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) =
                        to.try_send((from.ip(), buf[..len].to_vec()))
                    {
                        return;
                    }
                }
                Ok(_) => {}
                Err(err) => {
                    tracing::debug!(%err, "LAN beacon read failed");
                    if to.is_closed() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> [u8; 32] {
        k_lan(&ServerSecret::from_bytes([n; 32]))
    }

    const LAN: [Ipv4Addr; 1] = [Ipv4Addr::new(10, 0, 0, 7)];

    #[test]
    fn a_beacon_is_dialled_only_from_a_sealed_lan_address() {
        // #460 (Tech Lead, Security Lead): libp2p-noise sends our identity
        // before WrongPeerId, so a replay must never be dialled at all.
        let me = libp2p::identity::Keypair::generate_ed25519().public().to_peer_id();
        let s = ServerId::from_bytes([1; 32]);
        let (wifi, wired) = (Ipv4Addr::new(192, 168, 1, 5), Ipv4Addr::new(10, 1, 2, 3));
        // Public addresses are never sealed; up to MAX_IPS LAN ones are.
        let all = [Ipv4Addr::new(8, 8, 8, 8), wifi, wired, Ipv4Addr::new(100, 64, 0, 1), Ipv4Addr::new(169, 254, 1, 1), Ipv4Addr::LOCALHOST];
        let packet = encode(&[key(1)], 5, 4001, &me, &all).unwrap();
        assert_eq!(packet.len(), PACKET_LEN, "the same size with more addresses");
        let beacon = decode(&packet, &[(s, key(1))], 5).unwrap();
        assert_eq!(beacon.ips, vec![wifi, wired, Ipv4Addr::new(100, 64, 0, 1), Ipv4Addr::new(169, 254, 1, 1)]);
        // A multi-homed sender is dialled from either of its addresses.
        assert_eq!(dial_target(IpAddr::V4(wifi), &beacon), Some(wifi));
        assert_eq!(dial_target(IpAddr::V4(wired), &beacon), Some(wired));
        // A replay from another LAN host: no dial.
        assert_eq!(dial_target(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 66)), &beacon), None);
        // A public source (unicast from outside), even one it sealed: no dial.
        let public = Beacon { ips: vec![Ipv4Addr::new(8, 8, 8, 8)], ..beacon.clone() };
        assert_eq!(dial_target(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), &public), None);
        assert_eq!(dial_target("2001:db8::1".parse().unwrap(), &beacon), None);
        // No LAN address of ours: no beacon.
        assert!(encode(&[key(1)], 5, 4001, &me, &[Ipv4Addr::new(8, 8, 8, 8)]).is_none());
    }

    #[test]
    fn a_member_reads_the_peer_id_and_nobody_else_does() {
        let me = libp2p::identity::Keypair::generate_ed25519().public().to_peer_id();
        let (s1, s2) = (ServerId::from_bytes([1; 32]), ServerId::from_bytes([2; 32]));
        let ips = [Ipv4Addr::new(192, 168, 1, 5)];
        let packet = encode(&[key(1)], 100, 4001, &me, &ips).unwrap();
        let want = Beacon { port: 4001, peer: me, server: s1, ips: ips.to_vec() };
        assert_eq!(decode(&packet, &[(s1, key(1))], 100), Some(want));
        // One epoch either side, not two.
        assert!(decode(&packet, &[(s1, key(1))], 101).is_some());
        assert!(decode(&packet, &[(s1, key(1))], 99).is_some());
        assert!(decode(&packet, &[(s1, key(1))], 102).is_none());
        // Another server's key reads nothing.
        assert!(decode(&packet, &[(s2, key(2))], 100).is_none());
        // A port changed in transit breaks the tag.
        let mut moved = packet.clone();
        moved[5] ^= 1;
        assert!(decode(&moved, &[(s1, key(1))], 100).is_none());
        // Unlinkable: the same beacon twice differs.
        assert_ne!(encode(&[key(1)], 100, 4001, &me, &ips).unwrap(), packet);
    }

    #[test]
    fn every_beacon_is_the_same_size_whatever_the_server_count() {
        let me = libp2p::identity::Keypair::generate_ed25519().public().to_peer_id();
        let keys: Vec<[u8; 32]> = (0..12).map(key).collect();
        for n in [0, 1, 3, SLOTS, 12] {
            assert_eq!(encode(&keys[..n], 7, 1, &me, &LAN).unwrap().len(), PACKET_LEN, "{n} servers");
        }
        // With more than SLOTS servers, the first SLOTS are in it.
        let packet = encode(&keys, 7, 1, &me, &LAN).unwrap();
        let s = ServerId::from_bytes([3; 32]);
        assert!(decode(&packet, &[(s, keys[SLOTS - 1])], 7).is_some());
        assert!(decode(&packet, &[(s, keys[SLOTS])], 7).is_none());
    }

    #[test]
    fn dials_are_capped_per_address_and_per_minute() {
        let mut limits = BeaconLimits::new();
        let now = Instant::now();
        let addr = |n: u8| SocketAddr::from(([10, 0, 0, n], 4001));
        assert!(limits.allow_dial(addr(1), now));
        assert!(!limits.allow_dial(addr(1), now), "the same address again within 5 minutes");
        assert!(limits.allow_dial(addr(1), now + REDIAL_ADDR));
        let more = (2..20).filter(|n| limits.allow_dial(addr(*n), now + REDIAL_ADDR)).count();
        assert_eq!(more, DIALS_PER_MIN as usize - 1, "8 a minute in all");
        assert_eq!((0..100).filter(|_| limits.allow_read(now)).count(), READS_PER_SEC as usize);
    }
}
