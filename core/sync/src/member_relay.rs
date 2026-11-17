//! Member relays, the relaying side (design #368 §1, slice 2): circuit relay
//! v2 in a member's node, for bound current members of a server we share
//! only.
//!
//! - **Off unless the core says so** ([`MemberRelay::set`], from
//!   `MemberRelay.effective`, #389): a node that doesn't relay offers no hop
//!   protocol to anyone, so nothing advertises it as a relay.
//! - **Members only:** relay v2 has no per-peer hook, so every connection's
//!   relay handler sits behind a [`RelayGate`]. Closed, it offers no protocol
//!   (a stranger's reservation is refused as "not supported") and is never
//!   polled. The node opens it once the peer is a bound current member
//!   ([`MemberRelay::set_member`]), and closes it when that stops. A circuit
//!   needs both ends' gates open: the source's for CONNECT, the
//!   destination's for STOP.
//! - **Quotas:** [`MAX_RESERVATIONS`], [`MAX_CIRCUITS`], [`CIRCUIT_DURATION`]
//!   and [`MAX_CIRCUIT_BYTES`] by relay v2 itself, and a daily byte budget
//!   here. Relay v2 reports no byte counts, so each accepted circuit is
//!   charged its full [`MAX_CIRCUIT_BYTES`] at once: the cap is never
//!   exceeded, though it may be reached early. Once the next circuit would
//!   not fit, every gate closes (circuits in flight stall) until the day
//!   turns. Refused, never queued.
//! - **Our addresses in reservations** are our direct listen addresses,
//!   which only members ever receive (a reservation goes to a member). They
//!   are given to the relay behaviour alone, never to the swarm: nothing
//!   about them reaches identify or the DHT.
//! - Traffic stays Noise end to end between the two members: the relaying
//!   node carries ciphertext (encrypted login codes included) and never
//!   reads it.
//! - Logs: counts only, never peer IDs or addresses above debug.

use std::collections::{HashMap, HashSet, VecDeque};
use std::task::{Context, Poll};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use libp2p::core::{transport::PortUse, Endpoint};
use libp2p::multiaddr::Protocol;
use libp2p::swarm::behaviour::{ExpiredListenAddr, ExternalAddrConfirmed, ExternalAddrExpired};
use libp2p::swarm::handler::ConnectionEvent;
use libp2p::swarm::{
    ConnectionDenied, ConnectionHandler, ConnectionHandlerEvent, ConnectionId, FromSwarm, NetworkBehaviour,
    NotifyHandler, SubstreamProtocol, THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
};
use libp2p::{relay, Multiaddr, PeerId};

use crate::punch::GateIn;

/// Reservations and circuits held at once, the circuit lifetime (clients
/// renew), and the bytes one circuit may carry (design §1 rule 3).
pub const MAX_RESERVATIONS: usize = 8;
pub const MAX_CIRCUITS: usize = 16;
pub const CIRCUIT_DURATION: Duration = Duration::from_secs(120);
pub const MAX_CIRCUIT_BYTES: u64 = 8 << 20;
/// The daily cap's bounds and default, in MB (the core's `dailyCapMb`).
pub const MIN_DAILY_CAP_MB: u32 = 256;
pub const MAX_DAILY_CAP_MB: u32 = 51_200;
pub const DEFAULT_DAILY_CAP_MB: u32 = 2048;
/// A day, in seconds of wall-clock time.
const DAY: u64 = 24 * 3600;

/// Seconds since the Unix epoch.
fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Bytes relayed per day, charged per circuit (see the module docs). The day
/// is wall-clock time, and both numbers are kept in a file beside the store,
/// so a restart doesn't reset the cap.
#[derive(Debug)]
pub(crate) struct DailyBudget {
    cap: u64,
    used: u64,
    /// When the current day began (Unix seconds).
    since: u64,
    file: Option<PathBuf>,
}

impl DailyBudget {
    pub(crate) fn new(cap_mb: u32, now: u64) -> Self {
        DailyBudget { cap: cap_bytes(cap_mb), used: 0, since: now, file: None }
    }

    /// Kept in `file` from now on, starting from what it holds (if valid).
    pub(crate) fn keep_in(&mut self, file: PathBuf, now: u64) {
        let saved = std::fs::read_to_string(&file).ok().and_then(|text| {
            let mut parts = text.split_whitespace().map(str::parse::<u64>);
            Some((parts.next()?.ok()?, parts.next()?.ok()?))
        });
        // A clock set back keeps the saved day until it has passed: never less
        // than what was spent. A day starting more than a day from now can't
        // come from a clock set back: the file is damaged, and ignored.
        if let Some((since, used)) = saved.filter(|(since, _)| *since <= now + DAY) {
            self.since = since;
            self.used = used;
        }
        self.file = Some(file);
        self.roll(now);
    }

    fn save(&self) {
        if let Some(file) = &self.file {
            if let Err(err) = std::fs::write(file, format!("{} {}\n", self.since, self.used)) {
                tracing::warn!(%err, "member relay: the daily count wasn't saved");
            }
        }
    }

    pub(crate) fn set_cap(&mut self, cap_mb: u32) {
        self.cap = cap_bytes(cap_mb);
    }

    fn roll(&mut self, now: u64) {
        if now.saturating_sub(self.since) >= DAY {
            self.used = 0;
            self.since = now;
            self.save();
        }
    }

    /// Whether one more circuit fits today.
    pub(crate) fn has_room(&mut self, now: u64) -> bool {
        self.roll(now);
        self.used + MAX_CIRCUIT_BYTES <= self.cap
    }

    /// One accepted circuit: its full byte cap.
    pub(crate) fn charge(&mut self, now: u64) {
        self.roll(now);
        self.used = self.used.saturating_add(MAX_CIRCUIT_BYTES);
        self.save();
    }
}

fn cap_bytes(mb: u32) -> u64 {
    u64::from(mb.clamp(MIN_DAILY_CAP_MB, MAX_DAILY_CAP_MB)) << 20
}

type Inner = <relay::Behaviour as NetworkBehaviour>::ConnectionHandler;

/// A relay handler that runs only while open; closed, it offers no
/// protocol (`closed` is relay v2's own no-relay handler, asked for its
/// listen protocol) and is never polled.
pub(crate) struct RelayGate {
    inner: Inner,
    closed: Inner,
    open: bool,
}

impl ConnectionHandler for RelayGate {
    type FromBehaviour = GateIn<<Inner as ConnectionHandler>::FromBehaviour>;
    type ToBehaviour = <Inner as ConnectionHandler>::ToBehaviour;
    type InboundProtocol = <Inner as ConnectionHandler>::InboundProtocol;
    type OutboundProtocol = <Inner as ConnectionHandler>::OutboundProtocol;
    type InboundOpenInfo = <Inner as ConnectionHandler>::InboundOpenInfo;
    type OutboundOpenInfo = <Inner as ConnectionHandler>::OutboundOpenInfo;

    fn listen_protocol(&self) -> SubstreamProtocol<Self::InboundProtocol, Self::InboundOpenInfo> {
        if self.open {
            self.inner.listen_protocol()
        } else {
            self.closed.listen_protocol()
        }
    }

    fn on_behaviour_event(&mut self, event: Self::FromBehaviour) {
        match event {
            GateIn::Open => self.open = true,
            GateIn::Close => self.open = false,
            GateIn::Inner(event) => self.inner.on_behaviour_event(event),
        }
    }

    fn connection_keep_alive(&self) -> bool {
        self.open && self.inner.connection_keep_alive()
    }

    fn poll(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<ConnectionHandlerEvent<Self::OutboundProtocol, Self::OutboundOpenInfo, Self::ToBehaviour>> {
        if !self.open {
            // Woken again when a command (Open) arrives.
            return Poll::Pending;
        }
        self.inner.poll(cx)
    }

    fn poll_close(&mut self, cx: &mut Context<'_>) -> Poll<Option<Self::ToBehaviour>> {
        self.inner.poll_close(cx)
    }

    fn on_connection_event(
        &mut self,
        event: ConnectionEvent<Self::InboundProtocol, Self::OutboundProtocol, Self::InboundOpenInfo, Self::OutboundOpenInfo>,
    ) {
        self.inner.on_connection_event(event)
    }
}

/// `relay::Behaviour` behind member gates and a daily budget.
pub(crate) struct MemberRelay {
    inner: relay::Behaviour,
    /// `MemberRelay.effective`: relaying at all.
    enabled: bool,
    /// `MemberRelay.role`: an owner or admin relay.
    preferred: bool,
    budget: DailyBudget,
    /// Direct connections per peer (each with a gate), and the open ones.
    conns: HashMap<PeerId, HashSet<ConnectionId>>,
    opened: HashSet<ConnectionId>,
    /// Peers the node verified as bound current members.
    members: HashSet<PeerId>,
    /// Our direct listen addresses, handed to the relay for reservations.
    listen: Vec<Multiaddr>,
    queued: VecDeque<ToSwarm<relay::Event, THandlerInEvent<Self>>>,
    /// Circuits and reservations accepted since start (counts for logs).
    pub(crate) circuits: u64,
    pub(crate) reservations: u64,
}

pub(crate) fn config() -> relay::Config {
    relay::Config {
        max_reservations: MAX_RESERVATIONS,
        max_reservations_per_peer: 1,
        max_circuits: MAX_CIRCUITS,
        max_circuits_per_peer: 4,
        max_circuit_duration: CIRCUIT_DURATION,
        max_circuit_bytes: MAX_CIRCUIT_BYTES,
        ..relay::Config::default()
    }
}

impl MemberRelay {
    pub(crate) fn new(local: PeerId) -> Self {
        MemberRelay {
            inner: relay::Behaviour::new(local, config()),
            enabled: false,
            preferred: false,
            budget: DailyBudget::new(DEFAULT_DAILY_CAP_MB, unix_now()),
            conns: HashMap::new(),
            opened: HashSet::new(),
            members: HashSet::new(),
            listen: Vec::new(),
            queued: VecDeque::new(),
            circuits: 0,
            reservations: 0,
        }
    }

    /// From the core: relay or not, the daily cap (MB), and whether we are
    /// an owner or admin somewhere (`MemberRelay.role`). Off closes every
    /// gate (reservations and circuits stall, then time out).
    pub(crate) fn set(&mut self, on: bool, daily_cap_mb: u32, preferred: bool) {
        self.preferred = preferred;
        self.budget.set_cap(daily_cap_mb);
        if on != self.enabled {
            tracing::info!(on, "member relay");
        }
        self.enabled = on;
        self.refresh(unix_now());
    }

    /// Whether members should be told we relay: on, with budget left.
    pub(crate) fn offering(&mut self) -> bool {
        self.enabled && self.budget.has_room(unix_now())
    }

    /// An owner or admin relay (members try those first, design §2).
    pub(crate) fn preferred(&self) -> bool {
        self.preferred
    }

    /// Keeps the daily count in `file` (beside the store), starting from what
    /// it holds, so a restart doesn't reset the cap.
    pub(crate) fn keep_budget_in(&mut self, file: PathBuf) {
        self.budget.keep_in(file, unix_now());
        self.refresh(unix_now());
    }

    /// Off, keeping the cap (relay-only turned on).
    pub(crate) fn stop(&mut self) {
        if self.enabled {
            tracing::info!(on = false, "member relay");
        }
        self.enabled = false;
        self.refresh(unix_now());
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// Who is a bound current member now (the node checks every second).
    pub(crate) fn set_members(&mut self, members: HashSet<PeerId>) {
        if members != self.members {
            self.members = members;
            self.refresh(unix_now());
        }
    }

    /// Peers with a direct connection to us (the ones that could reserve).
    pub(crate) fn connected(&self) -> impl Iterator<Item = &PeerId> {
        self.conns.keys()
    }

    /// Opens exactly the gates that should be open: relaying, budget left,
    /// and the peer a member.
    fn refresh(&mut self, now: u64) {
        let room = self.enabled && self.budget.has_room(now);
        for (peer, conns) in &self.conns {
            let want = room && self.members.contains(peer);
            for id in conns {
                let is = self.opened.contains(id);
                if want && !is {
                    self.opened.insert(*id);
                    self.queued.push_back(ToSwarm::NotifyHandler { peer_id: *peer, handler: NotifyHandler::One(*id), event: GateIn::Open });
                } else if !want && is {
                    self.opened.remove(id);
                    self.queued.push_back(ToSwarm::NotifyHandler { peer_id: *peer, handler: NotifyHandler::One(*id), event: GateIn::Close });
                }
            }
        }
    }

    fn gate(&mut self, id: ConnectionId, peer: PeerId, relayed: bool, inner: Inner) -> RelayGate {
        // Relay v2's handler for a relayed connection (it never relays over
        // a relay): what a closed gate offers, which is nothing.
        let fake: Multiaddr = Multiaddr::empty().with(Protocol::P2pCircuit);
        let closed = self
            .inner
            .handle_established_inbound_connection(id, peer, &fake, &fake)
            .expect("relay v2 never refuses a relayed connection");
        if !relayed {
            self.conns.entry(peer).or_default().insert(id);
        }
        let gate = RelayGate { inner, closed, open: false };
        self.refresh(unix_now());
        gate
    }

    #[cfg(test)]
    pub(crate) fn is_open(&self, peer: &PeerId) -> bool {
        self.conns.get(peer).is_some_and(|c| c.iter().any(|id| self.opened.contains(id)))
    }
}

fn relayed(addr: &Multiaddr) -> bool {
    addr.iter().any(|p| p == Protocol::P2pCircuit)
}

impl NetworkBehaviour for MemberRelay {
    type ConnectionHandler = RelayGate;
    type ToSwarm = relay::Event;

    fn handle_pending_inbound_connection(
        &mut self,
        id: ConnectionId,
        local: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<(), ConnectionDenied> {
        self.inner.handle_pending_inbound_connection(id, local, remote)
    }

    fn handle_established_inbound_connection(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        local: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        let inner = self.inner.handle_established_inbound_connection(id, peer, local, remote)?;
        Ok(self.gate(id, peer, relayed(local) || relayed(remote), inner))
    }

    fn handle_pending_outbound_connection(
        &mut self,
        id: ConnectionId,
        peer: Option<PeerId>,
        addresses: &[Multiaddr],
        role: Endpoint,
    ) -> Result<Vec<Multiaddr>, ConnectionDenied> {
        self.inner.handle_pending_outbound_connection(id, peer, addresses, role)
    }

    fn handle_established_outbound_connection(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        addr: &Multiaddr,
        role: Endpoint,
        port_use: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        let inner = self.inner.handle_established_outbound_connection(id, peer, addr, role, port_use)?;
        Ok(self.gate(id, peer, relayed(addr), inner))
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        match &event {
            FromSwarm::ConnectionClosed(closed) => {
                self.opened.remove(&closed.connection_id);
                if let Some(conns) = self.conns.get_mut(&closed.peer_id) {
                    conns.remove(&closed.connection_id);
                    if conns.is_empty() {
                        self.conns.remove(&closed.peer_id);
                    }
                }
            }
            // The relay's addresses are our direct listen addresses (below),
            // never the swarm's external ones (our circuit through our relay).
            FromSwarm::ExternalAddrConfirmed(_) | FromSwarm::ExternalAddrExpired(_) => return,
            FromSwarm::NewListenAddr(new) if !relayed(new.addr) && !self.listen.contains(new.addr) => {
                let addr = new.addr.clone();
                self.inner.on_swarm_event(FromSwarm::ExternalAddrConfirmed(ExternalAddrConfirmed { addr: &addr }));
                self.listen.push(addr);
            }
            FromSwarm::ExpiredListenAddr(ExpiredListenAddr { addr, .. }) if self.listen.contains(addr) => {
                self.listen.retain(|a| a != *addr);
                self.inner.on_swarm_event(FromSwarm::ExternalAddrExpired(ExternalAddrExpired { addr }));
            }
            _ => {}
        }
        self.inner.on_swarm_event(event);
    }

    fn on_connection_handler_event(&mut self, peer: PeerId, id: ConnectionId, event: THandlerOutEvent<Self>) {
        self.inner.on_connection_handler_event(peer, id, event)
    }

    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        if let Some(event) = self.queued.pop_front() {
            return Poll::Ready(event);
        }
        match self.inner.poll(cx) {
            Poll::Ready(ToSwarm::GenerateEvent(event)) => {
                match &event {
                    relay::Event::CircuitReqAccepted { .. } => {
                        let now = unix_now();
                        self.circuits += 1;
                        self.budget.charge(now);
                        if !self.budget.has_room(now) {
                            tracing::info!("member relay: daily cap reached");
                            self.refresh(now);
                        }
                    }
                    relay::Event::ReservationReqAccepted { renewed: false, .. } => self.reservations += 1,
                    _ => {}
                }
                Poll::Ready(ToSwarm::GenerateEvent(event))
            }
            Poll::Ready(event) => Poll::Ready(event.map_in(GateIn::Inner)),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::core::UpgradeInfo;

    #[test]
    fn the_daily_budget_charges_whole_circuits_and_never_goes_over() {
        let now = unix_now();
        let mut budget = DailyBudget::new(MIN_DAILY_CAP_MB, now);
        let fits = (u64::from(MIN_DAILY_CAP_MB) << 20) / MAX_CIRCUIT_BYTES;
        for _ in 0..fits {
            assert!(budget.has_room(now));
            budget.charge(now);
        }
        assert!(!budget.has_room(now), "past the cap");
        assert!(budget.used <= u64::from(MIN_DAILY_CAP_MB) << 20);
        // A new day starts afresh.
        assert!(budget.has_room(now + DAY));
    }

    /// The Tech Lead on #395: a restart must not reset the daily cap.
    #[test]
    fn the_daily_count_survives_a_restart_and_a_new_day_clears_it() {
        let dir = std::env::temp_dir().join(format!("sync-relay-budget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("member-relay.budget");
        let now = 1_000_000;
        let mut first = DailyBudget::new(MIN_DAILY_CAP_MB, now);
        first.keep_in(file.clone(), now);
        while first.has_room(now) {
            first.charge(now);
        }
        // Restarted later the same day: still spent.
        let mut again = DailyBudget::new(MIN_DAILY_CAP_MB, now + 3600);
        again.keep_in(file.clone(), now + 3600);
        assert!(!again.has_room(now + 3600), "a restart reset the daily cap");
        assert_eq!(again.used, first.used);
        // A clock set back doesn't move the day forward or clear the count.
        let mut back = DailyBudget::new(MIN_DAILY_CAP_MB, now - 7200);
        back.keep_in(file.clone(), now - 7200);
        assert!(!back.has_room(now - 7200));
        // The next day, after a restart: room again, and saved as such.
        let mut tomorrow = DailyBudget::new(MIN_DAILY_CAP_MB, now + DAY);
        tomorrow.keep_in(file.clone(), now + DAY);
        assert!(tomorrow.has_room(now + DAY));
        let mut later = DailyBudget::new(MIN_DAILY_CAP_MB, now + DAY + 1);
        later.keep_in(file.clone(), now + DAY + 1);
        assert_eq!(later.used, 0);
        // A day start far in the future is damaged too (the Tech Lead, #399).
        std::fs::write(&file, format!("{} {}", now + 2 * DAY, 1u64 << 30)).unwrap();
        let mut future = DailyBudget::new(MIN_DAILY_CAP_MB, now);
        future.keep_in(file.clone(), now);
        assert_eq!((future.used, future.since), (0, now));
        // A damaged file is ignored (a fresh day), not trusted.
        std::fs::write(&file, "junk").unwrap();
        let mut fresh = DailyBudget::new(MIN_DAILY_CAP_MB, now);
        fresh.keep_in(file, now);
        assert_eq!(fresh.used, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cap_stays_within_the_core_bounds() {
        assert_eq!(cap_bytes(1), u64::from(MIN_DAILY_CAP_MB) << 20);
        assert_eq!(cap_bytes(u32::MAX), u64::from(MAX_DAILY_CAP_MB) << 20);
        assert_eq!(cap_bytes(DEFAULT_DAILY_CAP_MB), 2048 << 20);
        let mut budget = DailyBudget::new(DEFAULT_DAILY_CAP_MB, unix_now());
        budget.set_cap(MIN_DAILY_CAP_MB);
        assert_eq!(budget.cap, 256 << 20);
    }

    #[test]
    fn quotas_follow_the_design() {
        let c = config();
        assert_eq!((c.max_reservations, c.max_circuits), (8, 16));
        assert_eq!(c.max_circuit_duration, Duration::from_secs(120));
        assert_eq!(c.max_circuit_bytes, MAX_CIRCUIT_BYTES);
    }

    fn conn(n: usize) -> ConnectionId {
        ConnectionId::new_unchecked(n)
    }

    fn established(relay: &mut MemberRelay, n: usize, peer: PeerId) -> RelayGate {
        let local: Multiaddr = "/ip4/127.0.0.1/tcp/1".parse().unwrap();
        let remote: Multiaddr = "/ip4/127.0.0.1/tcp/2".parse().unwrap();
        relay.handle_established_inbound_connection(conn(n), peer, &local, &remote).unwrap()
    }

    fn drain(relay: &mut MemberRelay) -> Vec<(ConnectionId, bool)> {
        let mut out = Vec::new();
        while let Some(ToSwarm::NotifyHandler { handler: NotifyHandler::One(id), event, .. }) = relay.queued.pop_front() {
            match event {
                GateIn::Open => out.push((id, true)),
                GateIn::Close => out.push((id, false)),
                GateIn::Inner(_) => {}
            }
        }
        out
    }

    #[test]
    fn gates_open_only_for_members_while_relaying_with_budget_left() {
        let mut relay = MemberRelay::new(PeerId::random());
        let (member, stranger) = (PeerId::random(), PeerId::random());
        let mut gate = established(&mut relay, 1, member);
        established(&mut relay, 2, stranger);
        // Closed: no protocol offered, nothing polled.
        let none = gate.listen_protocol().upgrade().protocol_info().into_iter().count();
        assert_eq!(none, 0, "a closed gate offered the hop protocol");
        let mut cx = Context::from_waker(futures::task::noop_waker_ref());
        assert!(gate.poll(&mut cx).is_pending());

        // A member, but relaying is off: still closed.
        relay.set_members(HashSet::from([member]));
        assert!(drain(&mut relay).is_empty());
        relay.set(true, DEFAULT_DAILY_CAP_MB, false);
        assert_eq!(drain(&mut relay), vec![(conn(1), true)]);
        assert!(relay.is_open(&member) && !relay.is_open(&stranger));
        gate.on_behaviour_event(GateIn::Open);
        assert!(gate.listen_protocol().upgrade().protocol_info().into_iter().count() > 0, "an open gate offers hop");

        // No longer a member: closed again.
        relay.set_members(HashSet::new());
        assert_eq!(drain(&mut relay), vec![(conn(1), false)]);

        // Budget spent: every gate closes, even a member's.
        relay.set_members(HashSet::from([member]));
        drain(&mut relay);
        let now = unix_now();
        while relay.budget.has_room(now) {
            relay.budget.charge(now);
        }
        relay.refresh(now);
        assert_eq!(drain(&mut relay), vec![(conn(1), false)]);

        // Off: closed whatever the budget.
        let mut relay = MemberRelay::new(PeerId::random());
        established(&mut relay, 3, member);
        relay.set_members(HashSet::from([member]));
        relay.set(true, DEFAULT_DAILY_CAP_MB, false);
        drain(&mut relay);
        relay.set(false, DEFAULT_DAILY_CAP_MB, false);
        assert_eq!(drain(&mut relay), vec![(conn(3), false)]);
    }

    #[test]
    fn relayed_connections_get_no_relay() {
        let mut relay = MemberRelay::new(PeerId::random());
        let peer = PeerId::random();
        let circuit: Multiaddr = "/ip4/127.0.0.1/tcp/1/p2p-circuit".parse().unwrap();
        let remote: Multiaddr = "/ip4/127.0.0.1/tcp/2".parse().unwrap();
        relay.handle_established_inbound_connection(conn(9), peer, &circuit, &remote).unwrap();
        relay.set_members(HashSet::from([peer]));
        relay.set(true, DEFAULT_DAILY_CAP_MB, false);
        assert!(drain(&mut relay).is_empty());
    }
}
