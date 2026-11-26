//! NC-1 (a): how this node's network operations succeeded, by path, for
//! the diagnostics file. Counts only: never an address, a peer ID or a
//! time. The node bumps them as operations complete; the handle reads a
//! snapshot without a round-trip to the node task (it's read under the
//! core's lock, TL on #620).
//!
//! A count is the number of successful operations since start:
//! - `Join`: invite fetches answered (the network step of a join);
//! - `Sync`: pulls answered;
//! - `Call`: a call peer's media taking that path (once per change).

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

/// What the operation was for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetPurpose {
    Join,
    Sync,
    Call,
}

/// The connection it went over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetPath {
    /// Direct, to a LAN address.
    DirectLan,
    /// Direct, opened by a DCUtR hole punch.
    DirectHolepunch,
    /// Direct, to any other address (an open or port-mapped peer).
    DirectPublic,
    /// A circuit through one of our relays.
    OurRelay,
    /// A circuit through a member's relay.
    MemberRelay,
    /// No connection (a call peer with no path).
    None,
}

/// How others can reach this node, as far as it can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum NetReach {
    #[default]
    Unknown,
    /// A peer dialled us back (R1), or we listen on a global address.
    Public,
    /// Reachable through a port mapping (R1b).
    PortMapped,
    /// Behind a NAT: peers see an address we don't listen on.
    Nat,
    /// Peers see a carrier-grade NAT address (100.64.0.0/10).
    CgnatLikely,
}

const PURPOSES: [NetPurpose; 3] = [NetPurpose::Join, NetPurpose::Sync, NetPurpose::Call];
const PATHS: [NetPath; 6] = [
    NetPath::DirectLan,
    NetPath::DirectHolepunch,
    NetPath::DirectPublic,
    NetPath::OurRelay,
    NetPath::MemberRelay,
    NetPath::None,
];
const REACHES: [NetReach; 5] =
    [NetReach::Unknown, NetReach::Public, NetReach::PortMapped, NetReach::Nat, NetReach::CgnatLikely];

/// The counters, shared by the node task and its handle.
#[derive(Default)]
pub struct NetStats {
    counts: [[AtomicU64; 6]; 3],
    reach: AtomicU8,
}

/// A copy of the counters: the non-zero `(purpose, path, count)`s.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetStatsSnapshot {
    pub paths: Vec<(NetPurpose, NetPath, u64)>,
    pub reachability: NetReach,
}

impl NetStats {
    pub(crate) fn add(&self, purpose: NetPurpose, path: NetPath) {
        let (p, q) = (index(&PURPOSES, purpose), index(&PATHS, path));
        self.counts[p][q].fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn set_reach(&self, reach: NetReach) {
        self.reach.store(index(&REACHES, reach) as u8, Ordering::Relaxed);
    }

    pub(crate) fn reach(&self) -> NetReach {
        REACHES.get(self.reach.load(Ordering::Relaxed) as usize).copied().unwrap_or_default()
    }

    pub fn snapshot(&self) -> NetStatsSnapshot {
        let mut paths = Vec::new();
        for (p, purpose) in PURPOSES.iter().enumerate() {
            for (q, path) in PATHS.iter().enumerate() {
                let n = self.counts[p][q].load(Ordering::Relaxed);
                if n > 0 {
                    paths.push((*purpose, *path, n));
                }
            }
        }
        NetStatsSnapshot { paths, reachability: self.reach() }
    }
}

fn index<T: PartialEq>(all: &[T], item: T) -> usize {
    all.iter().position(|x| *x == item).expect("listed")
}

/// Reachability from what peers observe of us (identify) and what we
/// listen on: a carrier-grade address, else a global listen address, else
/// a NAT. A LAN peer's view (a private or link-local address) says
/// nothing about the internet: `None`, the value is kept. `Public` from a
/// dial-back (R1) is set by the node directly.
pub(crate) fn reach_of(observed: std::net::IpAddr, listening: &[std::net::IpAddr]) -> Option<NetReach> {
    use std::net::IpAddr;
    match observed {
        IpAddr::V4(v4) if v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64 => {
            return Some(NetReach::CgnatLikely)
        }
        IpAddr::V4(v4) if v4.is_private() || v4.is_link_local() || v4.is_loopback() || v4.is_unspecified() => {
            return None
        }
        IpAddr::V6(v6)
            if v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80 =>
        {
            return None
        }
        _ => {}
    }
    Some(if listening.contains(&observed) { NetReach::Public } else { NetReach::Nat })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_reach_round_trip() {
        let stats = NetStats::default();
        assert_eq!(stats.snapshot(), NetStatsSnapshot::default());
        stats.add(NetPurpose::Sync, NetPath::OurRelay);
        stats.add(NetPurpose::Sync, NetPath::OurRelay);
        stats.add(NetPurpose::Call, NetPath::DirectLan);
        stats.set_reach(NetReach::CgnatLikely);
        let snap = stats.snapshot();
        assert_eq!(snap.paths, [(NetPurpose::Sync, NetPath::OurRelay, 2), (NetPurpose::Call, NetPath::DirectLan, 1)]);
        assert_eq!(snap.reachability, NetReach::CgnatLikely);
    }

    #[test]
    fn reach_from_observations() {
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        assert_eq!(reach_of(ip("100.72.1.2"), &[ip("192.168.1.5")]), Some(NetReach::CgnatLikely));
        assert_eq!(reach_of(ip("100.128.1.2"), &[]), Some(NetReach::Nat));
        assert_eq!(reach_of(ip("203.0.113.7"), &[ip("203.0.113.7")]), Some(NetReach::Public));
        assert_eq!(reach_of(ip("203.0.113.7"), &[ip("192.168.1.5")]), Some(NetReach::Nat));
        // A LAN peer's view says nothing: kept as it was.
        assert_eq!(reach_of(ip("192.168.1.5"), &[ip("192.168.1.5")]), None);
        assert_eq!(reach_of(ip("fe80::1"), &[]), None);
        assert_eq!(reach_of(ip("fd00::1"), &[]), None);
    }
}
