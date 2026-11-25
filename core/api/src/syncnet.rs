//! [`Network`] over `sync::Node`: records reach other peers through the
//! relay (pull by have-markers, gossipsub push), so two users can exchange
//! them. The core's commands are synchronous, so the adapter owns a tokio
//! runtime and blocks on it.
//!
//! - Reads come from sync's own store, decoded again here (GAP-1): what
//!   `fetch` returns has passed `Record::decode` and sits in the right log.
//! - Node events are hints, never data, and nothing depends on them: the
//!   [`MemberGate`] ties each reject to the control log's count, and the
//!   data is always re-read from the store (so a `Lagged` loses nothing).
//! - Voice (piece A): [`VoiceNet`] over sync's `/mvs/voice/1`, members
//!   only. Received signals wait in a small queue (dropped when it is full:
//!   signals are best effort) for [`deliver_voice`] to hand to the core.
//! - TODO(#64): a node that won't start (the `node.key` ACL) must reach the
//!   user as an error or notice; today `SyncNetwork::start` fails and the
//!   sidecar exits with a log line.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libp2p::{Multiaddr, PeerId};
use records::{ChannelId, PublicKey, Record, RecordId, Scope, ServerId};
use sync::{log_name, log_of, Access, Node, NodeConfig, NodeEvent, ServerSecret, Store};
use tokio::runtime::Runtime;

use crate::access::{KeyBinder, MemberReadGate, MemberStubGate, NoticeKey};
use crate::gate::MemberGate;
use crate::ports::{DeviceLinkAddr, DeviceLinkError, DeviceLinkInbound, Network, Reach};
use crate::types::SendState;
use crate::voice::VoiceNet;
use crate::Core;

/// How long `fetch` waits for a server it has never seen to arrive, so a
/// join right after opening the log can find it.
const FIRST_FETCH_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(200);
/// Received voice signals waiting for the core; more are dropped. Sync
/// caps them at 80 at once and 10 a second from everyone together.
const VOICE_QUEUE: usize = 256;

/// A voice signal from sync: the sender's bound identity and the blob.
pub type VoiceSignal = (PublicKey, Vec<u8>);

/// G-29: received typing signals waiting for the core; more are dropped
/// (sync caps them at 30 at once and 10 a second from everyone).
const TYPING_QUEUE: usize = 64;

/// G-48: received report boxes waiting for the core. Sync acks a box only
/// once it is in here (a full queue: unacked, the sender retries); sync caps
/// them at 20 at once and 2 a second from everyone.
const REPORT_QUEUE: usize = 32;

/// A `--relay` address: a multiaddr that ends in `/p2p/<peer id>`, so Noise
/// checks it reached that very relay. Without the peer ID it would accept
/// whatever answers at the address (behind Cloudflare, anyone), so it is
/// refused (#114).
pub fn relay_addr(text: &str) -> Result<Multiaddr, String> {
    let addr: Multiaddr = text.parse().map_err(|_| "not a multiaddr".to_owned())?;
    match addr.iter().last() {
        Some(libp2p::multiaddr::Protocol::P2p(_)) => Ok(addr),
        _ => Err("must end in /p2p/<relay peer id>".to_owned()),
    }
}

/// Most relays a node is given (`--relay`, repeatable; multi-relay part A).
pub const MAX_RELAYS: usize = 4;

/// The relay list: 1 to [`MAX_RELAYS`] entries, each checked by
/// [`relay_addr`], no two for the same relay (peer ID), in the given order.
/// Errors never quote an address (they reach the log).
pub fn relay_addrs<S: AsRef<str>>(texts: &[S]) -> Result<Vec<Multiaddr>, String> {
    if texts.is_empty() {
        return Err("no relay".to_owned());
    }
    if texts.len() > MAX_RELAYS {
        return Err(format!("more than {MAX_RELAYS} relays"));
    }
    let mut out: Vec<Multiaddr> = Vec::with_capacity(texts.len());
    let mut ids = std::collections::HashSet::new();
    for (i, text) in texts.iter().enumerate() {
        let addr = relay_addr(text.as_ref()).map_err(|why| format!("relay {}: {why}", i + 1))?;
        let Some(libp2p::multiaddr::Protocol::P2p(id)) = addr.iter().last() else {
            unreachable!("relay_addr checked the /p2p suffix")
        };
        if !ids.insert(id) {
            return Err(format!("relay {}: the same relay twice", i + 1));
        }
        out.push(addr);
    }
    Ok(out)
}
type SendStates = Arc<Mutex<HashMap<RecordId, SendState>>>;

/// Send states kept; past this the delivered ones are forgotten.
const MAX_SEND_STATES: usize = 65_536;

/// Moves a record's state forward (pending, sent, received), never back.
/// True if it changed.
fn advance(states: &SendStates, id: RecordId, to: SendState) -> bool {
    let rank = |s: SendState| match s {
        SendState::Pending | SendState::Failed => 0,
        SendState::Sent => 1,
        SendState::Received => 2,
    };
    let mut states = states.lock().expect("not poisoned");
    let Some(now) = states.get_mut(&id) else { return false };
    if rank(to) <= rank(*now) {
        return false;
    }
    *now = to;
    true
}

pub struct SyncNetwork {
    runtime: Runtime,
    node: Node,
    store: PathBuf,
    /// Servers opened members-only (GAP-4), with the channels opened.
    opened: Mutex<HashMap<ServerId, BTreeSet<ChannelId>>>,
    /// Servers fetched at least once (the first fetch waits for the pull).
    fetched: Mutex<HashSet<ServerId>>,
    binder: Arc<KeyBinder>,
    /// Signs notice fetches with `w_n`, from unlock to lock.
    notice_key: Arc<NoticeKey>,
    /// B6: where each record written here stands.
    send_states: SendStates,
    hints: Mutex<Option<Receiver<()>>>,
    waker: SyncSender<()>,
    voice: Mutex<Option<Receiver<VoiceSignal>>>,
    /// G-29: typing signals, as voice.
    typing: Mutex<Option<Receiver<VoiceSignal>>>,
    /// G-48: report boxes, as voice.
    reports: Mutex<Option<Receiver<VoiceSignal>>>,
    /// T8-02: invite publications members pushed, until the core takes them.
    invite_pushes: InvitePushes,
    /// Device link (new device): what arrived on the link.
    link_inbox: LinkInbox,
    relay: Multiaddr,
}

type InvitePushes = Arc<Mutex<Vec<(ServerId, Vec<u8>)>>>;
/// Device link (new device): what arrived on the link, until the core takes it.
type LinkInbox = Arc<Mutex<Vec<DeviceLinkInbound>>>;
/// Inbound link messages kept (sync answers at most a few per link).
const LINK_INBOX: usize = 16;

fn link_error(err: sync::DeviceLinkError) -> DeviceLinkError {
    match err {
        sync::DeviceLinkError::NotFound => DeviceLinkError::NotFound,
        sync::DeviceLinkError::Network => DeviceLinkError::Network,
        sync::DeviceLinkError::Refused => DeviceLinkError::Refused,
    }
}

/// The peer of a device-link address (only the peer ID is used: sync dials
/// it through our own relay's circuit, whatever the address says).
fn link_peer(to: &DeviceLinkAddr) -> Result<PeerId, DeviceLinkError> {
    to.peer.parse().map_err(|_| DeviceLinkError::NotFound)
}
/// Pushed publications kept between two sync rounds; more are dropped (a
/// member re-announces when it binds again).
const INVITE_PUSH_QUEUE: usize = 1024;

impl SyncNetwork {
    /// Starts a node in `data_dir` (its `store.db` and `node.key`) that
    /// reaches peers through `relays` (see [`relay_addrs`]).
    pub fn start(
        relays: Vec<Multiaddr>,
        data_dir: &Path,
        gate: Arc<MemberGate>,
    ) -> anyhow::Result<Self> {
        Self::start_with_bootstrap(relays, Vec::new(), false, data_dir, gate)
    }

    /// Like [`SyncNetwork::start`], also dialling `bootstrap` directly (each
    /// checked by [`relay_addr`]): the relay's plain TCP address, so that
    /// identify observes our public address for hole punching (#219).
    /// `relay_only`: the stored setting ([`crate::stored_relay_only`]); the
    /// node starts with it, so a relay-only start never listens or dials
    /// directly.
    pub fn start_with_bootstrap(
        relays: Vec<Multiaddr>,
        bootstrap: Vec<Multiaddr>,
        relay_only: bool,
        data_dir: &Path,
        gate: Arc<MemberGate>,
    ) -> anyhow::Result<Self> {
        // Multi-relay part B: sync dials, reserves on and announces all of
        // them; the member relay fallback starts only when all are down.
        let Some(relay) = relays.first().cloned() else { anyhow::bail!("no relay") };
        let more_relays: Vec<Multiaddr> = relays.iter().skip(1).cloned().collect();
        let runtime =
            tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
        let relay_copy = relay.clone();
        let config = NodeConfig {
            relay: relay.clone(),
            more_relays,
            data_dir: data_dir.to_owned(),
            logs: Vec::new(),
            authorizer: gate,
            listen: "/ip4/0.0.0.0/tcp/0".parse().expect("valid multiaddr"),
            bootstrap,
            // F2: a direct LAN connection to a peer that proved it shares a
            // server with us (sync never takes LAN addresses from the DHT).
            allow_lan: true,
            // GAP-6r: relay-only from the first moment (no direct listener,
            // no bootstrap dial, no punching); `set_relay_only` toggles it
            // later.
            relay_only,
        };
        // GAP-4: our pulls carry bindings signed with the identity key (once
        // unlocked), and channel logs are served to members only.
        let binder = Arc::new(KeyBinder::locked());
        let access = Access {
            binder: Some(binder.clone()),
            read_gate: Some(Arc::new(MemberReadGate::new())),
            // B6-p: stubs only once a held, accepted delete or edit replaced
            // the record.
            stub_gate: Some(Arc::new(MemberStubGate)),
        };
        let (node, mut events) = runtime.block_on(Node::start_with(config, access))?;
        let notice_key = Arc::new(NoticeKey::default());
        node.set_notice_signer(Some(notice_key.clone()))?;
        // Relay-down resilience: co-members on this LAN find us by the
        // member-only beacon (it stays quiet while relay-only or "LAN
        // allowed" is off). The node works without it.
        if !runtime.block_on(node.start_lan_beacon(sync::LAN_BEACON_PORT)).unwrap_or(false) {
            eprintln!("mvs-core: no LAN beacon");
        }
        // Events are only hints: a stored record wakes the core's sync loop
        // (`Core::run_sync_loop`), which re-reads the store. Coalesced (one
        // pending hint is enough) and drained, so the node never blocks.
        let send_states: SendStates = Arc::default();
        let states = send_states.clone();
        let (hint, hints) = std::sync::mpsc::sync_channel(1);
        let waker = hint.clone();
        let (voice_tx, voice) = std::sync::mpsc::sync_channel(VOICE_QUEUE);
        let (typing_tx, typing) = std::sync::mpsc::sync_channel(TYPING_QUEUE);
        let (report_tx, reports) = std::sync::mpsc::sync_channel(REPORT_QUEUE);
        // G-48: boxes go straight to this queue, acked only once in it.
        node.set_report_sink(report_tx.clone())?;
        let invite_pushes: InvitePushes = Arc::default();
        let pushes = invite_pushes.clone();
        let link_inbox: LinkInbox = Arc::default();
        let inbox = link_inbox.clone();
        runtime.spawn(async move {
            while let Some(event) = events.recv().await {
                let wake = match event {
                    // T8-02: from a verified current member (sync checked);
                    // the core verifies the publication (C1) at its next round.
                    NodeEvent::InvitePublication { server, bytes, .. } => {
                        let mut queue = pushes.lock().expect("not poisoned");
                        if queue.len() < INVITE_PUSH_QUEUE {
                            queue.push((server, bytes));
                        }
                        true
                    }
                    // Voice: from a verified current member (sync checked);
                    // the core checks the envelope.
                    NodeEvent::VoiceSignal { from, bytes } => {
                        let _ = voice_tx.try_send((from, bytes));
                        false
                    }
                    // G-29: as voice.
                    NodeEvent::TypingSignal { from, bytes } => {
                        let _ = typing_tx.try_send((from, bytes));
                        false
                    }
                    // G-48: as voice; sync acked it already.
                    NodeEvent::ReportBox { from, bytes } => {
                        let _ = report_tx.try_send((from, bytes));
                        false
                    }
                    NodeEvent::Stored { .. } | NodeEvent::Lagged { .. } => true,
                    // B6: my messages' send state moves on; a round re-announces.
                    NodeEvent::Sent { id } => advance(&states, id, SendState::Sent),
                    NodeEvent::Delivered { id } => advance(&states, id, SendState::Received),
                    // M2: someone came online or left: a hint only; the core asks
                    // the node (`online`), so a dropped event loses nothing.
                    NodeEvent::Presence { .. } => true,
                    // Device link (new device): the core takes it at its next
                    // round (`device_link_take`).
                    NodeEvent::DeviceLink(inbound) => {
                        let mut queue = inbox.lock().expect("not poisoned");
                        if queue.len() < LINK_INBOX {
                            queue.push(match inbound {
                                sync::DeviceLinkInbound::Hello { e_old_pub } => DeviceLinkInbound::Hello { e_old_pub },
                                sync::DeviceLinkInbound::Sealed { ciphertext } => {
                                    DeviceLinkInbound::Sealed { ciphertext }
                                }
                            });
                        }
                        true
                    }
                    _ => false,
                };
                if wake {
                    let _ = hint.try_send(());
                }
            }
        });
        Ok(SyncNetwork {
            runtime,
            node,
            store: data_dir.join("store.db"),
            opened: Mutex::new(HashMap::new()),
            fetched: Mutex::new(HashSet::new()),
            binder,
            notice_key,
            send_states,
            hints: Mutex::new(Some(hints)),
            waker,
            voice: Mutex::new(Some(voice)),
            typing: Mutex::new(Some(typing)),
            reports: Mutex::new(Some(reports)),
            invite_pushes,
            link_inbox,
            relay: relay_copy,
        })
    }

    /// The voice signals for [`deliver_voice`] (once; `None` after).
    pub fn take_voice(&self) -> Option<Receiver<VoiceSignal>> {
        self.voice.lock().expect("not poisoned").take()
    }

    /// G-29: the typing signals for [`deliver_typing`] (once; `None` after).
    pub fn take_typing(&self) -> Option<Receiver<VoiceSignal>> {
        self.typing.lock().expect("not poisoned").take()
    }

    /// G-48: the report boxes for [`deliver_reports`] (once; `None` after).
    pub fn take_reports(&self) -> Option<Receiver<VoiceSignal>> {
        self.reports.lock().expect("not poisoned").take()
    }

    /// The hints for `Core::run_sync_loop` (once; `None` after).
    pub fn take_hints(&self) -> Option<Receiver<()>> {
        self.hints.lock().expect("not poisoned").take()
    }

    pub fn peer_id(&self) -> PeerId {
        self.node.peer_id()
    }

    /// Peers with a direct (not relayed) connection.
    pub fn direct_peers(&self) -> Vec<PeerId> {
        self.runtime.block_on(self.node.direct_peers()).unwrap_or_default()
    }

    /// Tests only: this node never dials a direct connection itself, so the
    /// other side's fallback dial makes the link.
    #[doc(hidden)]
    pub fn test_no_direct_dials(&self) {
        let _ = self.node.test_no_direct_dials();
    }

    /// Wakes the sync loop now, e.g. so it sees its stop flag.
    pub fn wake(&self) {
        let _ = self.waker.try_send(());
    }

    /// `peer`'s circuit through our relay (what sync dials for a device link).
    fn circuit_to(&self, peer: PeerId) -> String {
        use libp2p::multiaddr::Protocol;
        self.relay.clone().with(Protocol::P2pCircuit).with(Protocol::P2p(peer)).to_string()
    }

    /// Every record of `log` in sync's store, decoded again.
    fn read(&self, log: &str) -> Vec<Record> {
        let Ok(store) = Store::open_read_only(&self.store) else { return Vec::new() };
        let Ok((stored, _)) = store.missing_since(log, &[], usize::MAX, usize::MAX) else {
            return Vec::new();
        };
        stored
            .into_iter()
            .filter_map(|s| Record::decode(&s.bytes).ok())
            .filter(|r| log_of(r) == log)
            .collect()
    }
}

/// Hands each received voice signal to the core until the node stops.
/// Its own thread: the core may answer through [`VoiceNet::send`].
pub fn deliver_voice(signals: Receiver<VoiceSignal>, core: &Core) {
    for (from, blob) in signals {
        core.voice_received(Some(from), &blob);
    }
}

/// G-29: hands each received typing signal to the core, and runs its timers
/// about every second, until the node stops. Its own thread.
pub fn deliver_typing(signals: Receiver<VoiceSignal>, core: &Core) {
    loop {
        match signals.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok((from, blob)) => core.typing_received(Some(from), &blob),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
        core.typing_tick();
    }
}

/// G-48: hands each received report box to the core until the node stops.
/// Its own thread, which never waits on the network: sync acked each box
/// only once it was in this queue, so draining it promptly is what keeps
/// new boxes acked (the Tech Lead's #515 review).
pub fn deliver_reports(boxes: Receiver<VoiceSignal>, core: &Core) {
    for (from, sealed) in boxes {
        core.report_received(Some(from), &sealed);
    }
}

/// G-48: delivers my outbox about every 10 seconds, forever. Its own thread:
/// each delivery may wait up to 30 s for an ack.
pub fn run_report_outbox(core: &Core) {
    loop {
        core.report_tick();
        std::thread::sleep(std::time::Duration::from_secs(10));
    }
}

impl crate::report::ReportNet for SyncNetwork {
    /// `true` once the member's peer acked the box.
    fn deliver(&self, to: PublicKey, blob: Vec<u8>) -> bool {
        match self.runtime.block_on(self.node.report_send(to, blob)) {
            Ok(()) => true,
            Err(e) => {
                tracing::debug!(%e, "report box not delivered");
                false
            }
        }
    }
}

impl crate::typing::TypingNet for SyncNetwork {
    /// Best effort: no connected member peer bound to `to` drops it.
    fn send(&self, to: PublicKey, blob: Vec<u8>) {
        if let Err(e) = self.runtime.block_on(self.node.typing_send(to, blob)) {
            tracing::debug!(%e, "typing signal not sent");
        }
    }
}

impl VoiceNet for SyncNetwork {
    /// Best effort: a signal to an identity no connected member peer is
    /// bound to is dropped (the call's hellos and timeouts cover it).
    fn send(&self, to: PublicKey, blob: Vec<u8>) {
        if let Err(e) = self.runtime.block_on(self.node.voice_send(to, blob)) {
            tracing::debug!(%e, "voice signal not sent");
        }
    }
}

impl Network for SyncNetwork {
    fn link_counts(&self) -> Option<(usize, usize)> {
        let peers = self.runtime.block_on(self.node.peers()).ok()?.len();
        Some((peers, self.direct_peers().len()))
    }

    fn set_relay_only(&self, on: bool) {
        if let Err(e) = self.node.set_relay_only(on) {
            tracing::warn!(%e, "relay-only not applied");
        }
    }

    fn set_member_relay(&self, on: bool, daily_cap_mb: u32, role: bool) {
        if let Err(e) = self.node.set_member_relay(on, daily_cap_mb, role) {
            tracing::warn!(%e, "member relay setting not applied");
        }
    }

    /// The server must have been opened (`open_server`): logs are never
    /// opened by their plain names, which anyone could ask for (GAP-4).
    fn publish(&self, record: &Record) {
        let mut states = self.send_states.lock().expect("not poisoned");
        if states.len() >= MAX_SEND_STATES {
            states.retain(|_, s| *s != SendState::Received);
        }
        states.entry(record.id()).or_insert(SendState::Pending);
        drop(states);
        if let Err(e) = self.runtime.block_on(self.node.append(record.clone())) {
            eprintln!("mvs-core: sync didn't take a record: {e}");
        }
    }

    fn fetch(&self, server: ServerId) -> Vec<Record> {
        let log = log_name(server, Scope::Control);
        let first = self.fetched.lock().expect("not poisoned").insert(server);
        let mut records = self.read(&log);
        // A server seen for the first time: give the pull a moment.
        let deadline = Instant::now() + FIRST_FETCH_WAIT;
        while first && records.is_empty() && Instant::now() < deadline {
            std::thread::sleep(POLL);
            records = self.read(&log);
        }
        // And every channel opened for it.
        let channels = self.opened.lock().expect("not poisoned").get(&server).cloned();
        for channel in channels.unwrap_or_default() {
            records.extend(self.read(&log_name(server, Scope::Channel(channel))));
        }
        records
    }

    fn unlock(&self, key: &records::SigningKey) {
        self.binder.unlock(key);
    }

    fn lock(&self) {
        self.binder.lock();
        self.notice_key.lock();
    }

    /// Asked of the node each time (never mirrored from events, which can be
    /// dropped): who of `server` is bound and online now.
    fn online(&self, server: ServerId) -> Option<BTreeSet<PublicKey>> {
        self.presence(server).map(|reach| reach.online)
    }

    /// One node query for both: who is online, and whom we reach directly
    /// (#187).
    fn presence(&self, server: ServerId) -> Option<Reach> {
        match self.runtime.block_on(self.node.presence(server)) {
            Ok(state) => Some(Reach {
                online: state.online.into_iter().collect(),
                direct: state.direct.into_iter().collect(),
            }),
            Err(_) => Some(Reach::default()),
        }
    }

    fn send_state(&self, id: RecordId) -> Option<SendState> {
        self.send_states.lock().expect("not poisoned").get(&id).copied()
    }

    fn wake(&self) {
        SyncNetwork::wake(self);
    }

    fn prune(&self, id: records::RecordId) {
        if let Err(e) = self.runtime.block_on(self.node.prune(id)) {
            eprintln!("mvs-core: sync can't prune a record: {e}");
        }
    }

    fn serve_invite(&self, server: ServerId, handle: [u8; 32], publication: &[u8], announce: bool) -> bool {
        self.runtime
            .block_on(self.node.serve_invite(server, handle, publication.to_vec(), announce))
            .unwrap_or(false)
    }

    fn drop_invite(&self, handle: [u8; 32]) {
        let _ = self.node.drop_invite(handle);
    }

    fn drop_server_invites(&self, server: ServerId) {
        let _ = self.node.drop_server_invites(server);
    }

    fn fetch_invite(&self, handle: [u8; 32]) -> Vec<Vec<u8>> {
        self.runtime.block_on(self.node.fetch_invite(handle)).unwrap_or_default()
    }

    /// G-91: kept by this node (its own, announced as a DHT provider) and
    /// handed to the relay mailbox and my other connected devices. `tag` is
    /// the blob's own (sync checks it again).
    fn put_backup(&self, tag: [u8; 32], blob: &[u8]) {
        let _ = tag;
        if !self.runtime.block_on(self.node.put_backup(blob.to_vec())).unwrap_or(false) {
            eprintln!("mvs-core: sync refused the server backup");
        }
    }

    fn fetch_backup(&self, tag: [u8; 32]) -> Vec<Vec<u8>> {
        self.runtime.block_on(self.node.fetch_backup(tag)).unwrap_or_default()
    }

    fn put_notice(&self, blob: &[u8]) {
        if !self.runtime.block_on(self.node.put_notice(blob.to_vec())).unwrap_or(false) {
            eprintln!("mvs-core: sync refused the notice");
        }
    }

    /// Sync fetches under the unlocked `w_n`'s own tag: another `tag_n`
    /// gets nothing.
    fn fetch_notices(&self, tag_n: [u8; 32]) -> Vec<Vec<u8>> {
        use sync::NoticeSigner;
        if self.notice_key.key().map(|key| sync::notice_tag(&key)) != Some(tag_n) {
            return Vec::new();
        }
        self.runtime.block_on(self.node.fetch_notices()).unwrap_or_default()
    }

    fn notice_unlock(&self, w_n: &records::SigningKey) {
        self.notice_key.unlock(w_n);
    }

    fn device_link_open(&self, rv: [u8; 32], e_new_pub: [u8; 32]) -> Option<DeviceLinkAddr> {
        self.link_inbox.lock().expect("not poisoned").clear();
        let (peer, circuit) = self.runtime.block_on(self.node.device_link_open(rv, e_new_pub)).ok().flatten()?;
        Some(DeviceLinkAddr { peer: peer.to_base58(), circuit: circuit.to_string() })
    }

    fn device_link_close(&self) {
        let _ = self.node.device_link_close();
        self.link_inbox.lock().expect("not poisoned").clear();
    }

    fn device_link_take(&self) -> Vec<DeviceLinkInbound> {
        std::mem::take(&mut *self.link_inbox.lock().expect("not poisoned"))
    }

    fn device_link_find(&self, rv: [u8; 32]) -> Result<DeviceLinkAddr, DeviceLinkError> {
        let peer = self.runtime.block_on(self.node.device_link_find(rv)).map_err(link_error)?;
        Ok(DeviceLinkAddr { peer: peer.to_base58(), circuit: self.circuit_to(peer) })
    }

    fn device_link_hello(&self, to: &DeviceLinkAddr, e_old_pub: [u8; 32]) -> Result<[u8; 32], DeviceLinkError> {
        let peer = link_peer(to)?;
        self.runtime.block_on(self.node.device_link_hello(peer, e_old_pub)).map_err(link_error)
    }

    fn device_link_send(&self, to: &DeviceLinkAddr, ciphertext: &[u8]) -> Result<(), DeviceLinkError> {
        let peer = link_peer(to)?;
        self.runtime.block_on(self.node.device_link_send(peer, ciphertext.to_vec())).map_err(link_error)
    }
    fn take_invite_publications(&self) -> Vec<(ServerId, Vec<u8>)> {
        std::mem::take(&mut *self.invite_pushes.lock().expect("not poisoned"))
    }

    fn open_server(&self, server: ServerId, secret: &[u8; 32], channels: &BTreeSet<ChannelId>) {
        let mut opened = self.opened.lock().expect("not poisoned");
        let have = match opened.get_mut(&server) {
            Some(have) => have,
            None => {
                if let Err(e) = self.node.open_server(server, ServerSecret::from_bytes(*secret)) {
                    eprintln!("mvs-core: sync can't open a server: {e}");
                    return;
                }
                opened.entry(server).or_default()
            }
        };
        for channel in channels {
            if have.contains(channel) {
                continue;
            }
            match self.runtime.block_on(self.node.open_channel(server, *channel)) {
                Ok(()) => {
                    have.insert(*channel);
                }
                Err(e) => eprintln!("mvs-core: sync can't open a channel: {e}"),
            }
        }
    }

    /// Forgets that `server` is open here. TODO(server lifecycle, piece 3,
    /// dev-sync): `Node::close_server` unsubscribes its topics and drops its
    /// pending records; until then the node keeps its logs open (the core
    /// no longer reads them). It MUST flush our own unsent records first
    /// (the Tech Lead, #261): a dropped `Leave` keeps us in everyone's
    /// member list and nobody re-keys. The core only closes a left server
    /// after its `Leave` was delivered (the leave outbox).
    fn close_server(&self, server: ServerId) {
        self.opened.lock().expect("not poisoned").remove(&server);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use records::SigningKey;

    /// One node, no relay reachable: what it publishes comes back from
    /// `fetch` through sync's store, decoded, in its log.
    #[test]
    fn published_records_come_back_from_the_store() {
        let dir = std::env::temp_dir().join(format!("mvs-syncnet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let relay: Multiaddr =
            "/ip4/127.0.0.1/tcp/9/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc"
                .parse()
                .unwrap();
        let net = SyncNetwork::start(vec![relay], &dir, Arc::new(MemberGate::new())).unwrap();
        let owner = SigningKey::from_bytes(&[4; 32]);
        let genesis = authority::sign_genesis(&owner, [1; 16], 1, b"{}").unwrap();
        // GAP-4: nothing is synced, or published, for a server not opened.
        net.open_server(genesis.server(), &[7; 32], &BTreeSet::new());
        net.publish(&genesis);
        let other = ServerId::from_bytes([8; 32]);
        assert_eq!(net.read(&log_name(other, Scope::Control)), Vec::<Record>::new());
        let fetched = net.fetch(genesis.server());
        assert_eq!(fetched.iter().map(Record::id).collect::<Vec<_>>(), [genesis.id()]);
        drop(net);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// GAP-6r blocker 0 (#272): started with the stored relay-only setting,
    /// the node never listens directly and never dials its bootstrap
    /// address; started without it, it does listen (so the check means
    /// something).
    #[test]
    fn a_relay_only_start_makes_no_direct_listen_or_dial() {
        use libp2p::multiaddr::Protocol;
        use std::time::{Duration, Instant};

        let relay: Multiaddr =
            "/ip4/127.0.0.1/tcp/9/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc"
                .parse()
                .unwrap();
        let direct = |net: &SyncNetwork| -> Vec<Multiaddr> {
            let addrs = net.runtime.block_on(net.node.listen_addrs()).unwrap();
            addrs.into_iter().filter(|a| !a.iter().any(|p| p == Protocol::P2pCircuit)).collect()
        };
        let start = |name: &str, relay_only: bool, bootstrap: Vec<Multiaddr>| {
            let dir = std::env::temp_dir()
                .join(format!("mvs-syncnet-relayonly-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let net = SyncNetwork::start_with_bootstrap(
                vec![relay.clone()],
                bootstrap,
                relay_only,
                &dir,
                Arc::new(MemberGate::new()),
            )
            .unwrap();
            (net, dir)
        };

        // Without relay-only: a direct listener shows up.
        let (net, dir) = start("off", false, Vec::new());
        let since = Instant::now();
        while direct(&net).is_empty() {
            assert!(since.elapsed() < Duration::from_secs(10), "never listened directly");
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(net);
        let _ = std::fs::remove_dir_all(&dir);

        // Relay-only from the start: a bootstrap address that counts every
        // connection to it, and no direct listener at any point.
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.set_nonblocking(true).unwrap();
        let bootstrap: Multiaddr = format!(
            "/ip4/127.0.0.1/tcp/{}/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc",
            probe.local_addr().unwrap().port()
        )
        .parse()
        .unwrap();
        let (net, dir) = start("on", true, vec![bootstrap]);
        let since = Instant::now();
        while since.elapsed() < Duration::from_secs(3) {
            assert_eq!(direct(&net), Vec::<Multiaddr>::new(), "relay-only, yet listening directly");
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut dialled = 0;
        while probe.accept().is_ok() {
            dialled += 1;
        }
        assert_eq!(dialled, 0, "a relay-only start dialled its bootstrap address");
        drop(net);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod relay_tests {
    use super::{relay_addr, relay_addrs, MAX_RELAYS};

    const ID_A: &str = "12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc";
    const ID_B: &str = "12D3KooWAHoEkEqnKzM5PXFygh2movVBCSX3k8tDsT2cneU68Gyt";

    #[test]
    fn a_relay_list_has_one_to_four_distinct_checked_entries() {
        let a = format!("/dns4/relay.example.org/tcp/443/wss/p2p/{ID_A}");
        let b = format!("/dns4/relay2.example.org/tcp/443/wss/p2p/{ID_B}");
        // In order, as given.
        let got = relay_addrs(&[a.clone(), b.clone()]).unwrap();
        assert_eq!(got.iter().map(|m| m.to_string()).collect::<Vec<_>>(), [a.clone(), b.clone()]);
        assert_eq!(relay_addrs(&[a.as_str()]).unwrap().len(), 1);
        // Empty, a bad entry, too many.
        assert_eq!(relay_addrs::<&str>(&[]).unwrap_err(), "no relay");
        let err = relay_addrs(&[a.as_str(), "/dns4/relay3.example.org/tcp/443"]).unwrap_err();
        assert!(err.starts_with("relay 2:"), "{err}");
        let five: Vec<String> = (0..=MAX_RELAYS)
            .map(|i| format!("/ip4/127.0.0.1/tcp/{}/p2p/{ID_A}", 4000 + i))
            .collect();
        assert_eq!(relay_addrs(&five).unwrap_err(), format!("more than {MAX_RELAYS} relays"));
        // The same relay (peer ID) twice, even at another address.
        let a_tcp = format!("/dns4/relay.example.org/tcp/4001/p2p/{ID_A}");
        assert_eq!(relay_addrs(&[a.clone(), a_tcp]).unwrap_err(), "relay 2: the same relay twice");
        // Errors never quote the address.
        assert!(!err.contains("example.org"));
    }

    #[test]
    fn a_relay_must_name_its_peer_id() {
        let id = "12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc";
        assert!(relay_addr(&format!("/dns4/relay.example/tcp/443/p2p/{id}")).is_ok());
        assert!(relay_addr(&format!("/ip4/1.2.3.4/tcp/4001/p2p/{id}")).is_ok());
        for bad in [
            "/dns4/relay.example/tcp/443",
            "/ip4/1.2.3.4/tcp/4001",
            // A peer ID that isn't last doesn't pin the relay either.
            &format!("/p2p/{id}/ip4/1.2.3.4/tcp/4001"),
            "relay.example:443",
            "",
        ] {
            assert!(relay_addr(bad).is_err(), "{bad} should be refused");
        }
    }
}
