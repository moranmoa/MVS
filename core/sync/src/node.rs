//! A libp2p node that keeps a set of logs in sync with its peers.
//!
//! - Discovery: dial the bootstrap/relay node, then ask its Kademlia table
//!   for other peers and dial them (directly, or through the relay circuit).
//! - Pull: on connect and every few seconds, send `have` markers for each
//!   open log; the peer answers with what we're missing, in pages. Answers
//!   are computed on a blocking thread with a read-only store connection, so
//!   a large log never stalls the network task.
//! - Push: every new record is published on the log's gossipsub topic. A
//!   pushed record whose deps we lack waits in memory and triggers a pull.
//!
//! - Send states (B6): [`NodeEvent::Sent`] once one of our records left on a
//!   connection: it may have reached only a non-member relaying ciphertext.
//!   [`NodeEvent::Delivered`] once a member's node acked storing it. The
//!   receipt ack rides in pull answers, goes only to the record's bound
//!   author, and is never stored, synced, or used for authority, ordering
//!   or deletion: only for the author's tick. A false ack can only mislead
//!   that author's own UI.
//!
//! Every record from a peer goes through the ingest checks in the crate docs
//! (decode, derived log, deps in place, [`Authorizer`]) before it is stored,
//! forwarded on gossip or served to anyone. Every input is bounded: record
//! size, `have` list length, response pages (count and bytes), inbound pull
//! rate per peer and in total, concurrent answers, gossip message size and
//! topics, connections, and the pending-record buffer.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{bail, ensure, Context, Result};
use futures::StreamExt;
use libp2p::{
    connection_limits,
    core::{multiaddr::Protocol, transport::ListenerId, ConnectedPoint},
    gossipsub::{self, MaxCountSubscriptionFilter, MessageAcceptance, TopicHash, TopicSubscriptionFilter},
    identify, identity, kad, noise, ping, relay,
    request_response::{self, ProtocolSupport, ResponseChannel},
    swarm::{
        dial_opts::{DialOpts, PeerCondition},
        ConnectionId, NetworkBehaviour, SwarmEvent,
    },
    tcp, yamux, Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};

use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::access::{self, Binder, Binding, Handle, ReadGate, ServerSecret};
use crate::limits::{Acks, DialBackoff, Pending, PerIp, RateLimiter, Refused};
use crate::device_link::{Host as LinkHost, LinkError, Request as LinkRequest};
use crate::presence::Presence;
use crate::store::MAX_HAVE;
use crate::invite::InviteLimits;
use crate::report::{ReportError, ReportLimits, MAX_PENDING as MAX_REPORT_PENDING, MAX_REPORT_BLOB};
use crate::typing::{TypingError, TypingLimits, MAX_TYPING_BLOB};
use crate::voice_media::{SendQueue, VoiceFrame};
use crate::voice::{VoiceError, VoiceLimits, MAX_VOICE_BLOB};
use crate::{
    log_name, log_of, valid_log_name, Append, Authorizer, ChannelId, NoStubs, Record, RecordId, Scope, ServerId, Store,
    Stub, StubGate,
};
use records::PublicKey;

/// 0.3: logs of servers opened with a secret are named by handle, and pulls
/// for them carry a peer binding (GAP-4).
/// 0.4: pull answers carry tagged entries, full records or pruned stubs
/// (B6-p); 0.3 peers can't talk to 0.4 ones.
const SYNC_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/sync/0.4.0");
const IDENTIFY_VERSION: &str = "/mvs/0.1.0";
const KAD_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/kad/1.0.0");
/// Records per sync response page.
const PAGE: usize = 2000;
/// Record bytes per page. The CBOR codec drops responses over 10 MiB, so a
/// page must stay well below that.
const PAGE_BYTES: usize = 4 * 1024 * 1024;
const ANTI_ENTROPY: Duration = Duration::from_secs(5);
const DISCOVERY: Duration = Duration::from_secs(3);
/// Pushed records waiting for their deps (the pull fetches them anyway).
const MAX_PENDING: usize = 10_000;
const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;
const PENDING_TTL: Duration = Duration::from_secs(60);
/// Refused channel-record ids remembered, and how many of a log's go into
/// each pull's `have` list (out of [`MAX_HAVE`]).
const MAX_REFUSED: usize = 10_000;
const MAX_REFUSED_MARKERS: usize = 16;
/// Inbound pulls per peer: a burst, then a steady rate. A 100,000-message
/// catch-up is 50 pages, so this costs an honest peer about 2 s at most.
const PULL_BURST: u32 = 30;
const PULL_RATE: u32 = 10;
/// Inbound pulls from all peers together. PeerIds are free, so the per-peer
/// limit alone doesn't bound the work: each pull walks the log's ancestry.
const GLOBAL_PULL_BURST: u32 = 100;
const GLOBAL_PULL_RATE: u32 = 50;
/// Pulls being answered on blocking threads at once; more are dropped.
const MAX_ANSWERING: usize = 8;
/// Pulls out to one peer at once; more wait in `queued_pulls`. The answering
/// side reserves up to a page (`PAGE_BYTES`) of its per-peer served-bytes
/// budget (`SERVED_BYTES_BURST`) for each pull until the answer goes out, so
/// 3 stay under it: a burst of pulls is never refused for the budget.
const MAX_PULLS_IN_FLIGHT: usize = 3;
/// T24: outgoing pulls per peer: a burst, then a steady rate, under the
/// answering side's (`PULL_BURST` 30, `PULL_RATE` 10/s), so its limit never
/// refuses ours (a refused pull fails, isn't an empty answer, and is re-asked).
const OUT_PULL_BURST: u32 = 20;
const OUT_PULL_RATE: u32 = 8;
/// Most pulls `pull_all` sends one peer in one anti-entropy round: under the
/// answering side's burst (`PULL_BURST`) and what its rate (`PULL_RATE`)
/// refills between rounds, so a peer that holds none of our servers' logs
/// (and answers each at once, empty) is never pushed over its limit.
const PULLS_PER_PEER_ROUND: usize = 20;
/// The first round to a peer that just connected: small, since the round
/// timer, a relay reservation and the other side's own first round can all
/// land within the same few seconds.
const FIRST_CONTACT_PULLS: usize = 5;
/// T23 (GAP-4b, security lead): how long an unbound peer isn't asked again
/// for a control log it answered empty, and how often an unbound peer is
/// probed for a server we already have a bound member of. Each such pull
/// carries our binding to a peer that isn't known to be a member.
const UNBOUND_REPROBE: Duration = Duration::from_secs(600);
/// Most entries `empty_from` and `probed` each keep (security lead): peer IDs
/// are free, so churned peers can't grow them; the oldest goes first.
const MAX_T23_ENTRIES: usize = 10_000;
/// How a control log's name ends (`log_name`): queued first.
const CONTROL_SUFFIX: &str = "/control";
/// Per-peer pull buckets remembered (also after disconnecting).
const MAX_TRACKED_PEERS: usize = 4096;
/// Node events waiting for the app; beyond this, events are dropped and a
/// [`NodeEvent::Lagged`] follows.
const EVENT_BUFFER: usize = 65_536;
/// Largest gossipsub frame: one record plus signature, key and topic.
const MAX_GOSSIP_BYTES: usize = records::MAX_RECORD_BYTES + 4 * 1024;
/// Topics one remote peer may subscribe to, in total and per message.
const MAX_PEER_TOPICS: usize = 1024;
const MAX_TOPICS_PER_MESSAGE: usize = 128;
const MAX_INCOMING_CONNECTIONS: u32 = 256;
/// Peers hand us addresses to dial (Kademlia results, identify), so our own
/// dialling is capped as well.
const MAX_OUTGOING_CONNECTIONS: u32 = 128;
const MAX_CONNECTIONS: u32 = 384;
const MAX_PENDING_INCOMING: u32 = 64;
/// A direct and a relayed connection to the same peer coexist until the
/// relayed one ends (see `track_connection`), and two simultaneous dials can
/// add one more for a moment.
const MAX_CONNECTIONS_PER_PEER: u32 = 3;
/// Direct incoming connections from one IP address (IPv6: one /64). PeerIds are free to
/// make, so the per-peer cap alone doesn't stop one machine taking every
/// incoming slot. Relayed connections all come from the relay and aren't counted.
const MAX_CONNECTIONS_PER_IP: usize = 8;
/// Connections with nothing going on are closed after this long.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// How long [`Node::fetch_invite`] waits for answers (T8-02).
pub const INVITE_FETCH_WAIT: Duration = Duration::from_secs(3);
/// How long [`Node::fetch_backup`] waits for holders (a provider lookup and
/// circuit dials included).
pub const BACKUP_FETCH_WAIT: Duration = Duration::from_secs(3);
/// A provider lookup for one tag at most this often: a restore retries each
/// sync round, and the lookup is the slow part.
const BACKUP_LOOKUP_EVERY: Duration = Duration::from_secs(60);
/// Providers of a backup tag one fetch asks.
const MAX_BACKUP_PROVIDERS: usize = 8;
/// How long [`Node::fetch_notices`] waits for holders.
pub const NOTICE_FETCH_WAIT: Duration = Duration::from_secs(3);
/// Holders one notice fetch asks (Tech Lead: the first answer merged with
/// at most one more, not every holder).
const NOTICE_HOLDERS: usize = 2;
/// Peers one envelope fetch asks.
const MAX_FETCH_PEERS: usize = 16;
/// Traffic on every connection at least this often, well under the 100 s a
/// proxy like Cloudflare lets a WebSocket sit idle.
const PING_INTERVAL: Duration = Duration::from_secs(15);
/// A ping unanswered this long fails (the default is 20 s).
const PING_TIMEOUT: Duration = Duration::from_secs(10);
/// Our relay's connection is closed after this many failed pings in a row.
/// libp2p's ping no longer closes anything itself, and a connection that died
/// silently (a NAT entry gone, a laptop lid) would otherwise sit until
/// IDLE_TIMEOUT. Worst case [`relay_silent_for`]: within a minute, so the
/// member relay fallback (RELAY_DOWN_AFTER) starts from a real loss.
const RELAY_PING_MISSES: u32 = 2;

/// The longest our relay can stay silent before its connection is closed.
#[cfg(test)]
const fn relay_silent_for() -> Duration {
    Duration::from_secs((PING_INTERVAL.as_secs() + PING_TIMEOUT.as_secs()) * RELAY_PING_MISSES as u64)
}

/// One ping result from our relay: the misses in a row so far, and whether
/// to close the connection now.
fn relay_ping(misses: &mut u32, ok: bool) -> bool {
    if ok {
        *misses = 0;
        return false;
    }
    *misses += 1;
    if *misses >= RELAY_PING_MISSES {
        *misses = 0;
        return true;
    }
    false
}
/// Bytes of served pull pages: per peer, and for all peers together.
const SERVED_BYTES_BURST: u32 = 16 * 1024 * 1024;
const SERVED_BYTES_RATE: u32 = 2 * 1024 * 1024;
const ALL_SERVED_BYTES_BURST: u32 = 32 * 1024 * 1024;
const ALL_SERVED_BYTES_RATE: u32 = 8 * 1024 * 1024;
/// Below this much budget a pull is dropped rather than answered with a
/// sliver (a page always carries at least one record, up to ~19 KiB).
const MIN_PAGE_BUDGET: usize = 64 * 1024;
/// Our own bindings are signed for this long, and re-signed once less than
/// [`BINDING_RENEW`] is left. Under [`access::MAX_BINDING_TTL`].
const BINDING_TTL: Duration = Duration::from_secs(23 * 3600);
const BINDING_RENEW: Duration = Duration::from_secs(3600);
/// Receipt acks (B6): ids per answer, remembered per author, authors
/// remembered, and how long an ack waits for its author to pull.
const MAX_ACKS: usize = 256;
const ACKS_PER_AUTHOR: usize = 256;
const MAX_ACK_AUTHORS: usize = 4096;
const ACK_TTL: Duration = Duration::from_secs(600);
/// Our own records tracked until sent or delivered.
const MAX_OWN: usize = 10_000;
/// After writing, the log is pulled again this soon, to pick up acks.
const ACK_PULL: Duration = Duration::from_secs(1);
/// How long the larger peer ID waits for the smaller one to make the direct
/// connection before dialling itself (once).
const DIRECT_FALLBACK: Duration = Duration::from_secs(10);
/// Retries of a busy saved listen port before a random one (about 2 s).
const SAVED_PORT_TRIES: u32 = 8;
const SAVED_PORT_WAIT: Duration = Duration::from_millis(250);
/// Reachability is `Connecting` at most this long after starting.
const CONNECTING: Duration = Duration::from_secs(10);
/// Peers' stubs waiting for the delete or edit that replaced them.
const MAX_PENDING_STUBS: usize = 10_000;
/// Waits between relay dials while it is down: reconnects within a minute
/// of a relay restart (plus the discovery tick).
const RELAY_BACKOFF_MIN: Duration = Duration::from_secs(1);
const RELAY_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Re-dialling a peer from the DHT after failed dials (jittered): 5 s,
/// doubling to 5 min.
const DIAL_BACKOFF_MIN: Duration = Duration::from_secs(5);
const DIAL_BACKOFF_MAX: Duration = Duration::from_secs(300);
/// Addresses kept per relayed peer for a direct upgrade (F2).
const MAX_DIRECT_CANDIDATES: usize = 8;

pub struct NodeConfig {
    /// Bootstrap/relay node, ending in /p2p/<peer id>.
    pub relay: Multiaddr,
    /// More relays of ours (multi-relay part B, the api's `MVS_RELAY_ADDRS`
    /// after the first): each dialled, reserved on and announced like
    /// `relay`; the member relay fallback starts only when all are down.
    pub more_relays: Vec<Multiaddr>,
    /// Holds `store.db` and `node.key`.
    pub data_dir: PathBuf,
    /// Logs to sync from the start (see [`crate::log_name`]); more can be
    /// opened later.
    pub logs: Vec<String>,
    /// Decides whether a record's author may write it. Called on the node's
    /// task inside a store transaction: it must not call back into the node.
    pub authorizer: Arc<dyn Authorizer>,
    /// Where to listen; `/ip4/0.0.0.0/tcp/0` picks a free port.
    pub listen: Multiaddr,
    /// Peers to dial directly, without a peer ID (e.g. `/dns4/p2/tcp/4001`),
    /// besides those found through the relay. Redialled while not connected.
    pub bootstrap: Vec<Multiaddr>,
    /// F2 "LAN allowed": whether a LAN (or loopback) address a connected,
    /// bound peer reports may be dialled to turn a relayed connection into a
    /// direct one. LAN addresses never come from, or go to, the DHT.
    pub allow_lan: bool,
    /// "Relay only" (GAP-6) from the start: no direct listener (TCP or
    /// QUIC), no start-up dial of `bootstrap`, no hole punching. Only the
    /// relay connection and its circuits. The same as `Node::set_relay_only(true)`
    /// right after start, without the moment in between.
    pub relay_only: bool,
}

/// Who may read servers opened with [`Node::open_server`] (GAP-4). Without
/// a binder our pulls for those servers carry no binding (peers won't
/// answer them); without a read gate we answer nobody's channel pulls.
#[derive(Clone, Default)]
pub struct Access {
    /// Signs our peer bindings with the identity key.
    pub binder: Option<Arc<dyn Binder>>,
    /// Decides who may pull a server's channel logs.
    pub read_gate: Option<Arc<dyn ReadGate>>,
    /// Decides about pruned stubs (B6-p). Without one, stubs are never
    /// stored (peers' stubs stay pending until the full record comes).
    pub stub_gate: Option<Arc<dyn StubGate>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Via {
    Local,
    Push,
    Pull,
}

#[derive(Debug)]
pub enum NodeEvent {
    /// Boxed: events wait in a queue of up to 65,536 (keeps each slot small).
    Stored { log: String, record: Box<Record>, via: Via, at: SystemTime },
    PeerConnected(PeerId),
    PeerDisconnected(PeerId),
    /// The relay accepted our reservation: peers behind NAT can reach us
    /// through it now. Sent again after the relay restarts.
    RelayReserved,
    /// The app fell behind and `dropped` events were lost. The records are
    /// all in the store: re-read the open logs from there.
    Lagged { dropped: u64 },
    /// A record written here left this device on at least one connection
    /// (gossip, or a pull answer). It may have reached only a non-member
    /// relaying ciphertext: only [`NodeEvent::Delivered`] means a member has
    /// it. Sent once per record.
    Sent { id: RecordId },
    /// A member's node said it stored a record written here (receipt ack,
    /// B6/ש-11; servers opened with their secret only). The ack only drives
    /// this tick: it is never stored, synced, or used for authority,
    /// ordering or deletion. A false ack can only mislead the author's own
    /// UI. Sent once per record.
    Delivered { id: RecordId },
    /// A bound identity came online on, or went offline from, a server
    /// opened with its secret (M2). Anyone holding the secret can be bound:
    /// the app shows only members. Sent on changes only.
    Presence { server: ServerId, identity: PublicKey, online: bool },
    /// A peer's connection became direct, or relayed (a new relayed one
    /// while no direct one exists). Ask [`Node::presence`] again for the UI.
    Link { peer: PeerId, direct: bool },
    /// A voice signal (`/mvs/voice/1`) from a verified current member:
    /// `from` is the identity its peer is bound to. Ephemeral: never stored
    /// or forwarded. See `voice`.
    VoiceSignal { from: PublicKey, bytes: Vec<u8> },
    /// G-29: a typing signal (`/mvs/typing/1`) from a verified current
    /// member, as [`NodeEvent::VoiceSignal`]. Ephemeral. See `typing`.
    TypingSignal { from: PublicKey, bytes: Vec<u8> },
    /// G-48: a sealed report box (`/mvs/report/1`) from a verified current
    /// member, already acked. Opaque here: the api opens it. See `report`.
    ReportBox { from: PublicKey, bytes: Vec<u8> },
    /// G-81: a voice frame from a participant of my current call, past the
    /// gate, the caps and the sequence checks (`voice_media`).
    VoiceFrame { from: PublicKey, frame: VoiceFrame },
    /// G-81: how my voice frames reach a call peer now changed.
    VoicePath { identity: PublicKey, path: VoicePath },
    /// An invite publication (`/mvs/invite-pub/1`) from a verified current
    /// member of `server`, `from` its identity. Opaque here: the api
    /// verifies it (C1) and calls [`Node::serve_invite`] if it holds.
    InvitePublication { server: ServerId, from: PublicKey, bytes: Vec<u8> },
    /// Device link (new device): the signed-in device's Hello or its sealed
    /// transfer, already answered. See `device_link`.
    DeviceLink(crate::device_link::Inbound),
}

/// Presence on one server (M2). `online` holds bound identities (anyone
/// with the secret): the app shows only members.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceState {
    pub online: Vec<PublicKey>,
    /// Those of `online` we reach over a direct connection (LAN or, later,
    /// hole punching); the rest go through the relay. For the UI's
    /// connection-type indicator.
    pub direct: Vec<PublicKey>,
    /// The last time anyone of the server was seen online here.
    pub last_seen: Option<SystemTime>,
    pub reachability: Reachability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Reachability {
    /// Just started: not on the network yet (no relay reservation, no peer).
    Connecting,
    /// Someone of the server is online.
    Online,
    /// Nobody of the server is reachable *from here*: others may be online
    /// but out of reach (NAT, relay down).
    NobodyOnline,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogState {
    pub count: u64,
    pub hash: String,
    pub heads: usize,
}

enum Command {
    Append { record: Box<Record>, reply: oneshot::Sender<Result<()>> },
    Heads { log: String, reply: oneshot::Sender<Result<Vec<RecordId>>> },
    Open { log: String },
    OpenServer { server: ServerId, secret: Box<ServerSecret> },
    OpenChannel { server: ServerId, channel: ChannelId, reply: oneshot::Sender<Result<()>> },
    State { log: String, reply: oneshot::Sender<Result<LogState>> },
    Presence { server: ServerId, reply: oneshot::Sender<PresenceState> },
    Peers { reply: oneshot::Sender<Vec<PeerId>> },
    DirectPeers { reply: oneshot::Sender<Vec<PeerId>> },
    ListenAddrs { reply: oneshot::Sender<Vec<Multiaddr>> },
    RelayOnly { on: bool },
    NoDirectDials,
    NoHolePunch,
    MemberRelay { on: bool, daily_cap_mb: u32, preferred: bool },
    #[cfg(test)]
    Served { peer: PeerId, log: String, reply: oneshot::Sender<usize> },
    #[cfg(test)]
    RateLimited { reply: oneshot::Sender<usize> },
    #[cfg(test)]
    InboundPulls { reply: oneshot::Sender<usize> },
    #[cfg(any(test, feature = "test-util"))]
    Dial { addr: Multiaddr },
    #[cfg(any(test, feature = "test-util"))]
    Listen { addr: Multiaddr },
    #[cfg(any(test, feature = "test-util"))]
    MemberRelayCounts { reply: oneshot::Sender<(u64, u64)> },
    #[cfg(test)]
    Disconnect { peer: PeerId },
    Prune { id: RecordId, reply: oneshot::Sender<Result<bool>> },
    VoiceSend { to: PublicKey, bytes: Vec<u8>, reply: oneshot::Sender<Result<(), VoiceError>> },
    TypingSend { to: PublicKey, bytes: Vec<u8>, reply: oneshot::Sender<Result<(), TypingError>> },
    ReportSend { to: PublicKey, bytes: Vec<u8>, reply: oneshot::Sender<Result<(), ReportError>> },
    ReportSink { sink: std::sync::mpsc::SyncSender<(PublicKey, Vec<u8>)> },
    VoiceCall { call: Option<VoiceCall> },
    ServeInvite { server: ServerId, handle: [u8; 32], publication: Vec<u8>, announce: bool, reply: oneshot::Sender<bool> },
    DropInvite { handle: [u8; 32] },
    DropServerInvites { server: ServerId },
    FetchInvite { handle: [u8; 32], reply: oneshot::Sender<Vec<Vec<u8>>> },
    PutBackup { blob: Vec<u8>, reply: oneshot::Sender<bool> },
    FetchBackup { tag: [u8; 32], reply: oneshot::Sender<Vec<Vec<u8>>> },
    PutNotice { blob: Vec<u8>, reply: oneshot::Sender<bool> },
    FetchNotices { reply: oneshot::Sender<Vec<Vec<u8>>> },
    NoticeSigner { signer: Option<Arc<dyn crate::notice::NoticeSigner>> },
    LanBeacon { port: u16, reply: oneshot::Sender<bool> },
    LinkOpen { rv: [u8; 32], e_new_pub: [u8; 32], reply: oneshot::Sender<Option<(PeerId, Multiaddr)>> },
    LinkClose,
    LinkFind { rv: [u8; 32], reply: oneshot::Sender<Result<PeerId, LinkError>> },
    LinkRequest { peer: PeerId, request: crate::device_link::Request, reply: LinkReply },
    Shutdown { reply: oneshot::Sender<()> },
}

#[derive(Debug, Serialize, Deserialize)]
struct SyncRequest {
    /// The log's handle (`h/<hex>`) for a server opened with its secret;
    /// otherwise its plain name.
    log: String,
    have: Vec<ByteBuf>,
    /// Required for handles: who is asking.
    #[serde(default)]
    binding: Option<Binding>,
}

/// One entry of a pull answer (B6-p): a full record or a pruned stub, with
/// an explicit tag so neither is ever taken for the other (they also never
/// decode as each other).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum WireEntry {
    Full(ByteBuf),
    Stub(ByteBuf),
}

impl WireEntry {
    fn len(&self) -> usize {
        match self {
            WireEntry::Full(b) | WireEntry::Stub(b) => b.len(),
        }
    }
}

/// A pulled entry after decoding (and so verifying).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Incoming {
    Full(Record),
    Stub(Stub),
}

#[derive(Debug, Serialize, Deserialize)]
struct SyncResponse {
    /// Encoded records and stubs, in an order they can be appended in.
    records: Vec<WireEntry>,
    more: bool,
    /// Receipt acks (B6): ids of the requester's own records that we
    /// stored, at most [`MAX_ACKS`]. Only for a requester bound to their
    /// author.
    #[serde(default)]
    acks: Vec<ByteBuf>,
    /// Our binding for the server, when `acks` isn't empty: lets the author
    /// check that a member stored them.
    #[serde(default)]
    binding: Option<Binding>,
    /// Our direct (LAN) addresses, only to a member (F2): identify never
    /// carries them.
    #[serde(default)]
    direct_addrs: Vec<ByteBuf>,
    /// We relay for members (#368 slice 2): where to reach us, only to a
    /// member, never on identify or the DHT (design §1 rule 2).
    #[serde(default)]
    relay: Option<RelayOffer>,
}

/// A member relay's offer, in pull answers to members only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RelayOffer {
    /// Our direct listen addresses (at most `MAX_DIRECT_CANDIDATES`).
    addrs: Vec<ByteBuf>,
    /// An owner or admin relay: tried first.
    preferred: bool,
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    /// First: a connection it refuses (a device-link peer off the relay
    /// circuit) must reach no other behaviour. Behaviours are asked in field
    /// order, and one asked before a refusal keeps a connection the swarm
    /// never reports closed (request-response then trips over it).
    guard: DialGuard,
    /// Second, for the same reason: a connection over a limit is refused
    /// before any behaviour that keeps per-connection state saw it.
    limits: connection_limits::Behaviour,
    /// Member relays (`member_relay`): circuit relay v2 for bound current
    /// members only, off unless the core turns it on.
    member_relay: crate::member_relay::MemberRelay,
    relay_client: relay::client::Behaviour,
    identify: crate::announce::GlobalIdentify,
    ping: ping::Behaviour,
    kad: kad::Behaviour<kad::store::MemoryStore>,
    gossipsub: gossipsub::Behaviour<gossipsub::IdentityTransform, MaxCountSubscriptionFilter<LogTopics>>,
    sync: request_response::cbor::Behaviour<SyncRequest, SyncResponse>,
    /// Hole punching (DCUtR), with verified members only (`punch`).
    punch: crate::punch::MemberPunch,
    /// Voice signalling (`/mvs/voice/1`), with verified members only (`voice`).
    voice: crate::voice::VoiceBehaviour,
    /// G-29 typing (`/mvs/typing/1`), with verified members only (`typing`).
    typing: crate::typing::TypingBehaviour,
    /// G-48 report delivery (`/mvs/report/1`), with verified members only (`report`).
    report: crate::report::ReportBehaviour,
    /// G-81 voice media (`/mvs/voice-media/1`), per chosen connection (`voice_media`).
    voice_media: crate::voice_media::VoiceMedia,
    /// Invite publications between members (`/mvs/invite-pub/1`).
    invite_pub: crate::invite::PublishBehaviour,
    /// Envelope asks, from anyone (`/mvs/invite/1`).
    invite_ask: crate::invite::AskBehaviour,
    /// Server-list backups (`/mvs/backup/1`, G-91).
    backup: crate::backup::BackupBehaviour,
    /// Holder notice slot (`/mvs/notice/1`).
    notice: crate::notice::NoticeBehaviour,
    /// "Approve on your other device" (`/mvs/device-link/1`), relay circuit
    /// only (`device_link`).
    device_link: crate::device_link::LinkBehaviour,
}

type SharedBackoff = Arc<Mutex<DialBackoff<PeerId>>>;
/// Device-link peers: reached through relay circuits only. Shared with the
/// swarm's `DialGuard`, which refuses any other connection to them.
type LinkPeers = Arc<Mutex<HashSet<PeerId>>>;
type LinkReply = oneshot::Sender<Result<Vec<u8>, LinkError>>;

/// Refuses every outgoing connection to a peer that is still backing off
/// after failed dials, whoever asks: our discovery, or Kademlia's own lookups
/// (which otherwise asked the relay for a circuit to a gone peer every
/// round).
/// Also refuses any connection to or from a device-link peer that is not a
/// relay circuit (a direct dial, or a hole punch): the link stays relayed.
struct DialGuard {
    backoff: SharedBackoff,
    link_peers: LinkPeers,
}

impl DialGuard {
    fn circuit_only(&self, peer: &PeerId, relayed: bool) -> Result<(), libp2p::swarm::ConnectionDenied> {
        if !relayed && self.link_peers.lock().unwrap().contains(peer) {
            debug!(%peer, "device link: refusing a direct connection");
            return Err(libp2p::swarm::ConnectionDenied::new("device link peers are reached through the relay only"));
        }
        Ok(())
    }
}

fn has_circuit(addr: &Multiaddr) -> bool {
    addr.iter().any(|p| p == Protocol::P2pCircuit)
}

impl NetworkBehaviour for DialGuard {
    type ConnectionHandler = libp2p::swarm::dummy::ConnectionHandler;
    type ToSwarm = std::convert::Infallible;

    fn handle_pending_outbound_connection(
        &mut self,
        _: ConnectionId,
        peer: Option<PeerId>,
        _: &[Multiaddr],
        _: libp2p::core::Endpoint,
    ) -> Result<Vec<Multiaddr>, libp2p::swarm::ConnectionDenied> {
        match peer {
            Some(peer) if !self.backoff.lock().unwrap().may_dial(&peer, Instant::now()) => {
                Err(libp2p::swarm::ConnectionDenied::new("peer is backing off after failed dials"))
            }
            _ => Ok(Vec::new()),
        }
    }

    fn handle_established_inbound_connection(
        &mut self,
        _: ConnectionId,
        peer: PeerId,
        local: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<libp2p::swarm::THandler<Self>, libp2p::swarm::ConnectionDenied> {
        self.circuit_only(&peer, has_circuit(local) || has_circuit(remote))?;
        Ok(libp2p::swarm::dummy::ConnectionHandler)
    }

    fn handle_established_outbound_connection(
        &mut self,
        _: ConnectionId,
        peer: PeerId,
        addr: &Multiaddr,
        _: libp2p::core::Endpoint,
        _: libp2p::core::transport::PortUse,
    ) -> Result<libp2p::swarm::THandler<Self>, libp2p::swarm::ConnectionDenied> {
        self.circuit_only(&peer, has_circuit(addr))?;
        Ok(libp2p::swarm::dummy::ConnectionHandler)
    }

    fn on_swarm_event(&mut self, _: libp2p::swarm::FromSwarm) {}

    fn on_connection_handler_event(
        &mut self,
        _: PeerId,
        _: ConnectionId,
        event: libp2p::swarm::THandlerOutEvent<Self>,
    ) {
        match event {}
    }

    fn poll(
        &mut self,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<libp2p::swarm::ToSwarm<Self::ToSwarm, libp2p::swarm::THandlerInEvent<Self>>> {
        std::task::Poll::Pending
    }
}

/// Remote peers' subscriptions are only tracked for well-formed log topics
/// (`log/<name>` or a handle).
struct LogTopics;

impl TopicSubscriptionFilter for LogTopics {
    fn can_subscribe(&mut self, topic: &TopicHash) -> bool {
        log_of_topic(topic).is_some() || Handle::parse(topic.as_str()).is_some()
    }
}

fn log_of_topic(topic: &TopicHash) -> Option<&str> {
    topic.as_str().strip_prefix("log/").filter(|log| valid_log_name(log))
}

/// G-81: my current call, as the api tells it ([`Node::set_voice_call`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceCall {
    pub call_id: [u8; 16],
    /// Everyone in the call but me: the only ones whose frames are taken.
    pub participants: Vec<PublicKey>,
    /// The participants my frames go to over libp2p (not on LAN WebRTC).
    pub targets: Vec<PublicKey>,
}

/// G-81: how my frames reach a call peer (#509 §2.3, `path_to`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoicePath {
    Lan,
    Direct,
    Circuit,
    MemberCircuit,
    None,
}

/// G-81 caps (#509 §2.3, SL B2): frames per second from one peer, and from
/// all peers together; frames to send waiting in the node.
const VOICE_PER_PEER: u32 = 60;
const VOICE_ALL: u32 = 480;
const VOICE_FRAMES_IN: usize = 64;
/// Read frames waiting for the node, all substreams together.
const VOICE_READ_QUEUE: usize = 256;
/// SL (#530): a sequence further ahead of a sender's last than this is
/// refused (a jitter buffer must never be pushed that far).
const VOICE_SEQ_JUMP: u32 = 1 << 16;
/// A5: after a move to a better path, the old one also gets frames this
/// long (receivers drop duplicates by sequence), then stops.
const VOICE_OVERLAP: Duration = Duration::from_secs(1);

/// Handle to a running node. Dropping it does not stop the node; call
/// [`Node::shutdown`].
pub struct Node {
    peer_id: PeerId,
    commands: mpsc::UnboundedSender<Command>,
    /// G-81: frames to send, bounded; full drops the frame (`voice_frame`).
    voice_frames: mpsc::Sender<VoiceFrame>,
}

impl Node {
    /// Opens the store, starts networking and returns the handle plus a
    /// stream of events (records stored, peers connected).
    pub async fn start(config: NodeConfig) -> Result<(Node, mpsc::Receiver<NodeEvent>)> {
        Node::start_with(config, Access::default()).await
    }

    /// Like [`Node::start`], with who may read servers opened with a secret.
    pub async fn start_with(config: NodeConfig, access: Access) -> Result<(Node, mpsc::Receiver<NodeEvent>)> {
        for log in &config.logs {
            ensure!(valid_log_name(log), "invalid log name {log:?}");
        }
        std::fs::create_dir_all(&config.data_dir)?;
        let key = load_or_create_key(&config.data_dir.join("node.key"))?;
        let db = config.data_dir.join("store.db");
        let store = Store::open(&db)?;
        let reader = Arc::new(Mutex::new(Store::open_read_only(&db)?));
        let relay_peer = match config.relay.iter().last() {
            Some(Protocol::P2p(peer)) => peer,
            _ => bail!("the relay address must end with /p2p/<relay peer ID>"),
        };
        // Multi-relay (part B): our relays, the first one first; at most
        // MAX_RELAYS, one per peer ID.
        let mut relays = vec![OurRelay::new(config.relay.clone(), relay_peer)];
        for addr in &config.more_relays {
            let Some(Protocol::P2p(peer)) = addr.iter().last() else {
                bail!("a relay address must end with /p2p/<relay peer ID>")
            };
            if relays.len() < MAX_RELAYS && relays.iter().all(|r| r.peer != peer) {
                relays.push(OurRelay::new(addr.clone(), peer));
            }
        }
        let dropped = 1 + config.more_relays.len() - relays.len();
        if dropped > 0 {
            debug!(dropped, kept = relays.len(), "relay addresses dropped (duplicate peer or over the cap)");
        }

        let backoff: SharedBackoff =
            Arc::new(Mutex::new(DialBackoff::new(DIAL_BACKOFF_MIN, DIAL_BACKOFF_MAX, MAX_TRACKED_PEERS)));
        let relay_addrs: Vec<Multiaddr> = relays.iter().map(|r| r.addr.clone()).collect();
        let mut swarm = build_swarm(key, relay_addrs, backoff.clone(), config.allow_lan).await?;
        // Member relays: the daily count survives restarts (the Tech Lead, #395).
        swarm.behaviour_mut().member_relay.keep_budget_in(config.data_dir.join("member-relay.budget"));
        // A stable port: `listen` with TCP port 0 reuses the one saved in
        // `listen.port` (written on first start); if it is taken now, a random
        // one, and the saved one is kept for next time.
        let port_file = config.data_dir.join("listen.port");
        let listen = with_saved_port(&config.listen, &port_file);
        // After a quick restart (Windows especially) the old process may still
        // hold the port for a moment: try it for about 2 s before giving up on
        // it, so the port the user allowed in the firewall is kept.
        let mut attempt = 0;
        // Relay-only from the start: no direct listener at all (it comes up,
        // with QUIC beside it, if relay-only is turned off later).
        if config.relay_only {
            swarm.behaviour_mut().punch.set_enabled(false);
        }
        let (listener, listen) = loop {
            if config.relay_only {
                break (None, listen);
            }
            match swarm.listen_on(listen.clone()) {
                Ok(id) => break (Some(id), listen),
                Err(err) if listen != config.listen && attempt < SAVED_PORT_TRIES => {
                    attempt += 1;
                    debug!(%err, attempt, "the saved listen port is busy; trying again");
                    tokio::time::sleep(SAVED_PORT_WAIT).await;
                }
                Err(err) if listen != config.listen => {
                    warn!(%err, "the saved listen port is taken: listening on a random one this time");
                    break (Some(swarm.listen_on(config.listen.clone())?), config.listen.clone());
                }
                Err(err) => return Err(err.into()),
            }
        };
        // Bootstrap peers are dialled directly: not while relay-only (as in
        // `discover`), so a relay-only node's first dial is the relay's.
        if !config.relay_only {
            for addr in &config.bootstrap {
                let _ = swarm.dial(DialOpts::unknown_peer_id().address(addr.clone()).build());
            }
        }
        for relay in &relays {
            swarm.behaviour_mut().kad.add_address(&relay.peer, relay.addr.clone());
            let _ = swarm.dial(relay.addr.clone());
        }

        let peer_id = *swarm.local_peer_id();
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = mpsc::channel(EVENT_BUFFER);
        let (answers, answer_rx) = mpsc::unbounded_channel();
        let (decoded, decoded_rx) = mpsc::unbounded_channel();
        let (beacons, beacon_rx) = mpsc::channel(64);
        let (voice_frames, voice_frame_rx) = mpsc::channel(VOICE_FRAMES_IN);
        let (voice_in_tx, voice_in_rx) = mpsc::channel(VOICE_READ_QUEUE);
        let link_peers = swarm.behaviour().guard.link_peers.clone();
        let mut task = Task {
            swarm,
            store,
            reader,
            authorizer: config.authorizer,
            relays,
            logs: HashSet::new(),
            connected: HashSet::new(),
            inflight: HashMap::new(),
            decoding: HashSet::new(),
            again: HashSet::new(),
            pending: Pending::new(MAX_PENDING, MAX_PENDING_BYTES),
            refused: Refused::new(MAX_REFUSED),
            inbound_pulls: RateLimiter::new(PULL_BURST, PULL_RATE, MAX_TRACKED_PEERS),
            outbound_pulls: RateLimiter::new(OUT_PULL_BURST, OUT_PULL_RATE, MAX_TRACKED_PEERS),
            all_inbound_pulls: RateLimiter::new(GLOBAL_PULL_BURST, GLOBAL_PULL_RATE, 1),
            served_bytes: RateLimiter::new(SERVED_BYTES_BURST, SERVED_BYTES_RATE, MAX_TRACKED_PEERS),
            all_served_bytes: RateLimiter::new(ALL_SERVED_BYTES_BURST, ALL_SERVED_BYTES_RATE, 1),
            per_ip: PerIp::new(MAX_CONNECTIONS_PER_IP),
            answers,
            answering: 0,
            decoded,
            events: EventSink { tx: events, dropped: 0 },
            bootstrap: config.bootstrap.into_iter().map(|addr| (addr, None)).collect(),
            bootstrap_conns: HashMap::new(),
            allow_lan: config.allow_lan,
            relayed: HashMap::new(),
            direct: HashMap::new(),
            parked: HashMap::new(),
            secrets: HashMap::new(),
            sealing: Sealing::default(),
            stub_gate: access.stub_gate.clone().unwrap_or_else(|| Arc::new(NoStubs)),
            access,
            own_bindings: HashMap::new(),
            bound: HashMap::new(),
            unsent: HashSet::new(),
            own: HashSet::new(),
            acks: Acks::new(ACKS_PER_AUTHOR, MAX_ACK_AUTHORS, ACK_TTL),
            soon: HashSet::new(),
            direct_candidates: HashMap::new(),
            relay_only: config.relay_only,
            fallback_at: HashMap::new(),
            fallback_done: HashSet::new(),
            direct_dials: true,
            listen: listen.clone(),
            port_file,
            listener,
            quic_listener: None,
            relayed_preferred: HashSet::new(),
            dial_backoff: backoff,
            #[cfg(test)]
            served: HashMap::new(),
            #[cfg(test)]
            rate_limited: 0,
            queued_pulls: HashMap::new(),
            empty_from: HashMap::new(),
            probed: HashMap::new(),
            #[cfg(test)]
            pulls_received: 0,
            pull_round: 0,
            presence: Presence::default(),
            last_seen: HashMap::new(),
            reached: false,
            started: Instant::now(),
            pending_stubs: HashMap::new(),
            voice_limits: VoiceLimits::new(),
            typing_limits: TypingLimits::new(),
            report_limits: ReportLimits::new(),
            report_pending: HashMap::new(),
            report_sink: None,
            voice_call: None,
            voice_out: HashMap::new(),
            voice_in: HashMap::new(),
            voice_seq: HashMap::new(),
            voice_in_tx,
            voice_in_rx,
            voice_rate_peer: RateLimiter::new(VOICE_PER_PEER, VOICE_PER_PEER, MAX_TRACKED_PEERS),
            voice_rate_all: RateLimiter::new(VOICE_ALL, VOICE_ALL, 1),
            voice_rate_out: RateLimiter::new(VOICE_PER_PEER, VOICE_PER_PEER, MAX_TRACKED_PEERS),
            voice_conns: HashMap::new(),
            voice_paths: HashMap::new(),
            voice_dirty: false,
            invites: HashMap::new(),
            invite_limits: InviteLimits::new(),
            fetches: HashMap::new(),
            fetch_of: HashMap::new(),
            next_fetch: 0,
            backup_limits: crate::backup::BackupLimits::new(),
            backup_fetch_of: HashMap::new(),
            backup_lookups: HashMap::new(),
            backups_expired: Instant::now(),
            backup_looked_up: HashMap::new(),
            notice_limits: crate::notice::NoticeLimits::new(),
            notice_fetch_of: HashMap::new(),
            notice_signer: None,
            beacon: None,
            beacon_port: crate::lan_beacon::BEACON_PORT,
            beacons,
            beacon_limits: crate::lan_beacon::BeaconLimits::new(),
            beacon_next: Instant::now(),
            beacon_round: 0,
            tcp_port: None,
            link_host: None,
            link_peers,
            link_until: HashMap::new(),
            link_finds: HashMap::new(),
            link_waiting: Vec::new(),
            link_out: HashMap::new(),
            relay_offers: HashMap::new(),
            known_members: HashMap::new(),
            // Down until it holds our reservation (the fallback waits
            // RELAY_DOWN_AFTER, so a normal start never uses it).
            relay_lost_at: Some(Instant::now()),
            member_listeners: HashMap::new(),
            member_reserved: HashSet::new(),
            remembered_dialed: HashMap::new(),
            remembered_checked: Instant::now(),
            relay_ping_misses: HashMap::new(),
            member_relay_rest: HashMap::new(),
            fallback_dialed: HashMap::new(),
            fallback_dials: HashSet::new(),
        };
        // A relay-only start keeps no member addresses either (Security Lead).
        if task.relay_only {
            task.forget_remembered();
        }
        for log in config.logs {
            task.open(log, None);
        }
        tokio::spawn(task.run(command_rx, answer_rx, decoded_rx, beacon_rx, voice_frame_rx));
        Ok((Node { peer_id, commands, voice_frames }, event_rx))
    }

    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Stores and publishes a record written here. The caller signs it,
    /// usually on top of [`Node::heads`] of its log; it goes through the same
    /// checks as a record from a peer.
    pub async fn append(&self, record: Record) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Append { record: Box::new(record), reply })?;
        rx.await?
    }

    /// The current heads of a log: the deps for the next record written to it.
    pub async fn heads(&self, log: &str) -> Result<Vec<RecordId>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Heads { log: log.into(), reply })?;
        rx.await?
    }

    /// Starts syncing a log by its plain name (channel logs are only synced
    /// once opened). Anyone who knows the name can pull a log opened this
    /// way: use [`Node::open_server`] for real servers. Ignored for the logs
    /// of a server opened with its secret.
    pub fn open(&self, log: &str) -> Result<()> {
        ensure!(valid_log_name(log), "invalid log name {log:?}");
        self.send(Command::Open { log: log.into() })
    }

    /// Starts syncing a server's control log, members-only (GAP-4): its logs
    /// are named on the wire by handles derived from `secret`, its gossip is
    /// sealed, and its logs are served only to bound peers (channels: only
    /// those the read gate accepts).
    pub fn open_server(&self, server: ServerId, secret: ServerSecret) -> Result<()> {
        self.send(Command::OpenServer { server, secret: Box::new(secret) })
    }

    /// Starts syncing a channel of a server opened with [`Node::open_server`].
    pub async fn open_channel(&self, server: ServerId, channel: ChannelId) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::OpenChannel { server, channel, reply })?;
        rx.await?
    }

    pub async fn state(&self, log: &str) -> Result<LogState> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::State { log: log.into(), reply })?;
        rx.await?
    }

    /// Who is online on a server opened with its secret, and whether anyone
    /// is reachable (M2).
    pub async fn presence(&self, server: ServerId) -> Result<PresenceState> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Presence { server, reply })?;
        Ok(rx.await?)
    }

    /// Replaces a stored message or edit by its stub (B6-p), if the stub gate
    /// accepts it: a held, accepted delete or newer edit replaced it. True if
    /// pruned; from then on peers get the stub.
    pub async fn prune(&self, id: RecordId) -> Result<bool> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Prune { id, reply })?;
        rx.await?
    }

    /// The addresses the node listens on right now (empty until the listener
    /// is up; a relay circuit shows once reserved).
    /// Tests: how many entries our pull answers to `peer` for `log` carried.
    /// Tests: how many pull requests this node received.
    #[cfg(test)]
    async fn pulls_received(&self) -> usize {
        let (reply, rx) = oneshot::channel();
        self.send(Command::InboundPulls { reply }).unwrap();
        rx.await.unwrap()
    }

    /// Tests only: dial `addr` (a node met later than its bootstrap, or a
    /// direct dial the device-link guard must refuse).
    #[doc(hidden)]
    /// Tests only: listen on `addr` (a reservation on a member relay, until
    /// the client side of member relays lands).
    #[doc(hidden)]
    #[cfg(any(test, feature = "test-util"))]
    pub fn test_listen(&self, addr: Multiaddr) {
        let _ = self.send(Command::Listen { addr });
    }

    /// Tests only: reservations and circuits this node accepted as a member
    /// relay since it started.
    #[doc(hidden)]
    #[cfg(any(test, feature = "test-util"))]
    pub async fn test_member_relay_counts(&self) -> Result<(u64, u64)> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::MemberRelayCounts { reply })?;
        Ok(rx.await?)
    }

    #[cfg(any(test, feature = "test-util"))]
    pub fn test_dial(&self, addr: Multiaddr) {
        self.send(Command::Dial { addr }).unwrap();
    }

    /// Tests: close every connection to `peer` (as a relay circuit reset does).
    #[cfg(test)]
    fn test_disconnect(&self, peer: PeerId) {
        self.send(Command::Disconnect { peer }).unwrap();
    }

    /// Tests: how many inbound pulls this node refused (any of the three limits).
    #[cfg(test)]
    async fn rate_limited(&self) -> usize {
        let (reply, rx) = oneshot::channel();
        self.send(Command::RateLimited { reply }).unwrap();
        rx.await.unwrap()
    }

    #[cfg(test)]
    async fn served(&self, peer: PeerId, log: &str) -> usize {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Served { peer, log: log.into(), reply }).unwrap();
        rx.await.unwrap()
    }

    /// "Relay only" (GAP-6, a user setting): when on, the node stops listening
    /// for direct connections, never dials or upgrades to a direct one, and
    /// never shares direct addresses; peers reach it only through the relay,
    /// and nobody but the relay learns its IP. Connections that are already
    /// direct stay until they close.
    /// Tests only: this node never dials a direct connection itself (as if
    /// a firewall blocked it), so the other side's turn can be shown.
    #[doc(hidden)]
    pub fn test_no_direct_dials(&self) -> Result<()> {
        self.send(Command::NoDirectDials)
    }

    /// Member relays (design #368, slice 2): relay for bound current members
    /// of servers we share, or stop; `daily_cap_mb` is the core's
    /// `dailyCapMb`; `preferred`: an owner or admin relay (`MemberRelay.role`),
    /// which members try first. From `MemberRelay.effective` (#389). Never while
    /// relay-only.
    pub fn set_member_relay(&self, on: bool, daily_cap_mb: u32, preferred: bool) -> Result<()> {
        self.send(Command::MemberRelay { on, daily_cap_mb, preferred })
    }

    /// Tests only: no hole punching (DCUtR) from or with this node, so the
    /// F2 direct dial can be shown on its own.
    #[doc(hidden)]
    pub fn test_no_hole_punch(&self) -> Result<()> {
        self.send(Command::NoHolePunch)
    }

    pub fn set_relay_only(&self, on: bool) -> Result<()> {
        self.send(Command::RelayOnly { on })
    }

    pub async fn listen_addrs(&self) -> Result<Vec<Multiaddr>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::ListenAddrs { reply })?;
        Ok(rx.await?)
    }

    pub async fn peers(&self) -> Result<Vec<PeerId>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Peers { reply })?;
        Ok(rx.await?)
    }

    /// Peers with a direct (not relayed) connection.
    pub async fn direct_peers(&self) -> Result<Vec<PeerId>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::DirectPeers { reply })?;
        Ok(rx.await?)
    }

    /// Sends one voice signal (at most [`MAX_VOICE_BLOB`] bytes) to the
    /// peer bound to `to`, if `to` is a current member (see `voice`). Best
    /// effort: `Ok` means it went out, not that it arrived. Never stored.
    pub async fn voice_send(&self, to: PublicKey, bytes: Vec<u8>) -> Result<(), VoiceError> {
        if bytes.len() > MAX_VOICE_BLOB {
            return Err(VoiceError::TooLarge);
        }
        let (reply, rx) = oneshot::channel();
        self.send(Command::VoiceSend { to, bytes, reply }).map_err(|_| VoiceError::Stopped)?;
        rx.await.map_err(|_| VoiceError::Stopped)?
    }

    /// G-29: sends one typing signal (at most [`MAX_TYPING_BLOB`] bytes) to
    /// the peer bound to `to`, as [`Node::voice_send`]. Best effort.
    pub async fn typing_send(&self, to: PublicKey, bytes: Vec<u8>) -> Result<(), TypingError> {
        if bytes.len() > MAX_TYPING_BLOB {
            return Err(TypingError::TooLarge);
        }
        let (reply, rx) = oneshot::channel();
        self.send(Command::TypingSend { to, bytes, reply }).map_err(|_| TypingError::Stopped)?;
        rx.await.map_err(|_| TypingError::Stopped)?
    }

    /// G-48: delivers one sealed report box (at most [`MAX_REPORT_BLOB`]
    /// bytes) to the peer bound to `to` as a current member, and waits for
    /// its ack. `Ok` only once acked; the api's outbox keeps the row
    /// otherwise.
    pub async fn report_send(&self, to: PublicKey, bytes: Vec<u8>) -> Result<(), ReportError> {
        if bytes.len() > MAX_REPORT_BLOB {
            return Err(ReportError::TooLarge);
        }
        let (reply, rx) = oneshot::channel();
        self.send(Command::ReportSend { to, bytes, reply }).map_err(|_| ReportError::Stopped)?;
        rx.await.map_err(|_| ReportError::Stopped)?
    }

    /// G-48: received report boxes go into `sink` instead of the event
    /// stream (which may drop events when it lags). A box is acked only once
    /// it is in `sink`; while `sink` is full, boxes go unacked and their
    /// senders retry, so an acked box is never lost here.
    pub fn set_report_sink(&self, sink: std::sync::mpsc::SyncSender<(PublicKey, Vec<u8>)>) -> Result<()> {
        self.send(Command::ReportSink { sink })
    }

    /// Serves `publication` under the envelope handle `handle` for
    /// `server` (T8-02): answered to anyone who asks for exactly that
    /// handle (`/mvs/invite/1`). The api calls it only for an invite that
    /// is live and a publication it verified (C1), and drops it when the
    /// invite dies ([`Node::drop_invite`]). With `announce`, it also goes to
    /// the server's connected members now; members it binds later get every
    /// served publication of their server. False (nothing stored) when the
    /// handle is already served (first wins), the server isn't opened, it
    /// already has [`crate::MAX_INVITES_PER_SERVER`], or the publication is
    /// empty or over [`crate::MAX_INVITE_PUBLICATION`].
    pub async fn serve_invite(&self, server: ServerId, handle: [u8; 32], publication: Vec<u8>, announce: bool) -> Result<bool> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::ServeInvite { server, handle, publication, announce, reply })?;
        Ok(rx.await?)
    }

    /// Stops serving one envelope handle.
    pub fn drop_invite(&self, handle: [u8; 32]) -> Result<()> {
        self.send(Command::DropInvite { handle })
    }

    /// Stops serving every envelope of `server` (e.g. after its secret
    /// rotated: S5).
    pub fn drop_server_invites(&self, server: ServerId) -> Result<()> {
        self.send(Command::DropServerInvites { server })
    }

    /// Asks every connected peer for the envelope handle `handle` and
    /// returns the non-empty answers (at most one per peer) that came within
    /// [`crate::node::INVITE_FETCH_WAIT`]. Untrusted (C3): the caller tries
    /// each. Needs no server secret: a joiner asks before joining.
    pub async fn fetch_invite(&self, handle: [u8; 32]) -> Result<Vec<Vec<u8>>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::FetchInvite { handle, reply })?;
        Ok(rx.await?)
    }

    /// G-91: keeps my backup blob here (I hold my own, announced as a DHT
    /// provider of its tag) and hands it to the other holders: the relay
    /// (its mailbox) and my own other devices that are connected (peers
    /// bound to my identity). False, nothing kept or sent, if the blob
    /// fails [`crate::backup::check`]. Best effort; the api writes again on
    /// the next change, at login, and every 24 h.
    pub async fn put_backup(&self, blob: Vec<u8>) -> Result<bool> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::PutBackup { blob, reply })?;
        Ok(rx.await?)
    }

    /// G-91: every blob held under `tag`, here and by reachable holders:
    /// the relay, connected peers, and the DHT providers of the tag
    /// (dialled through our relay's circuit). Within
    /// [`crate::node::BACKUP_FETCH_WAIT`]. Untrusted: the api checks each.
    pub async fn fetch_backup(&self, tag: [u8; 32]) -> Result<Vec<Vec<u8>>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::FetchBackup { tag, reply })?;
        Ok(rx.await?)
    }

    /// Holder notice slot: keeps my notice here (announced under its tag)
    /// and hands it to the holders: my own other devices that are
    /// connected, and the relay. False, nothing kept or sent, if it fails
    /// `notice::check` (size, tag, signature, `at` at most a day ahead).
    /// Best effort.
    pub async fn put_notice(&self, blob: Vec<u8>) -> Result<bool> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::PutNotice { blob, reply })?;
        Ok(rx.await?)
    }

    /// Holder notice slot: the notices held for my tag, here and by at
    /// most two holders, each asked with a fetch signed by the
    /// [`crate::NoticeSigner`] (none sent without one, or while it is
    /// locked). Within [`crate::node::NOTICE_FETCH_WAIT`]. Untrusted: the
    /// core checks and opens each, removes duplicates by (`at`, hash) and
    /// ignores anything older than its last acknowledgement (holders can
    /// replay).
    pub async fn fetch_notices(&self) -> Result<Vec<Vec<u8>>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::FetchNotices { reply })?;
        Ok(rx.await?)
    }

    /// The core's `w_n` signer for notice fetches (None: no fetches).
    pub fn set_notice_signer(&self, signer: Option<Arc<dyn crate::NoticeSigner>>) -> Result<()> {
        self.send(Command::NoticeSigner { signer })
    }

    /// Starts the member-only LAN beacon (`lan_beacon`) on UDP `port`
    /// ([`crate::LAN_BEACON_PORT`] in the app): co-members on this LAN find
    /// us, and we them, with no relay. It sends and reads only while "LAN
    /// allowed" is on, relay-only is off and a server is open. False if the
    /// socket can't be had (the node works without it).
    pub async fn start_lan_beacon(&self, port: u16) -> Result<bool> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::LanBeacon { port, reply })?;
        Ok(rx.await?)
    }

    /// Closes all connections and the store.
    /// Device link, new device: opens (or replaces) the one link. We become
    /// a DHT provider of `rv` for [`crate::DEVICE_LINK_TTL`] and answer one
    /// signed-in device on `/mvs/device-link/1`: its Hello with `e_new_pub`.
    /// What arrives comes as [`NodeEvent::DeviceLink`]. While a link is open
    /// this node dials nobody directly and is reached by its link peer
    /// through the relay only. Our peer ID and relay circuit address (for
    /// the QR), or None without a relay reservation (try again later).
    pub async fn device_link_open(&self, rv: [u8; 32], e_new_pub: [u8; 32]) -> Result<Option<(PeerId, Multiaddr)>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::LinkOpen { rv, e_new_pub, reply })?;
        Ok(rx.await?)
    }

    /// Device link, new device: stops providing the rendezvous and answering.
    pub fn device_link_close(&self) -> Result<()> {
        self.send(Command::LinkClose)
    }

    /// Device link, signed-in device: who provides `rv` (a provider lookup,
    /// at most [`crate::DEVICE_LINK_FIND_WAIT`]).
    pub async fn device_link_find(&self, rv: [u8; 32]) -> Result<PeerId, LinkError> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::LinkFind { rv, reply }).map_err(|_| LinkError::Network)?;
        rx.await.unwrap_or(Err(LinkError::Network))
    }

    /// Device link, signed-in device: Hello to `peer` through our relay's
    /// circuit only; its `e_new_pub`.
    pub async fn device_link_hello(&self, peer: PeerId, e_old_pub: [u8; 32]) -> Result<[u8; 32], LinkError> {
        let answer = self.link_request(peer, LinkRequest::Hello(e_old_pub)).await?;
        answer.try_into().map_err(|_| LinkError::Refused)
    }

    /// Device link, signed-in device: the sealed transfer to the peer we
    /// said Hello to. Ok once it acknowledged receipt.
    pub async fn device_link_send(&self, peer: PeerId, ciphertext: Vec<u8>) -> Result<(), LinkError> {
        if ciphertext.is_empty() || ciphertext.len() >= crate::MAX_DEVICE_LINK {
            return Err(LinkError::Refused);
        }
        match self.link_request(peer, LinkRequest::Sealed(ciphertext)).await?.as_slice() {
            [1] => Ok(()),
            _ => Err(LinkError::Refused),
        }
    }

    async fn link_request(&self, peer: PeerId, request: LinkRequest) -> Result<Vec<u8>, LinkError> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::LinkRequest { peer, request, reply }).map_err(|_| LinkError::Network)?;
        rx.await.unwrap_or(Err(LinkError::Network))
    }

    pub async fn shutdown(self) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Shutdown { reply })?;
        Ok(rx.await?)
    }

    /// G-81: my current call, or none. From now on frames to or from anyone
    /// else, or under another call ID, are dropped; a new call ID starts
    /// every sender's sequence afresh.
    pub fn set_voice_call(&self, call: Option<VoiceCall>) -> Result<()> {
        self.send(Command::VoiceCall { call })
    }

    /// G-81: one of my frames, for every target of my current call. Never
    /// waits: a full queue drops it (counted, never logged).
    pub fn voice_frame(&self, frame: VoiceFrame) {
        if self.voice_frames.try_send(frame).is_err() {
            crate::voice_media::DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands.send(command).ok().context("node has stopped")
    }
}

fn load_or_create_key(path: &std::path::Path) -> Result<identity::Keypair> {
    if let Ok(bytes) = std::fs::read(path) {
        crate::keyfile::tighten(path)?;
        return Ok(identity::Keypair::from_protobuf_encoding(&bytes)?);
    }
    let key = identity::Keypair::generate_ed25519();
    crate::keyfile::write_secret(path, &key.to_protobuf_encoding()?)?;
    Ok(key)
}

async fn build_swarm(
    key: identity::Keypair,
    relay: Vec<Multiaddr>,
    backoff: SharedBackoff,
    allow_lan: bool,
) -> Result<Swarm<Behaviour>> {
    Ok(SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(tcp::Config::default().nodelay(true), noise::Config::new, yamux::Config::default)?
        // QUIC beside TCP (`/udp/<port>/quic-v1`): its dials leave from the
        // listening socket, so hole punching works where TCP simultaneous
        // open does not (Windows).
        .with_quic()
        .with_dns()?
        // `/dns4/<relay>/tcp/443/wss`: the relay sits behind a TLS-terminating
        // proxy (Cloudflare). Ping (every 15 s) keeps such a connection under
        // the proxy's 100 s idle timeout.
        .with_websocket(noise::Config::new, yamux::Config::default)
        .await?
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(|key, relay_client| {
            let peer_id = key.public().to_peer_id();
            // Our own protocol name, not the public IPFS DHT's `/ipfs/kad/1.0.0`
            // (threat model R2); the relay speaks it too.
            let mut kad_config = kad::Config::new(KAD_PROTOCOL);
            // G-91: backup holders re-announce themselves this often (design §2).
            kad_config.set_provider_publication_interval(Some(crate::backup::REANNOUNCE));
            let mut kad = kad::Behaviour::with_config(peer_id, kad::store::MemoryStore::new(peer_id), kad_config);
            // Server mode so peers can find each other through any peer, not
            // only through the bootstrap node. (GAP-6 moves this to client mode.)
            kad.set_mode(Some(kad::Mode::Server));
            let gossip_config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_millis(500))
                .max_transmit_size(MAX_GOSSIP_BYTES)
                // Forward a message only after it passed the ingest checks
                // (see `on_gossip`), so junk doesn't travel further through us.
                .validate_messages()
                // Dedup by content, not by (source, seqno): the same record
                // republished by another peer or with a new seqno is one message.
                .message_id_fn(|m| {
                    let mut hasher = blake3::Hasher::new();
                    hasher.update(m.topic.as_str().as_bytes());
                    hasher.update(&[0]);
                    hasher.update(&m.data);
                    gossipsub::MessageId::from(hasher.finalize().as_bytes().to_vec())
                })
                // TODO: enable peer scoring so `MessageAcceptance::Reject`
                // costs the sender something; today it only stops forwarding.
                .build()
                .map_err(|e| anyhow::anyhow!(e))?;
            let gossipsub = gossipsub::Behaviour::new_with_subscription_filter(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossip_config,
                MaxCountSubscriptionFilter {
                    filter: LogTopics,
                    max_subscribed_topics: MAX_PEER_TOPICS,
                    max_subscriptions_per_request: MAX_TOPICS_PER_MESSAGE,
                },
            )
            .map_err(|e| anyhow::anyhow!(e))?;
            let limits = connection_limits::ConnectionLimits::default()
                .with_max_established_incoming(Some(MAX_INCOMING_CONNECTIONS))
                .with_max_pending_incoming(Some(MAX_PENDING_INCOMING))
                .with_max_established_per_peer(Some(MAX_CONNECTIONS_PER_PEER))
                .with_max_established_outgoing(Some(MAX_OUTGOING_CONNECTIONS))
                .with_max_established(Some(MAX_CONNECTIONS));
            Ok(Behaviour {
                relay_client,
                // Push address changes (e.g. a new relay circuit) to peers at
                // once instead of waiting for the next identify round.
                // Only global addresses and circuits through our relay are
                // announced (GAP-6); direct ones go to members only.
                identify: crate::announce::GlobalIdentify::new(
                    identify::Behaviour::new(
                        identify::Config::new(IDENTIFY_VERSION.into(), key.public()).with_push_listen_addr_updates(true),
                    ),
                    relay,
                ),
                ping: ping::Behaviour::new(ping::Config::new().with_interval(PING_INTERVAL).with_timeout(PING_TIMEOUT)),
                kad,
                gossipsub,
                sync: request_response::cbor::Behaviour::new(
                    [(SYNC_PROTOCOL, ProtocolSupport::Full)],
                    request_response::Config::default().with_request_timeout(Duration::from_secs(30)),
                ),
                limits: connection_limits::Behaviour::new(limits),
                guard: DialGuard { backoff, link_peers: LinkPeers::default() },
                member_relay: crate::member_relay::MemberRelay::new(peer_id),
                punch: crate::punch::MemberPunch::new(peer_id, allow_lan),
                voice: crate::voice::behaviour(),
                typing: crate::typing::behaviour(),
                report: crate::report::behaviour(),
                voice_media: crate::voice_media::VoiceMedia::default(),
                invite_pub: crate::invite::publish_behaviour(),
                invite_ask: crate::invite::ask_behaviour(),
                backup: crate::backup::behaviour(),
                notice: crate::notice::behaviour(),
                device_link: crate::device_link::behaviour(),
            })
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(IDLE_TIMEOUT))
        .build())
}

/// The gossip topic for a log's wire name: the handle itself, or
/// `log/<name>` for a log opened by its plain name.
fn topic(wire: &str) -> gossipsub::IdentTopic {
    if Handle::parse(wire).is_some() {
        gossipsub::IdentTopic::new(wire)
    } else {
        gossipsub::IdentTopic::new(format!("log/{wire}"))
    }
}

/// A log of a server opened with its secret.
struct Sealed {
    server: ServerId,
    scope: Scope,
    handle: Handle,
    /// Seals the log's gossip.
    key: Zeroizing<[u8; 32]>,
}

/// How open logs are named on the wire: by handle for servers opened with
/// a secret, by plain name otherwise.
#[derive(Default)]
struct Sealing {
    by_log: HashMap<String, Sealed>,
    /// Handle (`h/<hex>`) → log name.
    by_wire: HashMap<String, String>,
}

impl Sealing {
    fn insert(&mut self, log: String, sealed: Sealed) {
        self.by_wire.insert(sealed.handle.wire(), log.clone());
        self.by_log.insert(log, sealed);
    }

    fn get(&self, log: &str) -> Option<&Sealed> {
        self.by_log.get(log)
    }

    /// The name a log goes by on the wire (pull requests, gossip topic).
    fn wire(&self, log: &str) -> String {
        self.by_log.get(log).map_or_else(|| log.to_string(), |s| s.handle.wire())
    }

    /// The log a handle names, if we hold it.
    fn log_of_wire(&self, wire: &str) -> Option<&str> {
        self.by_wire.get(wire).map(String::as_str)
    }
}

/// `base` ± 20 %, from a random `r`: after a relay restart its clients
/// don't all redial in the same instant.
fn jittered(base: Duration, r: u32) -> Duration {
    base.mul_f64(0.8 + 0.4 * f64::from(r) / f64::from(u32::MAX))
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The read gate's check for one channel pull, run on the answering thread.
struct ReadCheck {
    gate: Arc<dyn ReadGate>,
    identity: PublicKey,
    server: ServerId,
}

impl ReadCheck {
    fn allows(&self, store: &Store) -> bool {
        self.gate.may_read(&self.identity, &store.control_log(self.server))
    }
}

/// A finished answer: who asked, where to reply, the page, and the bytes
/// reserved for it when the request came in.
type Answer = (PeerId, ResponseChannel<SyncResponse>, SyncResponse, usize, Vec<RecordId>, String);
/// A pulled page after decoding: (peer, log), the records that verified
/// and belong to the log, and whether the peer said there is more.
type Decoded = ((PeerId, String), Vec<Incoming>, bool, Vec<RecordId>);

struct Task {
    swarm: Swarm<Behaviour>,
    store: Store,
    /// Read-only connection used by blocking threads to answer pulls.
    reader: Arc<Mutex<Store>>,
    authorizer: Arc<dyn Authorizer>,
    logs: HashSet<String>,
    connected: HashSet<PeerId>,
    /// Pulls waiting for a response.
    inflight: HashMap<request_response::OutboundRequestId, (PeerId, String)>,
    /// Pulled pages being decoded; a pull for these waits like one in flight.
    decoding: HashSet<(PeerId, String)>,
    /// Pulls asked for while one was in flight: run again after it.
    again: HashSet<(PeerId, String)>,
    /// Pushed records waiting for a dep.
    pending: Pending,
    /// Channel records refused by the authorizer (or built only on refused ones).
    refused: Refused,
    inbound_pulls: RateLimiter<PeerId>,
    /// T24: our pulls per peer (`OUT_PULL_BURST`, `OUT_PULL_RATE`).
    outbound_pulls: RateLimiter<PeerId>,
    all_inbound_pulls: RateLimiter<()>,
    /// Byte budgets for served pages (tokens are bytes).
    served_bytes: RateLimiter<PeerId>,
    all_served_bytes: RateLimiter<()>,
    /// Direct incoming connections per remote IP (IPv6: per /64).
    per_ip: PerIp,
    /// Finished answers coming back from blocking threads.
    answers: mpsc::UnboundedSender<Answer>,
    answering: usize,
    /// Pulled pages coming back from decoding on blocking threads.
    decoded: mpsc::UnboundedSender<Decoded>,
    events: EventSink,
    /// Our relays (multi-relay part B), the configured first one first:
    /// each with its circuit listener and redial backoff.
    relays: Vec<OurRelay>,
    /// Bootstrap addresses and the peer each one turned out to be.
    bootstrap: Vec<(Multiaddr, Option<PeerId>)>,
    /// Open connections we dialled at a bootstrap address, by address. The
    /// relay itself can be a bootstrap (its plain TCP address, so identify
    /// observes our public address for hole punching): it is never "direct",
    /// so this is what stops redialling it every discovery round.
    bootstrap_conns: HashMap<ConnectionId, Multiaddr>,
    allow_lan: bool,
    /// Open connections per peer, through the relay and direct. A peer with
    /// a direct connection is not in `relayed`, even while its old relayed
    /// connection is still open.
    relayed: HashMap<PeerId, HashSet<ConnectionId>>,
    direct: HashMap<PeerId, HashSet<ConnectionId>>,
    /// Relayed connections still open alongside a direct one: the link
    /// again if the direct one closes first.
    parked: HashMap<PeerId, HashSet<ConnectionId>>,
    /// Servers opened with their secret.
    secrets: HashMap<ServerId, ServerSecret>,
    sealing: Sealing,
    access: Access,
    /// Our signed bindings, per server.
    own_bindings: HashMap<ServerId, Binding>,
    /// Peers' verified bindings, per server; dropped when the peer
    /// disconnects.
    bound: HashMap<(PeerId, ServerId), (Binding, PublicKey)>,
    /// Our records not yet sent anywhere, and not yet delivered (B6).
    unsent: HashSet<RecordId>,
    own: HashSet<RecordId>,
    /// Receipt acks waiting for their author to pull.
    acks: Acks<(ServerId, PublicKey)>,
    /// Logs to pull again shortly (to pick up acks after writing).
    soon: HashSet<String>,
    /// Addresses relayed peers reported (identify): tried for a direct
    /// connection; LAN ones only once the peer is bound (F2).
    direct_candidates: HashMap<PeerId, Vec<Multiaddr>>,
    /// "Relay only" (GAP-6): no direct listener, no direct dials or upgrades,
    /// no direct addresses to members. Everything goes through the relay.
    relay_only: bool,
    /// Peers whose direct turn is ours later (the larger peer ID), and peers
    /// we already took that turn for (once per connection).
    fallback_at: HashMap<PeerId, Instant>,
    fallback_done: HashSet<PeerId>,
    /// Tests: our own direct dials can be switched off (stands in for a
    /// firewall), to show the other side's turn.
    direct_dials: bool,
    /// The direct listener (`NodeConfig::listen`), removed while relay-only.
    listen: Multiaddr,
    listener: Option<ListenerId>,
    /// The QUIC listener beside it (same port when free), removed with it.
    quic_listener: Option<ListenerId>,
    /// Where our TCP listen port is kept, so it stays the same across
    /// restarts (a firewall or router rule can then allow it once).
    port_file: PathBuf,
    /// Relayed connections dialled by the smaller peer ID (see `keep_relayed`).
    relayed_preferred: HashSet<ConnectionId>,
    /// Peers from the DHT whose dials failed, and when to try them again.
    /// Shared with the swarm's `DialGuard`, which refuses any dial (Kademlia's
    /// included) to a peer still backing off.
    dial_backoff: SharedBackoff,
    /// Tests: entries served per (peer, log).
    #[cfg(test)]
    served: HashMap<(PeerId, String), usize>,
    /// Tests: inbound pulls refused (rate limit, answering cap or byte budget).
    #[cfg(test)]
    rate_limited: usize,
    /// Pulls waiting for one of the `MAX_PULLS_IN_FLIGHT` slots, per peer.
    queued_pulls: HashMap<PeerId, BTreeSet<String>>,
    /// T23: control logs an unbound peer answered empty, and until when it
    /// isn't asked for them again (`UNBOUND_REPROBE`).
    empty_from: HashMap<(PeerId, String), Instant>,
    /// T23: when we last probed an unbound peer for a server we already have
    /// a bound member of.
    probed: HashMap<(PeerId, ServerId), Instant>,
    /// Tests: pull requests this node received.
    #[cfg(test)]
    pulls_received: usize,
    /// Anti-entropy rounds so far: which slice of the other control logs
    /// `pull_shared` takes this round.
    pull_round: usize,
    /// Who is online, per server (M2).
    presence: Presence,
    last_seen: HashMap<ServerId, SystemTime>,
    /// Whether we ever reached the network (a relay reservation or a peer).
    reached: bool,
    started: Instant,
    /// Peers' stubs the stub gate couldn't accept yet, by id: stored with
    /// the delete or edit that replaced them when it arrives.
    pending_stubs: HashMap<RecordId, Stub>,
    stub_gate: Arc<dyn StubGate>,
    /// Caps on accepted voice signals.
    voice_limits: VoiceLimits,
    /// G-29: caps on accepted typing signals (their own, not voice's).
    typing_limits: TypingLimits,
    /// G-48: caps on accepted report boxes (their own).
    report_limits: ReportLimits,
    /// G-48: report boxes sent and waiting for their ack.
    report_pending: HashMap<request_response::OutboundRequestId, oneshot::Sender<Result<(), ReportError>>>,
    /// G-48: where accepted boxes go (the api's bounded queue). A box is acked
    /// only once it is in there; a full queue leaves it unacked, so the
    /// sender retries. `None` (tests): emitted as an event and acked.
    report_sink: Option<std::sync::mpsc::SyncSender<(PublicKey, Vec<u8>)>>,
    /// G-81 voice media: my current call; per target, the substream my
    /// frames go out on; per participant, the one theirs come in on; each
    /// sender's last sequence; the caps; and each open connection's kind.
    voice_call: Option<VoiceCall>,
    voice_out: HashMap<PublicKey, VoiceOut>,
    voice_in: HashMap<PublicKey, VoiceIn>,
    voice_seq: HashMap<PublicKey, u32>,
    voice_in_tx: mpsc::Sender<(PublicKey, ConnectionId, VoiceFrame)>,
    voice_in_rx: mpsc::Receiver<(PublicKey, ConnectionId, VoiceFrame)>,
    voice_rate_peer: RateLimiter<PublicKey>,
    voice_rate_all: RateLimiter<()>,
    voice_rate_out: RateLimiter<PublicKey>,
    voice_conns: HashMap<ConnectionId, VoicePath>,
    voice_paths: HashMap<PublicKey, VoicePath>,
    voice_dirty: bool,
    /// T8-02: envelope handle → the server and publication we serve.
    invites: HashMap<[u8; 32], (ServerId, Vec<u8>)>,
    invite_limits: InviteLimits,
    /// Envelope asks in flight, and which ask each request belongs to.
    fetches: HashMap<u64, Fetch>,
    fetch_of: HashMap<request_response::OutboundRequestId, u64>,
    next_fetch: u64,
    /// G-91: caps on backup writes and fetches; backup fetches in flight
    /// (request, and provider lookup, to the fetch they belong to); when
    /// held backups were last expired.
    backup_limits: crate::backup::BackupLimits,
    backup_fetch_of: HashMap<request_response::OutboundRequestId, u64>,
    backup_lookups: HashMap<kad::QueryId, (u64, [u8; 32])>,
    backups_expired: Instant,
    /// When each tag's providers were last looked up.
    backup_looked_up: HashMap<[u8; 32], Instant>,
    /// Holder notice slot: caps, fetches in flight, and the core's `w_n`
    /// signer (present while unlocked; without it no fetch is sent).
    notice_limits: crate::notice::NoticeLimits,
    notice_fetch_of: HashMap<request_response::OutboundRequestId, u64>,
    notice_signer: Option<Arc<dyn crate::notice::NoticeSigner>>,
    /// The member-only LAN beacon (`lan_beacon`): its socket once started,
    /// the port beacons go to, where read beacons arrive, its caps, when the
    /// next is due, which servers take the slots next, and our TCP port.
    beacon: Option<Arc<tokio::net::UdpSocket>>,
    beacon_port: u16,
    beacons: mpsc::Sender<(std::net::IpAddr, Vec<u8>)>,
    beacon_limits: crate::lan_beacon::BeaconLimits,
    beacon_next: Instant,
    beacon_round: usize,
    tcp_port: Option<u16>,
    /// Device link, new device: the one open link.
    link_host: Option<LinkHost>,
    /// Device-link peers (either side), reached through the relay only, and
    /// until when; the set is shared with the `DialGuard`.
    link_peers: LinkPeers,
    link_until: HashMap<PeerId, Instant>,
    /// Provider lookups for a code, and until when they may run.
    link_finds: HashMap<kad::QueryId, (oneshot::Sender<Result<PeerId, LinkError>>, Instant)>,
    /// Requests waiting for a relayed connection to their peer, and until when.
    link_waiting: Vec<(PeerId, LinkRequest, LinkReply, Instant)>,
    link_out: HashMap<request_response::OutboundRequestId, LinkReply>,
    /// Member relays, client side (#368 slice 2, design §2): offers members
    /// made (addresses, preferred, when), members we saw bound, since when our
    /// relay is down, our reservations on member relays (listener → relay),
    /// relays resting after a failure, and circuit dials through them.
    relay_offers: HashMap<PeerId, (Vec<Multiaddr>, bool, Instant)>,
    known_members: HashMap<PeerId, Instant>,
    relay_lost_at: Option<Instant>,
    member_listeners: HashMap<ListenerId, PeerId>,
    /// Member relay listeners whose reservation was accepted.
    member_reserved: HashSet<ListenerId>,
    /// Remembered members dialled lately, and when the rows were last checked.
    remembered_dialed: HashMap<PeerId, Instant>,
    remembered_checked: Instant,
    /// Failed pings in a row to our relay, per connection (`relay_ping`):
    /// one dead connection among several (TCP and QUIC) is closed on its own
    /// count (Security Lead, #400).
    relay_ping_misses: HashMap<ConnectionId, u32>,
    member_relay_rest: HashMap<PeerId, Instant>,
    fallback_dialed: HashMap<(PeerId, PeerId), Instant>,
    fallback_dials: HashSet<ConnectionId>,
}

/// Our relays: at most this many (the api's list is 1 to 4).
const MAX_RELAYS: usize = 4;

/// One of our configured relays (multi-relay part B).
struct OurRelay {
    addr: Multiaddr,
    peer: PeerId,
    /// Our listener on its circuit; re-made after it restarts.
    circuit: Option<ListenerId>,
    /// Redialling it while it is down: the wait doubles up to
    /// [`RELAY_BACKOFF_MAX`], and resets once connected.
    backoff: Duration,
    next_dial: Instant,
}

impl OurRelay {
    fn new(addr: Multiaddr, peer: PeerId) -> Self {
        OurRelay { addr, peer, circuit: None, backoff: RELAY_BACKOFF_MIN, next_dial: Instant::now() }
    }

    fn circuit_addr(&self) -> Multiaddr {
        self.addr.clone().with(Protocol::P2pCircuit)
    }
}

/// One [`Node::fetch_invite`]: answers so far, until every peer answered or
/// [`INVITE_FETCH_WAIT`] passed.
struct Fetch {
    reply: oneshot::Sender<Vec<Vec<u8>>>,
    waiting: usize,
    answers: Vec<Vec<u8>>,
    until: Instant,
}

/// What a pull may get: the log, the read check still to run, and the
/// requester's bound identity (for receipt acks).
struct Readable {
    log: String,
    check: Option<ReadCheck>,
    reader: Option<(ServerId, PublicKey)>,
}

/// What happened to one incoming record.
#[derive(Debug, PartialEq, Eq)]
enum Ingest {
    Added,
    Known,
    /// Parked until its deps arrive; not judged yet.
    Waiting,
    /// Not storable by its own content: misfiled or cross-log.
    Rejected,
    /// Refused by the authorizer (or built only on refused records). Not the
    /// sender's fault: a peer with more of the control log may accept it.
    Refused,
}

impl Task {
    async fn run(
        mut self,
        mut commands: mpsc::UnboundedReceiver<Command>,
        mut answers: mpsc::UnboundedReceiver<Answer>,
        mut decoded: mpsc::UnboundedReceiver<Decoded>,
        mut beacon_rx: mpsc::Receiver<(std::net::IpAddr, Vec<u8>)>,
        mut voice_frame_rx: mpsc::Receiver<VoiceFrame>,
    ) {
        let mut anti_entropy = tokio::time::interval(ANTI_ENTROPY);
        // The first discovery runs as soon as the relay connection is up;
        // after that, keep looking for peers that joined later.
        let mut discovery = tokio::time::interval(DISCOVERY);
        let mut soon = tokio::time::interval(ACK_PULL);
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Shutdown { reply }) => {
                        drop(self.swarm);
                        drop(self.store);
                        let _ = reply.send(());
                        return;
                    }
                    Some(command) => self.on_command(command),
                    None => return,
                },
                event = self.swarm.select_next_some() => {
                    self.on_swarm_event(event);
                    if self.voice_dirty {
                        self.voice_reroute();
                    }
                }
                Some(answer) = answers.recv() => self.send_answer(answer),
                Some((key, records, more, acked)) = decoded.recv() => self.on_decoded(key, records, more, acked),
                Some((ip, packet)) = beacon_rx.recv() => self.on_beacon(ip, packet),
                Some(frame) = voice_frame_rx.recv() => self.voice_out_frame(frame),
                Some((identity, connection, frame)) = self.voice_in_rx.recv() => self.voice_in_frame(identity, connection, frame),
                _ = soon.tick() => {
                    // T24: send what the outgoing rate held back.
                    let waiting: Vec<PeerId> = self.queued_pulls.keys().copied().collect();
                    for peer in waiting {
                        for _ in 0..MAX_PULLS_IN_FLIGHT {
                            self.pull_next(peer);
                        }
                    }
                    self.pull_soon();
                    self.direct_fallback();
                    self.recheck_punch();
                    self.recheck_member_relay();
                    self.expire_fetches();
                    self.link_tick();
                    self.lan_beacon_tick();
                    self.voice_reroute();
                    self.check_remembered();
                    let gone = self.presence.expire(Instant::now());
                    self.went_offline(gone);
                }
                _ = anti_entropy.tick() => {
                    self.pending.expire(Instant::now(), PENDING_TTL);
                    // T23 state outlives a disconnect (a reset relay circuit
                    // must not make us re-probe everything), so it expires here.
                    let now = Instant::now();
                    self.empty_from.retain(|_, until| now < *until);
                    self.probed.retain(|_, at| now < *at + UNBOUND_REPROBE);
                    self.pull_all("round");
                }
                _ = discovery.tick() => {
                    self.discover();
                    self.member_relay_fallback();
                    self.redial_remembered();
                }
            }
        }
    }

    fn on_command(&mut self, command: Command) {
        match command {
            Command::Append { record, reply } => {
                let _ = reply.send(self.append_local(*record));
            }
            Command::Heads { log, reply } => {
                let _ = reply.send(self.store.heads(&log).map_err(Into::into));
            }
            Command::Open { log } => {
                if self.secrets.keys().any(|server| log.starts_with(&format!("{server}/"))) {
                    warn!("a log of a server opened with its secret can't be opened by name");
                } else {
                    self.open(log, None);
                }
            }
            Command::OpenServer { server, secret } => {
                self.secrets.entry(server).or_insert(*secret);
                self.open_sealed(server, Scope::Control);
            }
            Command::OpenChannel { server, channel, reply } => {
                let result = if self.secrets.contains_key(&server) {
                    self.open_sealed(server, Scope::Channel(channel));
                    Ok(())
                } else {
                    Err(anyhow::anyhow!("open the server with its secret first"))
                };
                let _ = reply.send(result);
            }
            Command::State { log, reply } => {
                let state = (|| {
                    Ok(LogState {
                        count: self.store.count(&log)?,
                        hash: self.store.state_hash(&log)?,
                        heads: self.store.heads(&log)?.len(),
                    })
                })();
                let _ = reply.send(state);
            }
            Command::Presence { server, reply } => {
                let online = self.presence.online(&server);
                let reachability = if !online.is_empty() {
                    Reachability::Online
                } else if self.reached || self.started.elapsed() >= CONNECTING {
                    Reachability::NobodyOnline
                } else {
                    Reachability::Connecting
                };
                let direct = self
                    .presence
                    .peers(&server)
                    .into_iter()
                    .filter(|(_, peers)| peers.iter().any(|p| self.direct.contains_key(p)))
                    .map(|(k, _)| k)
                    .collect();
                let last_seen = self.last_seen.get(&server).copied();
                let _ = reply.send(PresenceState { online, direct, last_seen, reachability });
            }
            Command::Prune { id, reply } => {
                let _ = reply.send(self.store.prune(&id, &*self.stub_gate).map_err(Into::into));
            }
            #[cfg(test)]
            Command::Served { peer, log, reply } => {
                let _ = reply.send(self.served.get(&(peer, log)).copied().unwrap_or(0));
            }
            #[cfg(test)]
            Command::RateLimited { reply } => {
                let _ = reply.send(self.rate_limited);
            }
            #[cfg(test)]
            Command::InboundPulls { reply } => {
                let _ = reply.send(self.pulls_received);
            }
    #[cfg(any(test, feature = "test-util"))]
            Command::Listen { addr } => {
                let _ = self.swarm.listen_on(addr);
            }
    #[cfg(any(test, feature = "test-util"))]
            Command::MemberRelayCounts { reply } => {
                let relay = &self.swarm.behaviour().member_relay;
                let _ = reply.send((relay.reservations, relay.circuits));
            }
    #[cfg(any(test, feature = "test-util"))]
            Command::Dial { addr } => {
                let _ = self.swarm.dial(addr);
            }
            Command::LinkOpen { rv, e_new_pub, reply } => {
                let _ = reply.send(self.link_open(rv, e_new_pub));
            }
            Command::LinkClose => self.link_close(),
            Command::LinkFind { rv, reply } => self.link_find(rv, reply),
            Command::LinkRequest { peer, request, reply } => self.link_request(peer, request, reply),
            #[cfg(test)]
            Command::Disconnect { peer } => {
                let _ = self.swarm.disconnect_peer_id(peer);
            }
            Command::VoiceSend { to, bytes, reply } => {
                let _ = reply.send(self.voice_send(to, bytes));
            }
            Command::VoiceCall { call } => self.set_voice_call(call),
            Command::TypingSend { to, bytes, reply } => {
                let _ = reply.send(self.typing_send(to, bytes));
            }
            Command::ReportSend { to, bytes, reply } => self.report_send(to, bytes, reply),
            Command::ReportSink { sink } => self.report_sink = Some(sink),
            Command::ServeInvite { server, handle, publication, announce, reply } => {
                let _ = reply.send(self.serve_invite(server, handle, publication, announce));
            }
            Command::DropInvite { handle } => {
                self.invites.remove(&handle);
            }
            Command::DropServerInvites { server } => self.invites.retain(|_, (s, _)| *s != server),
            Command::FetchInvite { handle, reply } => self.fetch_invite(handle, reply),
            Command::PutBackup { blob, reply } => {
                let _ = reply.send(self.put_backup(blob));
            }
            Command::FetchBackup { tag, reply } => self.fetch_backup(tag, reply),
            Command::PutNotice { blob, reply } => {
                let _ = reply.send(self.put_notice(blob));
            }
            Command::FetchNotices { reply } => self.fetch_notices(reply),
            Command::NoticeSigner { signer } => self.notice_signer = signer,
            Command::LanBeacon { port, reply } => {
                let _ = reply.send(self.start_lan_beacon(port));
            }
            Command::RelayOnly { on } => self.set_relay_only(on),
            Command::NoDirectDials => self.direct_dials = false,
            Command::NoHolePunch => self.swarm.behaviour_mut().punch.set_enabled(false),
            Command::MemberRelay { on, daily_cap_mb, preferred } => {
                // Relay-only users never relay (design §1), whatever the core says.
                let on = on && !self.relay_only;
                self.swarm.behaviour_mut().member_relay.set(on, daily_cap_mb, preferred);
                self.recheck_member_relay();
            }
            Command::ListenAddrs { reply } => {
                let _ = reply.send(self.swarm.listeners().cloned().collect());
            }
            Command::Peers { reply } => {
                let _ = reply.send(self.connected.iter().copied().collect());
            }
            Command::DirectPeers { reply } => {
                let _ = reply.send(self.direct.keys().copied().collect());
            }
            Command::Shutdown { .. } => unreachable!(),
        }
    }

    fn open_sealed(&mut self, server: ServerId, scope: Scope) {
        let secret = &self.secrets[&server];
        let sealed = Sealed { server, scope, handle: secret.handle(scope), key: secret.gossip_key(scope) };
        self.open(log_name(server, scope), Some(sealed));
    }

    fn open(&mut self, log: String, sealed: Option<Sealed>) {
        if !self.logs.insert(log.clone()) {
            return;
        }
        if let Some(sealed) = sealed {
            self.sealing.insert(log.clone(), sealed);
        }
        if let Err(err) = self.swarm.behaviour_mut().gossipsub.subscribe(&topic(&self.sealing.wire(&log))) {
            warn!(%err, "subscribe failed");
        }
        // A new log: its control log from anyone (a joiner needs it before
        // anyone is bound), a channel only from peers that share it.
        for peer in self.connected.clone() {
            if self.shares(peer, &log) {
                self.pull(peer, &log, "open");
            }
        }
    }

    fn append_local(&mut self, record: Record) -> Result<()> {
        let log = log_of(&record);
        if !self.logs.contains(&log) {
            bail!("log {log} is not open");
        }
        match self.store.append(&record, &*self.authorizer)? {
            Append::Added => {}
            other => bail!("storing own record failed: {other:?}"),
        }
        // No subscribed peers yet is fine: they'll pull it.
        let data = match self.sealing.get(&log) {
            Some(s) => access::seal(&s.key, &s.handle, &record.encode()),
            None => record.encode(),
        };
        let published = self.swarm.behaviour_mut().gossipsub.publish(topic(&self.sealing.wire(&log)), data).is_ok();
        let id = record.id();
        if published {
            self.emit(NodeEvent::Sent { id });
        } else {
            // Bounded: past the cap the oldest ticks are simply never shown.
            if self.unsent.len() >= MAX_OWN {
                self.unsent.clear();
            }
            self.unsent.insert(id);
        }
        if self.sealing.get(&log).is_some() {
            if self.own.len() >= MAX_OWN {
                self.own.clear();
            }
            self.own.insert(id);
            self.soon.insert(log.clone());
        }
        let id = record.id();
        self.stored(log, record, Via::Local, SystemTime::now());
        self.release_pending(id);
        Ok(())
    }

    /// After a record was stored: tell the app, and if it is a control
    /// record, forget what we refused in that server's channels. The storage
    /// gate only opens as control records arrive, so those may be acceptable
    /// now and should be pulled again.
    fn stored(&mut self, log: String, record: Record, via: Via, at: SystemTime) {
        if record.scope() == Scope::Control {
            self.refused.forget_prefix(&format!("{}/", record.server()));
        }
        self.emit(NodeEvent::Stored { log, record: Box::new(record), via, at });
    }

    fn emit(&mut self, event: NodeEvent) {
        self.events.emit(event);
    }

    fn discover(&mut self) {
        let mut any = false;
        for i in 0..self.relays.len() {
            let peer = self.relays[i].peer;
            if self.swarm.is_connected(&peer) {
                any = true;
                if self.relays[i].circuit.is_none() {
                    self.listen_on_circuit(i);
                }
            } else if Instant::now() >= self.relays[i].next_dial {
                let relay = &mut self.relays[i];
                debug!(backoff = ?relay.backoff, relay = i, "dialling the relay");
                let addr = relay.addr.clone();
                relay.next_dial = Instant::now() + jittered(relay.backoff, OsRng.next_u32());
                relay.backoff = (relay.backoff * 2).min(RELAY_BACKOFF_MAX);
                let _ = self.swarm.dial(addr);
            }
        }
        if any {
            let me = *self.swarm.local_peer_id();
            self.swarm.behaviour_mut().kad.get_closest_peers(me);
        }
        // Bootstrap peers are dialled directly: not while relay-only.
        for (addr, peer) in if self.relay_only { Vec::new() } else { self.bootstrap.clone() } {
            let open = self.bootstrap_conns.values().any(|a| *a == addr);
            if !open && peer.is_none_or(|p| !self.direct.contains_key(&p)) {
                let _ = self.swarm.dial(DialOpts::unknown_peer_id().address(addr).build());
            }
        }
    }

    /// [`reachable`], plus: a circuit through one of our relays is always
    /// fine (we dial those relays anyway, whatever their address).
    fn reachable(&self, addr: &Multiaddr) -> bool {
        // Never LAN addresses here: these come from or go to the DHT (F2).
        self.via_ours(addr) || reachable(addr, false)
    }

    /// Whether `addr` is a circuit through one of our relays, exactly as
    /// configured ([`via_relay`]).
    fn via_ours(&self, addr: &Multiaddr) -> bool {
        self.relays.iter().any(|r| via_relay(addr, &r.addr))
    }

    /// Whether `peer` is one of our relays.
    fn is_our_relay(&self, peer: &PeerId) -> bool {
        self.relays.iter().any(|r| r.peer == *peer)
    }

    /// Our relays we are connected to now.
    fn relays_connected(&self) -> Vec<PeerId> {
        self.relays.iter().map(|r| r.peer).filter(|p| self.swarm.is_connected(p)).collect()
    }

    /// The relay to reach others through: the first with a reservation,
    /// else the first connected, else the first.
    fn live_relay(&self) -> Multiaddr {
        let up = |r: &&OurRelay| self.swarm.is_connected(&r.peer);
        self.relays
            .iter()
            .filter(up)
            .find(|r| r.circuit.is_some())
            .or_else(|| self.relays.iter().find(up))
            .unwrap_or(&self.relays[0])
            .addr
            .clone()
    }

    /// A peer-learned circuit through one of our relays, rebuilt from that
    /// relay's configured address ([`our_relay_circuit`], the #446 rules).
    fn rebuilt_circuit(&self, addr: &Multiaddr, expected: &PeerId) -> Option<Multiaddr> {
        self.relays.iter().find_map(|r| our_relay_circuit(addr, &r.addr, expected))
    }

    fn listen_on_circuit(&mut self, i: usize) {
        match self.swarm.listen_on(self.relays[i].circuit_addr()) {
            Ok(id) => self.relays[i].circuit = Some(id),
            Err(err) => warn!(%err, relay = i, "listening on relay circuit failed"),
        }
    }

    /// Dials a peer we only reach through the relay at the addresses it
    /// listens on, so its traffic can move off the capped relay circuit.
    /// LAN addresses (F2) only to a *member*: a peer bound to an identity our
    /// read gate accepts (a member, not kicked) on a server we share. A
    /// non-member holding the secret, or a kicked member, can't make us dial
    /// addresses of their choosing on our LAN. Global ones to any connected
    /// peer.
    /// Whether `peer` is bound to an identity our read gate accepts on one of
    /// the servers it bound for.
    fn is_member(&self, peer: PeerId) -> bool {
        let Some(gate) = self.access.read_gate.as_ref() else { return false };
        self.bound
            .iter()
            .any(|((p, server), (_, identity))| *p == peer && gate.may_read(identity, &self.store.control_log(*server)))
    }

    /// The identity `peer` is bound to as a current member (as for
    /// [`Task::is_member`]); None if none, or if it is bound to more than one.
    fn member_identity(&self, peer: PeerId) -> Option<PublicKey> {
        let gate = self.access.read_gate.as_ref()?;
        let mut found = None;
        for ((p, server), (_, identity)) in &self.bound {
            if *p != peer || !gate.may_read(identity, &self.store.control_log(*server)) {
                continue;
            }
            match found {
                Some(known) if known != *identity => return None,
                _ => found = Some(*identity),
            }
        }
        found
    }

    /// Voice (piece A): to a connected peer bound to `to` as a current
    /// member; a peer with a direct connection first.
    fn voice_send(&mut self, to: PublicKey, bytes: Vec<u8>) -> Result<(), VoiceError> {
        if bytes.len() > MAX_VOICE_BLOB {
            return Err(VoiceError::TooLarge);
        }
        let peer = self.member_peer(to).ok_or(VoiceError::NotMember)?;
        self.swarm.behaviour_mut().voice.send_request(&peer, bytes);
        Ok(())
    }

    /// A connected peer bound to `to` as a current member, a direct one
    /// first (voice and typing).
    fn member_peer(&self, to: PublicKey) -> Option<PeerId> {
        let mut peers: Vec<PeerId> = self
            .bound
            .iter()
            .filter(|(_, (_, identity))| *identity == to)
            .map(|((peer, _), _)| *peer)
            .filter(|peer| self.swarm.is_connected(peer))
            .collect();
        peers.sort_by_key(|peer| (!self.direct.contains_key(peer), *peer));
        peers.dedup();
        peers.into_iter().find(|peer| self.member_identity(*peer) == Some(to))
    }

    /// G-29: as [`Self::voice_send`], over `/mvs/typing/1`.
    fn typing_send(&mut self, to: PublicKey, bytes: Vec<u8>) -> Result<(), TypingError> {
        if bytes.len() > MAX_TYPING_BLOB {
            return Err(TypingError::TooLarge);
        }
        let peer = self.member_peer(to).ok_or(TypingError::NotMember)?;
        self.swarm.behaviour_mut().typing.send_request(&peer, bytes);
        Ok(())
    }

    /// G-29: as [`Self::on_voice`], with typing's own caps.
    fn on_typing(&mut self, peer: PeerId, bytes: Vec<u8>, channel: ResponseChannel<()>) {
        let Some(from) = self.member_identity(peer) else {
            debug!(%peer, "typing signal from a non-member dropped");
            return;
        };
        if !self.typing_limits.allow(peer, Instant::now()) {
            debug!(%peer, "typing signal over the rate cap dropped");
            return;
        }
        let _ = self.swarm.behaviour_mut().typing.send_response(channel, ());
        self.emit(NodeEvent::TypingSignal { from, bytes });
    }

    /// G-48: as [`Self::typing_send`], over `/mvs/report/1`; the reply waits
    /// for the ack (or the failure) in `report_pending`.
    fn report_send(&mut self, to: PublicKey, bytes: Vec<u8>, reply: oneshot::Sender<Result<(), ReportError>>) {
        if bytes.len() > MAX_REPORT_BLOB {
            let _ = reply.send(Err(ReportError::TooLarge));
            return;
        }
        if self.report_pending.len() >= MAX_REPORT_PENDING {
            let _ = reply.send(Err(ReportError::Busy));
            return;
        }
        let Some(peer) = self.member_peer(to) else {
            let _ = reply.send(Err(ReportError::NotMember));
            return;
        };
        let id = self.swarm.behaviour_mut().report.send_request(&peer, bytes);
        self.report_pending.insert(id, reply);
    }

    /// G-48: as [`Self::on_typing`], with report's own caps. The ack goes
    /// out before the api tries to open the box, so it is the same for every
    /// box that passes (R7). With a report sink, only once the box is in it:
    /// a full sink leaves it unacked (the sender retries), whatever it holds.
    fn on_report(&mut self, peer: PeerId, bytes: Vec<u8>, channel: ResponseChannel<()>) {
        let Some(from) = self.member_identity(peer) else {
            debug!(%peer, "report box from a non-member dropped");
            return;
        };
        if !self.report_limits.allow(peer, Instant::now()) {
            debug!(%peer, "report box over the rate cap dropped");
            return;
        }
        if let Some(sink) = &self.report_sink {
            match sink.try_send((from, bytes)) {
                Ok(()) => {}
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    debug!(%peer, "report inbox full: not acked, the sender retries");
                    return;
                }
                // Closed (shutting down): stays closed, so later boxes stay
                // unacked too, never acked into nowhere.
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    debug!("report inbox closed: not acked");
                    return;
                }
            }
            let _ = self.swarm.behaviour_mut().report.send_response(channel, ());
            return;
        }
        let _ = self.swarm.behaviour_mut().report.send_response(channel, ());
        self.emit(NodeEvent::ReportBox { from, bytes });
    }

    /// A voice signal came in: only a current member's, within its rate
    /// cap, reaches the app. Anything else is dropped unanswered.
    fn on_voice(&mut self, peer: PeerId, bytes: Vec<u8>, channel: ResponseChannel<()>) {
        let Some(from) = self.member_identity(peer) else {
            debug!(%peer, "voice signal from a non-member dropped");
            return;
        };
        if !self.voice_limits.allow(peer, Instant::now()) {
            debug!(%peer, "voice signal over the rate cap dropped");
            return;
        }
        let _ = self.swarm.behaviour_mut().voice.send_response(channel, ());
        self.emit(NodeEvent::VoiceSignal { from, bytes });
    }

    /// The identity `peer` is bound to on `server`, if our read gate
    /// accepts it there as a current member.
    fn member_on(&self, peer: PeerId, server: ServerId) -> Option<PublicKey> {
        let gate = self.access.read_gate.as_ref()?;
        let (_, identity) = self.bound.get(&(peer, server))?;
        gate.may_read(identity, &self.store.control_log(server)).then_some(*identity)
    }

    /// Connected peers that are current members of `server`.
    fn member_peers(&self, server: ServerId) -> Vec<PeerId> {
        let mut peers: Vec<PeerId> = self
            .bound
            .keys()
            .filter(|(peer, s)| *s == server && self.swarm.is_connected(peer))
            .map(|(peer, _)| *peer)
            .filter(|peer| self.member_on(*peer, server).is_some())
            .collect();
        peers.dedup();
        peers
    }

    /// See [`Node::serve_invite`].
    fn serve_invite(&mut self, server: ServerId, handle: [u8; 32], publication: Vec<u8>, announce: bool) -> bool {
        if publication.is_empty()
            || publication.len() > crate::invite::MAX_PUBLICATION
            || !self.secrets.contains_key(&server)
            || self.invites.contains_key(&handle)
            || self.invites.values().filter(|(s, _)| *s == server).count() >= crate::invite::MAX_PER_SERVER
        {
            return false;
        }
        self.invites.insert(handle, (server, publication.clone()));
        if announce {
            for peer in self.member_peers(server) {
                self.push_invite(peer, server, publication.clone());
            }
        }
        true
    }

    fn push_invite(&mut self, peer: PeerId, server: ServerId, publication: Vec<u8>) {
        let Some(secret) = self.secrets.get(&server) else { return };
        let control = *secret.handle(Scope::Control).as_bytes();
        self.swarm.behaviour_mut().invite_pub.send_request(&peer, crate::invite::Push { control, publication });
    }

    /// A member we just bound: hand it every publication we serve for that
    /// server, so a member who was offline when an invite was made catches up.
    fn share_invites(&mut self, peer: PeerId, server: ServerId) {
        if self.member_on(peer, server).is_none() {
            return;
        }
        let ours: Vec<Vec<u8>> =
            self.invites.values().filter(|(s, _)| *s == server).map(|(_, publication)| publication.clone()).collect();
        for publication in ours {
            self.push_invite(peer, server, publication);
        }
    }

    /// A publication came in: only a current member's, for a server we
    /// hold, within its rate cap, reaches the api (which verifies it).
    fn on_invite_push(&mut self, peer: PeerId, push: crate::invite::Push, channel: ResponseChannel<()>) {
        let server = self.secrets.iter().find(|(_, secret)| *secret.handle(Scope::Control).as_bytes() == push.control);
        let Some(server) = server.map(|(server, _)| *server) else {
            debug!(%peer, "invite publication for a server we don't hold dropped");
            return;
        };
        let Some(from) = self.member_on(peer, server) else {
            debug!(%peer, "invite publication from a non-member dropped");
            return;
        };
        if !self.invite_limits.allow_push(peer, Instant::now()) {
            debug!(%peer, "invite publication over the rate cap dropped");
            return;
        }
        let _ = self.swarm.behaviour_mut().invite_pub.send_response(channel, ());
        self.emit(NodeEvent::InvitePublication { server, from, bytes: push.publication });
    }

    /// An ask for an envelope handle: the publication served under exactly
    /// that handle, else the same empty answer whatever the reason (S2).
    fn on_invite_ask(&mut self, peer: PeerId, handle: [u8; 32], channel: ResponseChannel<Vec<u8>>) {
        let allowed = self.invite_limits.allow_ask(peer, Instant::now());
        let answer = match self.invites.get(&handle) {
            Some((_, publication)) if allowed => publication.clone(),
            _ => Vec::new(),
        };
        let _ = self.swarm.behaviour_mut().invite_ask.send_response(channel, answer);
    }

    /// See [`Node::fetch_invite`]: one ask to each connected peer (not the
    /// relay, which serves none), at most [`MAX_FETCH_PEERS`].
    fn fetch_invite(&mut self, handle: [u8; 32], reply: oneshot::Sender<Vec<Vec<u8>>>) {
        let mut peers: Vec<PeerId> = self.connected.iter().copied().collect();
        peers.sort_by_key(|peer| (!self.direct.contains_key(peer), *peer));
        peers.truncate(MAX_FETCH_PEERS);
        if peers.is_empty() {
            let _ = reply.send(Vec::new());
            return;
        }
        let id = self.next_fetch;
        self.next_fetch += 1;
        for peer in &peers {
            let request = self.swarm.behaviour_mut().invite_ask.send_request(peer, handle);
            self.fetch_of.insert(request, id);
        }
        let until = Instant::now() + INVITE_FETCH_WAIT;
        self.fetches.insert(id, Fetch { reply, waiting: peers.len(), answers: Vec::new(), until });
    }

    fn on_invite_answer(&mut self, request: request_response::OutboundRequestId, answer: Option<Vec<u8>>) {
        let Some(id) = self.fetch_of.remove(&request) else { return };
        let Some(fetch) = self.fetches.get_mut(&id) else { return };
        fetch.waiting = fetch.waiting.saturating_sub(1);
        if let Some(answer) = answer.filter(|a| !a.is_empty()) {
            fetch.answers.push(answer);
        }
        if fetch.waiting == 0 {
            let fetch = self.fetches.remove(&id).expect("just seen");
            let _ = fetch.reply.send(fetch.answers);
        }
    }

    /// Asks past [`INVITE_FETCH_WAIT`] return what they have.
    fn expire_fetches(&mut self) {
        let now = Instant::now();
        let due: Vec<u64> = self.fetches.iter().filter(|(_, f)| f.until <= now).map(|(id, _)| *id).collect();
        for id in due {
            let fetch = self.fetches.remove(&id).expect("just seen");
            let _ = fetch.reply.send(fetch.answers);
        }
        let live: HashSet<u64> = self.fetches.keys().copied().collect();
        self.fetch_of.retain(|_, id| live.contains(id));
        self.backup_fetch_of.retain(|_, id| live.contains(id));
        self.notice_fetch_of.retain(|_, id| live.contains(id));
        self.backup_lookups.retain(|_, (id, _)| live.contains(id));
        // Others' backups past their retention (phase B; mine stay).
        if self.backups_expired.elapsed() >= Duration::from_secs(3600) {
            self.backups_expired = Instant::now();
            if let Err(err) = self.store.expire_backups(unix_now(), crate::backup::RETENTION.as_secs()) {
                warn!(%err, "expiring held backups failed");
            }
            if let Err(err) = self.store.expire_notices(unix_now(), crate::notice::RETENTION.as_secs()) {
                warn!(%err, "expiring held notices failed");
            }
        }
    }

    /// One answer (or failure) for fetch `id`; replies once nothing is
    /// left to wait for.
    fn fetch_answered(&mut self, id: u64, answer: Option<Vec<u8>>) {
        let Some(fetch) = self.fetches.get_mut(&id) else { return };
        fetch.waiting = fetch.waiting.saturating_sub(1);
        if let Some(answer) = answer.filter(|a| !a.is_empty()) {
            fetch.answers.push(answer);
        }
        if fetch.waiting == 0 {
            let fetch = self.fetches.remove(&id).expect("just seen");
            let _ = fetch.reply.send(fetch.answers);
        }
    }

    /// The peers bound to my own identity (my other devices) that are
    /// connected now.
    fn my_devices(&self) -> Vec<PeerId> {
        let Some(me) = self.access.binder.as_ref().map(|b| b.identity()) else { return Vec::new() };
        let mut peers: Vec<PeerId> = self
            .bound
            .iter()
            .filter(|((peer, _), (_, identity))| *identity == me && self.swarm.is_connected(peer))
            .map(|((peer, _), _)| *peer)
            .collect();
        peers.sort();
        peers.dedup();
        peers
    }

    /// Announces us as a DHT provider of a backup tag we hold (kad then
    /// re-announces it every 12 h on its own).
    fn provide_backup(&mut self, tag: [u8; 32]) {
        if let Err(err) = self.swarm.behaviour_mut().kad.start_providing(kad::RecordKey::new(&tag)) {
            debug!(%err, "announcing a backup failed");
        }
    }

    /// See [`Node::put_backup`].
    fn put_backup(&mut self, blob: Vec<u8>) -> bool {
        let Some((tag, version)) = crate::backup::check(&blob) else { return false };
        if let Err(err) = self.store.put_backup(&tag, version, &blob, None, unix_now()) {
            warn!(%err, "keeping my backup failed");
            return false;
        }
        self.provide_backup(tag);
        let mut holders = self.my_devices();
        // Every relay of ours we are connected to (its mailbox).
        holders.extend(self.relays_connected());
        for peer in holders {
            self.swarm.behaviour_mut().backup.send_request(&peer, crate::backup::Request::Put(blob.clone()));
        }
        true
    }

    /// `/mvs/backup/1` from a peer. A fetch gets the blob held under exactly
    /// that tag, or the same empty answer whatever the reason (R3). A write
    /// is kept only from my own other devices (phase A: a peer bound to my
    /// identity), within its rate caps, if it passes `check` and is newer.
    fn on_backup_request(&mut self, peer: PeerId, request: crate::backup::Request, channel: ResponseChannel<Vec<u8>>) {
        let now = Instant::now();
        let answer = match request {
            crate::backup::Request::Get(tag) => {
                let held = if self.backup_limits.allow_fetch(peer, now) { self.store.backup(&tag) } else { Ok(None) };
                held.ok().flatten().unwrap_or_default()
            }
            crate::backup::Request::Put(blob) => {
                let me = self.access.binder.as_ref().map(|b| *b.identity().as_bytes());
                let from = self.member_identity(peer).map(|identity| *identity.as_bytes());
                let owner = crate::backup::write_owner(from, me);
                let kept = crate::backup::check(&blob)
                    .filter(|_| owner.is_some())
                    .filter(|(tag, _)| self.backup_limits.allow_write(peer, *tag, now))
                    .filter(|(tag, version)| {
                        let owner = owner.flatten();
                        self.store.put_backup(tag, *version, &blob, owner.as_ref(), unix_now()).unwrap_or(false)
                    });
                if let Some((tag, _)) = kept {
                    self.provide_backup(tag);
                }
                vec![u8::from(kept.is_some())]
            }
        };
        let _ = self.swarm.behaviour_mut().backup.send_response(channel, answer);
    }

    /// See [`Node::fetch_backup`]: mine if I hold it, one ask to the relay
    /// and each connected peer, and a DHT lookup for the tag's providers
    /// (each asked through our relay's circuit when found).
    fn fetch_backup(&mut self, tag: [u8; 32], reply: oneshot::Sender<Vec<Vec<u8>>>) {
        let id = self.next_fetch;
        self.next_fetch += 1;
        let answers: Vec<Vec<u8>> = self.store.backup(&tag).ok().flatten().into_iter().collect();
        let mut peers: Vec<PeerId> = self.connected.iter().copied().collect();
        peers.truncate(MAX_FETCH_PEERS);
        // Each relay of ours we are connected to (the api keeps the newest
        // valid version of what comes back).
        let relays = self.relays_connected();
        let relayed = !relays.is_empty();
        peers.extend(relays);
        for peer in &peers {
            let request = self.swarm.behaviour_mut().backup.send_request(peer, crate::backup::Request::Get(tag));
            self.backup_fetch_of.insert(request, id);
        }
        let mut waiting = peers.len();
        // The provider lookup only on a fresh device restoring (no server
        // opened yet, nothing held for the tag): it can take seconds, and a
        // writer's round runs in the api's sync loop, so it must stay quick
        // (the relay and my connected devices answer at once).
        let due = self.backup_looked_up.get(&tag).is_none_or(|at| at.elapsed() >= BACKUP_LOOKUP_EVERY);
        if relayed && answers.is_empty() && self.secrets.is_empty() && due {
            if self.backup_looked_up.len() >= MAX_FETCH_PEERS {
                self.backup_looked_up.retain(|_, at| at.elapsed() < BACKUP_LOOKUP_EVERY);
            }
            self.backup_looked_up.insert(tag, Instant::now());
            let query = self.swarm.behaviour_mut().kad.get_providers(kad::RecordKey::new(&tag));
            self.backup_lookups.insert(query, (id, tag));
            waiting += 1;
        }
        if waiting == 0 {
            let _ = reply.send(answers);
            return;
        }
        let until = Instant::now() + BACKUP_FETCH_WAIT;
        self.fetches.insert(id, Fetch { reply, waiting, answers, until });
    }


    /// See [`Node::put_notice`].
    fn put_notice(&mut self, blob: Vec<u8>) -> bool {
        let Some((tag, at)) = crate::notice::check(&blob, unix_now()) else { return false };
        if let Err(err) = self.store.put_notice(&tag, at, &blob, unix_now()) {
            warn!(%err, "keeping my notice failed");
        }
        self.provide_backup(tag);
        for peer in self.notice_holders(usize::MAX) {
            self.swarm.behaviour_mut().notice.send_request(&peer, crate::notice::Request::Put(blob.clone()));
        }
        true
    }

    /// Holders for my notices: my own other devices that are connected,
    /// then the relay (its mailbox, once devops adds `/mvs/notice/1`; an
    /// older one fails at negotiation). At most `max`.
    fn notice_holders(&self, max: usize) -> Vec<PeerId> {
        let mut holders = self.my_devices();
        // Every relay of ours we are connected to (its mailbox).
        holders.extend(self.relays_connected());
        holders.truncate(max);
        holders
    }

    /// `/mvs/notice/1` from a peer. A fetch, if signed for us within the
    /// minute skew and within the caps, gets the notices held under its
    /// tag, newest first; anything else the same empty answer (R3). A write
    /// is kept only from my own other devices (the backup gate, phase A),
    /// within its caps, if it passes `check`.
    fn on_notice_request(&mut self, peer: PeerId, request: crate::notice::Request, channel: ResponseChannel<Vec<u8>>) {
        let now = Instant::now();
        // The cheap gates (rate caps, my own device) come before any
        // signature check (Security Lead on #425).
        let answer = match request {
            crate::notice::Request::Get(fetch) => {
                let me = *self.swarm.local_peer_id();
                let tag = Some(())
                    .filter(|_| self.notice_limits.allow_fetch(peer, now))
                    .and_then(|_| fetch.verify(&me, unix_now() / 60));
                let held = tag.and_then(|tag| self.store.notices(&tag).ok()).unwrap_or_default();
                crate::notice::encode_answer(&held)
            }
            crate::notice::Request::Put(blob) => {
                let me = self.access.binder.as_ref().map(|b| *b.identity().as_bytes());
                let from = self.member_identity(peer).map(|identity| *identity.as_bytes());
                // Phase A: my own devices only (no buddies for notices).
                let mine = crate::backup::write_owner(from, me) == Some(None);
                let kept = crate::notice::claimed_tag(&blob)
                    .filter(|_| mine)
                    .filter(|tag| self.notice_limits.allow_write(peer, *tag, now))
                    .and_then(|_| crate::notice::check(&blob, unix_now()))
                    .filter(|(tag, at)| self.store.put_notice(tag, *at, &blob, unix_now()).unwrap_or(false));
                if let Some((tag, _)) = kept {
                    self.provide_backup(tag);
                }
                vec![u8::from(kept.is_some())]
            }
        };
        let _ = self.swarm.behaviour_mut().notice.send_response(channel, answer);
    }

    /// See [`Node::fetch_notices`]: what I hold for my tag, plus one signed
    /// fetch to each of at most [`NOTICE_HOLDERS`] holders.
    fn fetch_notices(&mut self, reply: oneshot::Sender<Vec<Vec<u8>>>) {
        let Some(signer) = self.notice_signer.clone() else {
            let _ = reply.send(Vec::new());
            return;
        };
        let Some(key) = signer.key() else {
            let _ = reply.send(Vec::new());
            return;
        };
        let answers = self.store.notices(&crate::notice::tag_of(&key)).unwrap_or_default();
        let id = self.next_fetch;
        self.next_fetch += 1;
        let minute = unix_now() / 60;
        let mut waiting = 0;
        for peer in self.notice_holders(NOTICE_HOLDERS) {
            let Some(fetch) = crate::notice::Fetch::sign(&*signer, &peer, minute) else { continue };
            let request = self.swarm.behaviour_mut().notice.send_request(&peer, crate::notice::Request::Get(fetch));
            self.notice_fetch_of.insert(request, id);
            waiting += 1;
        }
        if waiting == 0 {
            let _ = reply.send(answers);
            return;
        }
        let until = Instant::now() + NOTICE_FETCH_WAIT;
        self.fetches.insert(id, Fetch { reply, waiting, answers, until });
    }

    /// A holder's notice answer (or failure) for fetch `id`.
    fn on_notice_answer(&mut self, request: request_response::OutboundRequestId, answer: Option<Vec<u8>>) {
        let Some(id) = self.notice_fetch_of.remove(&request) else { return };
        // Only valid notices under my own tag come back (Security Lead on
        // #425): the core checks again, but junk never reaches it.
        let mine = self.notice_signer.as_ref().and_then(|s| s.key()).map(|key| crate::notice::tag_of(&key));
        if let Some(fetch) = self.fetches.get_mut(&id) {
            for notice in crate::notice::decode_answer(&answer.unwrap_or_default()) {
                let valid = crate::notice::check(&notice, unix_now()).is_some_and(|(tag, _)| Some(tag) == mine);
                if valid && !fetch.answers.contains(&notice) {
                    fetch.answers.push(notice);
                }
            }
        }
        self.fetch_answered(id, None);
    }

    /// See [`Node::start_lan_beacon`].
    fn start_lan_beacon(&mut self, port: u16) -> bool {
        if self.beacon.is_some() {
            return true;
        }
        match crate::lan_beacon::socket(port) {
            Ok(socket) => {
                let socket = Arc::new(socket);
                crate::lan_beacon::spawn_reader(socket.clone(), self.beacons.clone());
                self.beacon = Some(socket);
                self.beacon_port = port;
                self.beacon_next = Instant::now();
                true
            }
            Err(err) => {
                warn!(%err, "LAN beacon unavailable");
                false
            }
        }
    }

    /// The beacon runs only with "LAN allowed", not relay-only, direct dials
    /// on, and some server open (Security Lead §B.6).
    fn beacon_on(&self) -> bool {
        self.beacon.is_some() && self.allow_lan && !self.relay_only && self.direct_dials && !self.secrets.is_empty()
    }

    /// Our open servers' beacon keys.
    fn beacon_keys(&self) -> Vec<(ServerId, [u8; 32])> {
        let mut keys: Vec<(ServerId, [u8; 32])> =
            self.secrets.iter().map(|(server, secret)| (*server, crate::lan_beacon::k_lan(secret))).collect();
        keys.sort_by_key(|(server, _)| *server.as_bytes());
        keys
    }

    /// Sends our beacon when due. With more open servers than slots, they
    /// take turns.
    fn lan_beacon_tick(&mut self) {
        let now = Instant::now();
        if !self.beacon_on() || now < self.beacon_next {
            return;
        }
        self.beacon_next = crate::lan_beacon::next_beacon(now);
        let (Some(socket), Some(port)) = (self.beacon.clone(), self.tcp_port) else { return };
        let mut keys: Vec<[u8; 32]> = self.beacon_keys().into_iter().map(|(_, k)| k).collect();
        if keys.len() > crate::lan_beacon::SLOTS {
            let start = self.beacon_round % keys.len();
            keys.rotate_left(start);
            self.beacon_round = self.beacon_round.wrapping_add(crate::lan_beacon::SLOTS);
        }
        let epoch = crate::lan_beacon::epoch_of(unix_now());
        // Our LAN addresses (sealed, so members dial only those): the ones
        // we listen on, loopback last.
        let mut ips: Vec<std::net::Ipv4Addr> = self
            .swarm
            .listeners()
            .filter_map(|a| match a.iter().next() {
                Some(Protocol::Ip4(ip)) if crate::lan_beacon::lan_scope(ip) => Some(ip),
                _ => None,
            })
            .collect();
        ips.sort_by_key(|ip| (ip.is_loopback(), *ip));
        ips.dedup();
        let Some(packet) = crate::lan_beacon::encode(&keys, epoch, port, self.swarm.local_peer_id(), &ips) else { return };
        let to = std::net::SocketAddr::from((crate::lan_beacon::GROUP, self.beacon_port));
        if let Err(err) = socket.try_send_to(&packet, to) {
            debug!(%err, "LAN beacon send failed");
        }
    }

    /// A beacon heard on the LAN: if it is a co-member's (a tag of one of
    /// our servers) and its LAN-scope source is one of the addresses it
    /// sealed, dial that address at its port, expecting its peer ID. A
    /// replay from any other host is never dialled (#460). Never answered.
    fn on_beacon(&mut self, ip: std::net::IpAddr, packet: Vec<u8>) {
        let now = Instant::now();
        let lan = matches!(ip, std::net::IpAddr::V4(v4) if crate::lan_beacon::lan_scope(v4));
        if !lan || !self.beacon_on() || !self.beacon_limits.allow_read(now) {
            return;
        }
        let epoch = crate::lan_beacon::epoch_of(unix_now());
        let Some(beacon) = crate::lan_beacon::decode(&packet, &self.beacon_keys(), epoch) else { return };
        let Some(source) = crate::lan_beacon::dial_target(ip, &beacon) else {
            debug!("a LAN beacon from an address it didn't seal: not dialled");
            return;
        };
        let (port, peer) = (beacon.port, beacon.peer);
        let ip = std::net::IpAddr::V4(source);
        if peer == *self.swarm.local_peer_id() || self.direct.contains_key(&peer) || self.link_blocks(&peer) {
            return;
        }
        if !self.beacon_limits.allow_dial(std::net::SocketAddr::new(ip, port), now) {
            return;
        }
        let addr = Multiaddr::from(ip).with(Protocol::Tcp(port));
        debug!(%peer, "a co-member's LAN beacon: dialling it");
        let opts = DialOpts::peer_id(peer).addresses(vec![addr]).condition(PeerCondition::Always).build();
        if let Err(err) = self.swarm.dial(opts) {
            debug!(%peer, ?err, "LAN beacon dial refused");
        }
    }

    /// Providers found for a backup fetch's tag: each asked once, through
    /// our relay's circuit (R3), at most [`MAX_BACKUP_PROVIDERS`]. The
    /// lookup's own wait ends on its last step.
    /// `peer`'s circuit through each relay of ours we are connected to, or
    /// through the live relay's address when none is.
    fn circuits_to(&self, peer: PeerId) -> Vec<Multiaddr> {
        let mut circuits: Vec<Multiaddr> = self
            .relays
            .iter()
            .filter(|r| self.swarm.is_connected(&r.peer))
            .map(|r| r.circuit_addr().with(Protocol::P2p(peer)))
            .collect();
        if circuits.is_empty() {
            circuits.push(self.live_relay().with(Protocol::P2pCircuit).with(Protocol::P2p(peer)));
        }
        circuits
    }

    fn on_backup_providers(&mut self, query: kad::QueryId, providers: Vec<PeerId>, last: bool) {
        let Some(&(id, tag)) = self.backup_lookups.get(&query) else { return };
        let me = *self.swarm.local_peer_id();
        for peer in providers.into_iter().filter(|p| *p != me).take(MAX_BACKUP_PROVIDERS) {
            // One circuit per connected relay of ours: until part C a
            // provider reserved only on relay 2 is unreachable through relay 1.
            for circuit in self.circuits_to(peer) {
                self.swarm.add_peer_address(peer, circuit);
            }
            let request = self.swarm.behaviour_mut().backup.send_request(&peer, crate::backup::Request::Get(tag));
            self.backup_fetch_of.insert(request, id);
            if let Some(fetch) = self.fetches.get_mut(&id) {
                fetch.waiting += 1;
            }
        }
        if last {
            self.backup_lookups.remove(&query);
            self.fetch_answered(id, None);
        }
    }

    /// "Relay only" on: drop the direct listener (identify then announces
    /// only our relay circuit), and stop every direct path. Off: listen
    /// directly again.
    fn set_relay_only(&mut self, on: bool) {
        if on == self.relay_only {
            return;
        }
        self.relay_only = on;
        // G-81: a voice path relay-only now forbids ends at once (TL fix 1).
        self.voice_dirty = true;
        // No hole punching either way while relay-only (GAP-6).
        self.swarm.behaviour_mut().punch.set_enabled(!on);
        if on {
            // Relay-only users never relay for members (design #368 §1); the
            // core turns it on again, if it should be, once this is off.
            self.swarm.behaviour_mut().member_relay.stop();
            // Nor keeps any member's address (Security Lead).
            self.forget_remembered();
            for id in [self.listener.take(), self.quic_listener.take()].into_iter().flatten() {
                self.swarm.remove_listener(id);
            }
            self.direct_candidates.clear();
            // GAP-6r blocker 1: direct connections already open go too (the
            // relay's own excepted). A peer with a parked relayed connection
            // is relayed again at once (ConnectionClosed); one without meets
            // us through a circuit at the next discovery round.
            let direct: Vec<ConnectionId> = self
                .direct
                .iter()
                .filter(|(peer, _)| !self.is_our_relay(peer))
                .flat_map(|(_, conns)| conns.iter().copied())
                .collect();
            if !direct.is_empty() {
                info!(count = direct.len(), "relay only: closing direct connections");
            }
            for id in direct {
                self.swarm.close_connection(id);
            }
        } else {
            match self.swarm.listen_on(self.listen.clone()) {
                Ok(id) => self.listener = Some(id),
                Err(err) => warn!(%err, "listening again failed"),
            }
        }
        info!(on, "relay only");
    }

    /// Lets DCUtR run on our relayed connections to `peer` once it is a
    /// verified member (bound, accepted by our read gate) and relay-only is
    /// off; see `punch`. Each side does this once it verified the other;
    /// until then the side that would answer holds the request.
    fn try_punch(&mut self, peer: PeerId) {
        if self.relay_only
            || self.direct.contains_key(&peer)
            || !self.relayed.contains_key(&peer)
            || self.link_blocks(&peer)
            || !self.is_member(peer)
        {
            return;
        }
        if self.swarm.behaviour_mut().punch.open(peer) {
            debug!(%peer, "hole punching allowed with a member");
        }
    }

    /// Every second: close the punch gate of a peer that stopped being a
    /// member (kicked, or our read gate changed) since we opened it.
    /// Every second: the member relay's gates follow who is a bound current
    /// member now (design #368 §1 rule 1). Never while relay-only.
    fn recheck_member_relay(&mut self) {
        if !self.swarm.behaviour().member_relay.enabled() {
            return;
        }
        let peers: Vec<PeerId> = self.swarm.behaviour().member_relay.connected().copied().collect();
        let members = if self.relay_only { HashSet::new() } else { peers.into_iter().filter(|p| self.is_member(*p)).collect() };
        self.swarm.behaviour_mut().member_relay.set_members(members);
    }

    fn recheck_punch(&mut self) {
        for peer in self.swarm.behaviour().punch.open_peers() {
            if !self.is_member(peer) {
                debug!(%peer, "no longer a member: hole punching closed");
                self.swarm.behaviour_mut().punch.close(peer);
            }
        }
    }

    fn try_direct(&mut self, peer: PeerId) {
        if self.relay_only || self.direct.contains_key(&peer) || !self.relayed.contains_key(&peer) {
            return;
        }
        // Only one side dials first (the smaller peer ID; the other accepts):
        // two simultaneous dials, each from its own listening port, are a TCP
        // simultaneous open that Windows never completes. The larger side
        // dials once later if the pair is still relayed (`direct_fallback`):
        // in turn, never at the same time; e.g. when the smaller side can't
        // reach us, or nobody can reach it.
        if *self.swarm.local_peer_id() > peer {
            if !self.fallback_done.contains(&peer) {
                self.fallback_at.entry(peer).or_insert_with(|| Instant::now() + DIRECT_FALLBACK);
            }
            return;
        }
        self.dial_direct(peer);
    }

    /// The larger side's turn: pairs still relayed `DIRECT_FALLBACK` after
    /// the smaller side's turn get one dial from us.
    fn direct_fallback(&mut self) {
        let now = Instant::now();
        let due: Vec<PeerId> = self.fallback_at.iter().filter(|(_, at)| **at <= now).map(|(p, _)| *p).collect();
        for peer in due {
            self.fallback_at.remove(&peer);
            if self.relay_only || self.direct.contains_key(&peer) || !self.relayed.contains_key(&peer) {
                continue;
            }
            self.fallback_done.insert(peer);
            debug!(%peer, "still relayed: our turn to dial directly");
            self.dial_direct(peer);
        }
    }

    fn dial_direct(&mut self, peer: PeerId) {
        // Device link: no direct dial while a link is open here, nor to a
        // link peer (`try_direct` and `direct_fallback` both end here).
        if !self.direct_dials || self.link_blocks(&peer) {
            return;
        }
        let lan = self.allow_lan && self.is_member(peer);
        let Some(listen_addrs) = self.direct_candidates.get(&peer) else { return };
        let addrs: Vec<Multiaddr> = listen_addrs.iter().filter(|a| dialable(a, lan)).cloned().collect();
        if addrs.is_empty() {
            debug!(%peer, lan, candidates = listen_addrs.len(), "no direct address to try");
            return;
        }
        debug!(%peer, lan, addrs = addrs.len(), "trying a direct connection");
        let opts = DialOpts::peer_id(peer).addresses(addrs).condition(PeerCondition::Always).build();
        if let Err(err) = self.swarm.dial(opts) {
            debug!(%peer, ?err, "direct dial refused");
        }
    }

    /// Pulls the logs we just wrote to, so receipt acks come back quickly.
    fn pull_soon(&mut self) {
        // Receipt acks come only from members bound to the log's server, so
        // only they are asked: a write burst while unrelated peers are
        // connected no longer floods them with pulls.
        for log in std::mem::take(&mut self.soon) {
            let server = self.sealing.get(&log).map(|s| s.server);
            for peer in self.connected.clone() {
                if server.is_none_or(|server| self.bound.contains_key(&(peer, server))) {
                    self.pull(peer, &log, "soon");
                }
            }
        }
    }

    fn pull_all(&mut self, cause: &'static str) {
        self.pull_round = self.pull_round.wrapping_add(1);
        for peer in self.connected.clone() {
            self.pull_shared(peer, cause, PULLS_PER_PEER_ROUND);
        }
    }

    /// Sends `peer` the next queued pull, control logs first (where joins
    /// and bindings start), while fewer than [`MAX_PULLS_IN_FLIGHT`] are out.
    fn pull_next(&mut self, peer: PeerId) {
        let Some(queue) = self.queued_pulls.get_mut(&peer) else { return };
        let next = queue.iter().find(|log| log.ends_with(CONTROL_SUFFIX)).or_else(|| queue.iter().next()).cloned();
        let Some(log) = next else {
            self.queued_pulls.remove(&peer);
            return;
        };
        queue.remove(&log);
        self.pull(peer, &log, "queue");
    }

    /// Whether `log` is worth pulling from `peer`. A plain-named log, and a
    /// server's control log (where bindings and joins start), from anyone;
    /// a channel log only from a peer bound to its server. A long-used node
    /// with many servers so no longer pulls every channel it holds from a
    /// peer that shares one server (it would refuse most of them).
    fn shares(&self, peer: PeerId, log: &str) -> bool {
        match self.sealing.get(log) {
            None => true,
            Some(sealed) => {
                log == log_name(sealed.server, Scope::Control) || self.bound.contains_key(&(peer, sealed.server))
            }
        }
    }

    /// The channel logs of `server` we share with `peer`, pulled at once
    /// (`peer` just bound for it).
    fn pull_bound_channels(&mut self, peer: PeerId, server: ServerId) {
        let logs: Vec<String> = self
            .logs
            .iter()
            .filter(|log| !log.ends_with(CONTROL_SUFFIX))
            .filter(|log| self.sealing.get(log).is_some_and(|s| s.server == server))
            .filter(|log| self.shares(peer, log))
            .cloned()
            .collect();
        for log in logs {
            self.pull(peer, &log, "bound");
        }
    }

    /// Pulls `peer`'s share of our logs, at most `limit` (a round:
    /// [`PULLS_PER_PEER_ROUND`]; a first contact: [`FIRST_CONTACT_PULLS`]):
    /// those of servers it is bound to first, then the other control
    /// logs in turn (a different slice each round), so a node with many
    /// servers never sends a peer more pulls than its limits take. `pull`
    /// also keeps at most [`MAX_PULLS_IN_FLIGHT`] out at once.
    fn pull_shared(&mut self, peer: PeerId, cause: &'static str, limit: usize) {
        let (mut bound, mut rest): (Vec<String>, Vec<String>) = self
            .logs
            .iter()
            .filter(|log| self.shares(peer, log))
            .cloned()
            .partition(|log| self.sealing.get(log).is_none_or(|s| self.bound.contains_key(&(peer, s.server))));
        // T23: `rest` are control logs of servers this peer isn't bound for.
        // Asking carries our binding, so: never one it answered empty lately,
        // and for a server we already have a bound member of, at most one
        // probe per UNBOUND_REPROBE (two members who meet late still bind).
        let now = Instant::now();
        rest.retain(|log| {
            if self.empty_from.get(&(peer, log.clone())).is_some_and(|until| now < *until) {
                return false;
            }
            let Some(server) = self.sealing.get(log).map(|s| s.server) else { return true };
            let member_bound = self.bound.keys().any(|(_, s)| *s == server);
            !member_bound || self.probed.get(&(peer, server)).is_none_or(|at| now >= *at + UNBOUND_REPROBE)
        });
        bound.sort();
        rest.sort();
        bound.truncate(limit);
        let room = limit - bound.len();
        if !rest.is_empty() && room > 0 {
            let start = self.pull_round.wrapping_mul(room) % rest.len();
            let probes: Vec<String> = (0..room.min(rest.len())).map(|i| rest[(start + i) % rest.len()].clone()).collect();
            for log in &probes {
                if let Some(server) = self.sealing.get(log).map(|s| s.server) {
                    if self.bound.keys().any(|(_, s)| *s == server) {
                        cap_oldest(&mut self.probed, &(peer, server), |at| *at);
                        self.probed.insert((peer, server), now);
                    }
                }
            }
            bound.extend(probes);
        }
        for log in bound {
            self.pull(peer, &log, cause);
        }
    }

    fn pull(&mut self, peer: PeerId, log: &str, cause: &'static str) {
        let key = (peer, log.to_string());
        // T23 on every path (round, queue, again, more…): a control log an
        // unbound peer answered empty lately isn't asked for again.
        if self.empty_from.get(&key).is_some_and(|until| Instant::now() < *until) {
            self.again.remove(&key);
            return;
        }
        if self.decoding.contains(&key) || self.inflight.values().any(|k| *k == key) {
            self.again.insert(key);
            return;
        }
        // At most MAX_PULLS_IN_FLIGHT out to one peer; the rest wait their
        // turn (`pull_next`) instead of being refused for its byte budget.
        // T24: and no faster than the answering side's rate, so a burst
        // (opening many servers, quick answers freeing slots) never runs past
        // its limit; the queue drains on the 1 s tick.
        if self.inflight.values().filter(|(p, _)| *p == peer).count() >= MAX_PULLS_IN_FLIGHT
            || !self.outbound_pulls.allow(peer, Instant::now())
        {
            self.queued_pulls.entry(peer).or_default().insert(key.1);
            return;
        }
        // Records we refused count as "have", so the peer stops sending them.
        let mut have = self.refused.markers(log, MAX_REFUSED_MARKERS);
        match self.store.have_markers(log) {
            Ok(markers) => have.extend(markers.into_iter().take(MAX_HAVE - have.len())),
            Err(err) => return warn!(%err, "reading markers failed"),
        }
        let have = have.into_iter().map(|id| ByteBuf::from(id.as_bytes().to_vec())).collect();
        let binding = self.sealing.get(log).map(|s| s.server).and_then(|server| self.own_binding(server));
        let request = SyncRequest { log: self.sealing.wire(log), have, binding };
        // Why this pull went out, for sync debug logs (mvs.log through
        // MVS_DEBUG_LOG): the trigger only, never the peer or the log name.
        // `bound`: whether the peer is bound for the log's server (a member
        // pull) or not (a probe that carries our binding, T23).
        let bound = self.sealing.get(log).is_none_or(|s| self.bound.contains_key(&(peer, s.server)));
        debug!(cause, bound, in_flight = self.inflight.values().filter(|(p, _)| *p == peer).count(), "pull sent");
        let request = self.swarm.behaviour_mut().sync.send_request(&peer, request);
        self.inflight.insert(request, key);
    }

    /// Our binding for a server's pulls, re-signed when it nears expiry.
    /// None without a binder.
    fn own_binding(&mut self, server: ServerId) -> Option<Binding> {
        let binder = self.access.binder.clone()?;
        let now = unix_now();
        if let Some(binding) = self.own_bindings.get(&server) {
            if binding.expiry() > now + BINDING_RENEW.as_secs() {
                return Some(binding.clone());
            }
        }
        let control = self.secrets.get(&server)?.handle(Scope::Control);
        let me = *self.swarm.local_peer_id();
        let binding = Binding::sign(&*binder, &me, &control, now + BINDING_TTL.as_secs());
        self.own_bindings.insert(server, binding.clone());
        Some(binding)
    }

    /// The identity `peer` proved for `server` with `binding`. A verified
    /// binding is kept for the connection, so a repeat isn't re-verified.
    fn bound_identity(&mut self, peer: PeerId, server: ServerId, binding: Option<Binding>) -> Option<PublicKey> {
        let identity = self.verify_binding(peer, server, binding?)?;
        self.mark_seen(server, identity, peer);
        self.remember_member(peer);
        Some(identity)
    }

    fn verify_binding(&mut self, peer: PeerId, server: ServerId, binding: Binding) -> Option<PublicKey> {
        let now = unix_now();
        if let Some((known, identity)) = self.bound.get(&(peer, server)) {
            if *known == binding && binding.expiry().saturating_add(access::CLOCK_SKEW.as_secs()) >= now {
                return Some(*identity);
            }
        }
        let control = self.secrets.get(&server)?.handle(Scope::Control);
        let identity = binding.verify(&peer, &control, now)?;
        let new = self.bound.insert((peer, server), (binding, identity)).is_none();
        // Now bound: a LAN address it reported may be tried (F2).
        self.try_direct(peer);
        self.try_punch(peer);
        if new {
            // T8-02: a member who was offline catches up on live invites.
            self.share_invites(peer, server);
            // Bound now: its answers for this server count again (T23).
            self.empty_from.retain(|(p, log), _| {
                *p != peer || self.sealing.get(log).is_none_or(|s| s.server != server)
            });
            // Now it shares this server's channels (`shares`): pull them at
            // once rather than at the next anti-entropy round.
            let channels: Vec<String> = self
                .logs
                .iter()
                .filter(|log| {
                    self.sealing.get(log).is_some_and(|s| s.server == server)
                        && **log != log_name(server, Scope::Control)
                })
                .cloned()
                .collect();
            for log in channels {
                self.pull(peer, &log, "bound");
            }
        }
        Some(identity)
    }

    /// Presence (M2): `identity` proved itself on `peer` just now.
    fn mark_seen(&mut self, server: ServerId, identity: PublicKey, peer: PeerId) {
        if self.access.binder.as_ref().is_some_and(|b| b.identity() == identity) {
            return;
        }
        self.last_seen.insert(server, SystemTime::now());
        if self.presence.seen(server, identity, peer, Instant::now()) {
            self.emit(NodeEvent::Presence { server, identity, online: true });
        }
    }

    fn went_offline(&mut self, gone: Vec<(ServerId, PublicKey)>) {
        for (server, identity) in gone {
            self.last_seen.insert(server, SystemTime::now());
            self.emit(NodeEvent::Presence { server, identity, online: false });
        }
    }

    fn on_swarm_event(&mut self, event: SwarmEvent<BehaviourEvent>) {
        // G-81: each connection's kind, for choosing voice paths.
        match &event {
            SwarmEvent::ConnectionEstablished { connection_id, endpoint, .. } => {
                let kind = self.voice_kind(endpoint);
                self.voice_conns.insert(*connection_id, kind);
                self.voice_dirty = true;
            }
            SwarmEvent::ConnectionClosed { connection_id, .. } => {
                self.voice_conns.remove(connection_id);
                self.voice_dirty = true;
            }
            _ => {}
        }
        match event {
            SwarmEvent::ConnectionEstablished { peer_id, connection_id, endpoint, .. } => {
                self.dial_backoff.lock().unwrap().connected(&peer_id);
                self.fallback_dials.remove(&connection_id);
                if let ConnectedPoint::Dialer { address, .. } = &endpoint {
                    if let Some((a, _)) = self.bootstrap.iter().find(|(a, _)| without_peer(a) == without_peer(address)) {
                        self.bootstrap_conns.insert(connection_id, a.clone());
                    }
                }
                if !self.admit_by_ip(connection_id, &endpoint) {
                    debug!(%peer_id, "too many connections from one address");
                    self.swarm.close_connection(connection_id);
                    return;
                }
                // Relay-only: a direct connection to anyone but the relay
                // (a dial or punch already under way when it was turned on)
                // is closed as soon as it opens.
                if self.relay_only && !self.is_our_relay(&peer_id) && !is_relayed(&endpoint) {
                    debug!(%peer_id, "relay only: closing a direct connection");
                    self.swarm.close_connection(connection_id);
                    return;
                }
                if !self.is_our_relay(&peer_id) {
                    self.track_connection(peer_id, connection_id, &endpoint);
                    if is_relayed(&endpoint) {
                        self.try_punch(peer_id);
                        self.flush_link_waiting();
                    }
                }
                if let Some(relay) = self.relays.iter_mut().find(|r| r.peer == peer_id) {
                    relay.backoff = RELAY_BACKOFF_MIN;
                    let me = *self.swarm.local_peer_id();
                    self.swarm.behaviour_mut().kad.get_closest_peers(me);
                } else if self.connected.insert(peer_id) {
                    // Peer ID with its address only at debug level (PR checklist).
                    debug!(%peer_id, relayed = is_relayed(&endpoint), "peer connected");
                    info!(%peer_id, "peer connected");
                    self.reached = true;
                    self.emit(NodeEvent::PeerConnected(peer_id));
                    // A new connection is a new chance to bind: drop the
                    // re-probe wait for this peer (a member whose link reset
                    // would otherwise stay unbound, so offline, for up to
                    // UNBOUND_REPROBE). Empty answers still count
                    // (`empty_from`), so a reset doesn't re-probe what it lacks.
                    self.probed.retain(|(p, _), _| *p != peer_id);
                    self.pull_shared(peer_id, "connect", FIRST_CONTACT_PULLS);
                }
            }
            SwarmEvent::ConnectionClosed { peer_id, connection_id, num_established, .. } => {
                self.per_ip.release(connection_id);
                self.bootstrap_conns.remove(&connection_id);
                self.relayed_preferred.remove(&connection_id);
                self.relay_ping_misses.remove(&connection_id);
                let had_direct = self.direct.contains_key(&peer_id);
                for conns in [&mut self.relayed, &mut self.direct, &mut self.parked] {
                    if let Some(set) = conns.get_mut(&peer_id) {
                        set.remove(&connection_id);
                        if set.is_empty() {
                            conns.remove(&peer_id);
                        }
                    }
                }
                if had_direct && !self.direct.contains_key(&peer_id) {
                    if let Some(parked) = self.parked.remove(&peer_id) {
                        debug!(%peer_id, "direct connection gone: relayed again");
                        self.relayed.insert(peer_id, parked);
                        self.emit(NodeEvent::Link { peer: peer_id, direct: false });
                        self.flush_link_waiting();
                    }
                }
                if num_established > 0 {
                    return;
                }
                if let Some(i) = self.relays.iter().position(|r| r.peer == peer_id) {
                    // The reservation went with the connection (e.g. the relay
                    // restarted): ask for a new one once we're back. "Down" for
                    // the member relay fallback only once all our relays are.
                    info!(relay = i, "relay connection lost");
                    if let Some(id) = self.relays[i].circuit.take() {
                        self.swarm.remove_listener(id);
                    }
                    let relay = &mut self.relays[i];
                    relay.next_dial = Instant::now() + jittered(relay.backoff, OsRng.next_u32());
                    if self.relays_connected().is_empty() {
                        self.relay_lost();
                    }
                }
                if self.connected.remove(&peer_id) {
                    info!(%peer_id, "peer disconnected");
                    self.emit(NodeEvent::PeerDisconnected(peer_id));
                }
                self.bound.retain(|(p, _), _| *p != peer_id);
                self.direct_candidates.remove(&peer_id);
                self.fallback_at.remove(&peer_id);
                self.fallback_done.remove(&peer_id);
                let gone = self.presence.disconnected(&peer_id);
                self.went_offline(gone);
                self.inflight.retain(|_, (p, _)| *p != peer_id);
                self.decoding.retain(|(p, _)| *p != peer_id);
                self.again.retain(|(p, _)| *p != peer_id);
                self.queued_pulls.remove(&peer_id);
            }
            SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) => {
                if let Some(i) = self.relays.iter().position(|r| r.peer == peer_id) {
                    // Relay circuit as a fallback for peers that can't reach us
                    // directly (NAT). On a LAN the direct address wins.
                    if self.relays[i].circuit.is_none() {
                        self.listen_on_circuit(i);
                    }
                } else {
                    // Only addresses we would dial ourselves go into our DHT
                    // table (which, in server mode, we also serve to others).
                    // Never a circuit through any relay but ours (member relays).
                    let known: Vec<Multiaddr> = info
                        .listen_addrs
                        .iter()
                        .filter(|a| self.reachable(a) && (self.via_ours(a) || !a.iter().any(|p| p == Protocol::P2pCircuit)))
                        .cloned()
                        .collect();
                    for addr in known {
                        self.swarm.behaviour_mut().kad.add_address(&peer_id, addr);
                    }
                    // F2: LAN addresses only ever from a connected peer, kept for a
                    // direct upgrade once it proved who it is (a GAP-4 binding).
                    if self.relayed.contains_key(&peer_id) {
                        self.direct_candidates.insert(peer_id, direct_candidates_of(info.listen_addrs));
                        self.try_direct(peer_id);
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::RelayClient(relay::client::Event::ReservationReqAccepted { relay_peer_id, renewal, .. })) => {
                let Some(i) = self.relays.iter().position(|r| r.peer == relay_peer_id) else {
                    // A member relay (slice 2): our circuit there is for members
                    // only, never announced (identify, DHT).
                    if !renewal {
                        debug!("reserved on a member relay");
                    }
                    return;
                };
                self.relay_back();
                if !renewal {
                    // Reachable through the relay now: look for peers and catch
                    // up at once rather than at the next timer tick.
                    info!(relay = i, "relay reservation accepted");
                    self.reached = true;
                    self.emit(NodeEvent::RelayReserved);
                    let me = *self.swarm.local_peer_id();
                    self.swarm.behaviour_mut().kad.get_closest_peers(me);
                    // G-91: our provider records carry our circuit: without
                    // an address the relay answers with its routing table's,
                    // which may not hold us. And the backups we hold are
                    // announced again (a restarted relay forgot them).
                    self.swarm.add_external_address(self.relays[i].circuit_addr());
                    for tag in self.store.notice_tags().unwrap_or_default() {
                        self.provide_backup(tag);
                    }
                    for tag in self.store.backup_tags().unwrap_or_default() {
                        self.provide_backup(tag);
                    }
                    self.pull_all("reservation");
                }
            }
            SwarmEvent::NewListenAddr { listener_id, address } if Some(listener_id) == self.listener => {
                save_port(&self.port_file, &address);
                if let Some(Protocol::Tcp(port)) = address.iter().find(|p| matches!(p, Protocol::Tcp(_))) {
                    self.tcp_port = Some(port);
                }
                // QUIC once the TCP port is known, on the same port, so one
                // router or firewall rule (and NAT mapping) covers both.
                // Removed with the TCP listener while relay-only.
                if self.quic_listener.is_none() && !self.relay_only {
                    self.quic_listener = listen_quic(&mut self.swarm, &self.listen, &address);
                }
            }
            SwarmEvent::NewListenAddr { listener_id, .. } if self.member_listeners.contains_key(&listener_id) => {
                self.member_reserved.insert(listener_id);
            }
            SwarmEvent::ListenerClosed { listener_id, .. } if self.member_listeners.contains_key(&listener_id) => {
                self.member_listener_closed(listener_id);
            }
            SwarmEvent::ListenerClosed { listener_id, .. } if self.relays.iter().any(|r| r.circuit == Some(listener_id)) => {
                // Reservation refused or lost: the next discovery tick asks again.
                let relay = self.relays.iter_mut().find(|r| r.circuit == Some(listener_id)).expect("just seen");
                relay.circuit = None;
                let circuit = relay.circuit_addr();
                self.swarm.remove_external_address(&circuit);
            }
            SwarmEvent::OutgoingConnectionError { connection_id, peer_id: Some(peer), error, .. } if !self.is_our_relay(&peer) => {
                // Back off this peer, and forget circuit addresses that failed
                // (a reservation that ended): the relay denies each such dial.
                // A dial our own guard refused isn't a new failure.
                // Nor is an extra dial to a peer we are connected to (a
                // direct or hole-punch attempt that failed).
                // Nor a dial through a member relay to a member who holds no
                // reservation there (the fallback tries each known member).
                let fallback = self.fallback_dials.remove(&connection_id);
                if !fallback && !matches!(error, libp2p::swarm::DialError::Denied { .. }) && !self.connected.contains(&peer) {
                    let jitter = |wait| jittered(wait, OsRng.next_u32());
                    self.dial_backoff.lock().unwrap().failed(peer, Instant::now(), jitter);
                }
                if let libp2p::swarm::DialError::Transport(failed) = &error {
                    for (addr, _) in failed {
                        if addr.iter().any(|p| p == Protocol::P2pCircuit) {
                            self.swarm.behaviour_mut().kad.remove_address(&peer, addr);
                        }
                    }
                }
                debug!(%peer, ?error, "dial failed");
            }
            // Slice 2: Kademlia also files the address a connection was dialled
            // on; a circuit through a member relay must never reach the DHT we
            // serve (design #368 §1 rule 2), so it is taken out again at once.
            // A silently dead connection to our relay is closed after
            // RELAY_PING_MISSES failed pings, so the fallback clock starts.
            SwarmEvent::Behaviour(BehaviourEvent::Ping(ping::Event { peer, connection, result })) if self.is_our_relay(&peer) => {
                let misses = self.relay_ping_misses.entry(connection).or_insert(0);
                if relay_ping(misses, result.is_ok()) {
                    self.relay_ping_misses.remove(&connection);
                    info!("our relay stopped answering pings: closing its connection");
                    self.swarm.close_connection(connection);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::RoutingUpdated { peer, addresses, .. })) => {
                // One of our relays (any configured relay ID, Security Lead on
                // part B): only its own configured address stays; every
                // address learned for it from the DHT or a peer goes.
                if let Some(relay) = self.relays.iter().find(|r| r.peer == peer) {
                    let configured = relay.addr.clone();
                    // Kept first: removing the last address drops the peer.
                    if !addresses.iter().any(|a| is_configured_relay(a, &configured)) {
                        self.swarm.behaviour_mut().kad.add_address(&peer, configured.clone());
                    }
                    for addr in addresses.iter().filter(|a| !is_configured_relay(a, &configured)) {
                        self.swarm.behaviour_mut().kad.remove_address(&peer, addr);
                    }
                    return;
                }
                let ours: Vec<Multiaddr> = self.relays.iter().map(|r| r.addr.clone()).collect();
                for addr in addresses.iter().filter(|a| !crate::announce::announceable(a, &ours)) {
                    // Also any DNS name a peer gave (hickory-advisories): never
                    // stored, so never resolved or served to others.
                    if addr.iter().any(|p| p == Protocol::P2pCircuit) || has_dns(addr) {
                        self.swarm.behaviour_mut().kad.remove_address(&peer, addr);
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                result: kad::QueryResult::GetClosestPeers(Ok(ok)),
                ..
            })) => {
                let now = Instant::now();
                for peer in ok.peers {
                    if peer.peer_id == *self.swarm.local_peer_id()
                        || self.connected.contains(&peer.peer_id)
                        || !self.dial_backoff.lock().unwrap().may_dial(&peer.peer_id, now)
                    {
                        continue;
                    }
                    // Peer-supplied addresses: never let them point us into our
                    // own LAN, nor at a DNS name. A circuit through our own relay
                    // (matched by its peer ID) is rebuilt from our configured
                    // relay address instead (P0 on #416: the relay's announced
                    // base can be a DNS name, or another port or transport).
                    let mut addrs: Vec<Multiaddr> = Vec::new();
                    for a in peer.addrs {
                        let usable = if self.via_ours(&a) {
                            Some(a)
                        } else if let Some(rebuilt) = self.rebuilt_circuit(&a, &peer.peer_id) {
                            Some(rebuilt)
                        } else {
                            (!self.relay_only && reachable(&a, false)).then_some(a)
                        };
                        if let Some(a) = usable.filter(|a| !addrs.contains(a)) {
                            addrs.push(a);
                        }
                    }
                    if addrs.is_empty() {
                        continue;
                    }
                    debug!(peer = %peer.peer_id, "discovered");
                    let opts = DialOpts::peer_id(peer.peer_id)
                        .addresses(addrs)
                        .condition(PeerCondition::DisconnectedAndNotDialing)
                        .build();
                    let _ = self.swarm.dial(opts);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message {
                propagation_source,
                message_id,
                message,
            })) => {
                let acceptance = self.on_gossip(propagation_source, &message);
                let _ = self.swarm.behaviour_mut().gossipsub.report_message_validation_result(
                    &message_id,
                    &propagation_source,
                    acceptance,
                );
            }
            SwarmEvent::Behaviour(BehaviourEvent::Sync(request_response::Event::Message { peer, message, .. })) => {
                match message {
                    request_response::Message::Request { request, channel, .. } => self.on_request(peer, request, channel),
                    request_response::Message::Response { request_id, response } => {
                        if let Some(key) = self.inflight.remove(&request_id) {
                            self.on_response(key, response);
                            self.pull_next(peer);
                        }
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Voice(request_response::Event::Message {
                peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            })) => self.on_voice(peer, request, channel),
            SwarmEvent::Behaviour(BehaviourEvent::Voice(request_response::Event::OutboundFailure {
                peer, error, ..
            })) => debug!(%peer, %error, "voice signal not delivered"),
            SwarmEvent::Behaviour(BehaviourEvent::VoiceMedia(event)) => self.on_voice_media(event),
            SwarmEvent::Behaviour(BehaviourEvent::Typing(request_response::Event::Message {
                peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            })) => self.on_typing(peer, request, channel),
            SwarmEvent::Behaviour(BehaviourEvent::Typing(request_response::Event::OutboundFailure {
                peer, error, ..
            })) => debug!(%peer, %error, "typing signal not delivered"),
            SwarmEvent::Behaviour(BehaviourEvent::Report(request_response::Event::Message {
                peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            })) => self.on_report(peer, request, channel),
            SwarmEvent::Behaviour(BehaviourEvent::Report(request_response::Event::Message {
                message: request_response::Message::Response { request_id, .. },
                ..
            })) => {
                if let Some(reply) = self.report_pending.remove(&request_id) {
                    let _ = reply.send(Ok(()));
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Report(request_response::Event::OutboundFailure {
                peer, request_id, error, ..
            })) => {
                debug!(%peer, %error, "report box not delivered");
                if let Some(reply) = self.report_pending.remove(&request_id) {
                    let _ = reply.send(Err(ReportError::NotAcked));
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::InvitePub(request_response::Event::Message {
                peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            })) => self.on_invite_push(peer, request, channel),
            SwarmEvent::Behaviour(BehaviourEvent::InvitePub(request_response::Event::OutboundFailure {
                peer, error, ..
            })) => debug!(%peer, %error, "invite publication not delivered"),
            SwarmEvent::Behaviour(BehaviourEvent::InviteAsk(request_response::Event::Message { peer, message, .. })) => {
                match message {
                    request_response::Message::Request { request, channel, .. } => {
                        self.on_invite_ask(peer, request, channel)
                    }
                    request_response::Message::Response { request_id, response } => {
                        self.on_invite_answer(request_id, Some(response))
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::InviteAsk(request_response::Event::OutboundFailure {
                request_id,
                ..
            })) => self.on_invite_answer(request_id, None),
            SwarmEvent::Behaviour(BehaviourEvent::Notice(request_response::Event::Message { peer, message, .. })) => {
                match message {
                    request_response::Message::Request { request, channel, .. } => {
                        self.on_notice_request(peer, request, channel)
                    }
                    request_response::Message::Response { request_id, response } => {
                        self.on_notice_answer(request_id, Some(response))
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Notice(request_response::Event::OutboundFailure {
                peer,
                request_id,
                error,
                ..
            })) => {
                debug!(%peer, %error, "notice request failed");
                self.on_notice_answer(request_id, None);
            }
            SwarmEvent::Behaviour(BehaviourEvent::Backup(request_response::Event::Message { peer, message, .. })) => {
                match message {
                    request_response::Message::Request { request, channel, .. } => {
                        self.on_backup_request(peer, request, channel)
                    }
                    request_response::Message::Response { request_id, response } => {
                        if let Some(id) = self.backup_fetch_of.remove(&request_id) {
                            self.fetch_answered(id, Some(response));
                        }
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Backup(request_response::Event::OutboundFailure {
                peer,
                request_id,
                error,
                ..
            })) => {
                debug!(%peer, %error, "backup request failed");
                if let Some(id) = self.backup_fetch_of.remove(&request_id) {
                    self.fetch_answered(id, None);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                id,
                result: kad::QueryResult::GetProviders(result),
                step,
                ..
            })) if self.link_finds.contains_key(&id) => {
                let providers = match result {
                    Ok(kad::GetProvidersOk::FoundProviders { providers, .. }) => providers.into_iter().collect(),
                    _ => Vec::new(),
                };
                self.on_link_providers(id, providers, step.last);
            }
            SwarmEvent::Behaviour(BehaviourEvent::DeviceLink(request_response::Event::Message { peer, message, .. })) => {
                match message {
                    request_response::Message::Request { request, channel, .. } => {
                        self.on_link_request(peer, request, channel)
                    }
                    request_response::Message::Response { request_id, response } => {
                        if let Some(reply) = self.link_out.remove(&request_id) {
                            let _ = reply.send(crate::device_link::outcome(response));
                        }
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::DeviceLink(request_response::Event::OutboundFailure {
                peer,
                request_id,
                error,
                ..
            })) => {
                debug!(%peer, %error, "device link request failed");
                if let Some(reply) = self.link_out.remove(&request_id) {
                    let _ = reply.send(Err(LinkError::Network));
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                id,
                result: kad::QueryResult::GetProviders(result),
                step,
                ..
            })) if self.backup_lookups.contains_key(&id) => {
                let providers = match result {
                    Ok(kad::GetProvidersOk::FoundProviders { providers, .. }) => providers.into_iter().collect(),
                    _ => Vec::new(),
                };
                self.on_backup_providers(id, providers, step.last);
            }
            SwarmEvent::Behaviour(BehaviourEvent::Punch(libp2p::dcutr::Event { remote_peer_id, result })) => {
                // A success shows up as a direct connection: `track_connection`
                // flips the link to direct and parks the relayed one (#206).
                // A failure leaves the relayed connection as it is.
                match result {
                    Ok(_) => info!(peer = %remote_peer_id, "hole punch succeeded"),
                    Err(err) => debug!(peer = %remote_peer_id, %err, "hole punch failed: staying relayed"),
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Sync(request_response::Event::OutboundFailure {
                peer,
                request_id,
                error,
                ..
            })) => {
                debug!(%peer, %error, "pull failed");
                // The anti-entropy timer retries.
                if let Some(key) = self.inflight.remove(&request_id) {
                    self.again.remove(&key);
                    self.pull_next(peer);
                }
            }
            _ => {}
        }
    }

    /// Rate-limits a pull, then answers it on a blocking thread with the
    /// read-only connection. Dropping the channel fails the request on the
    /// other side.
    fn on_request(&mut self, peer: PeerId, request: SyncRequest, channel: ResponseChannel<SyncResponse>) {
        #[cfg(test)]
        {
            self.pulls_received += 1;
        }
        let now = Instant::now();
        if !self.inbound_pulls.allow(peer, now) || !self.all_inbound_pulls.allow((), now) {
            debug!(%peer, "pull rate limit exceeded");
            #[cfg(test)]
            {
                self.rate_limited += 1;
            }
            return;
        }
        let Some(Readable { log, check: gate, reader }) = self.who_may_read(peer, request.log, request.binding) else {
            let _ = self.swarm.behaviour_mut().sync.send_response(channel, empty_response());
            return;
        };
        if self.answering >= MAX_ANSWERING {
            debug!(%peer, "too many pulls being answered");
            #[cfg(test)]
            {
                self.rate_limited += 1;
            }
            return;
        }
        // A ~100-byte request can ask for a 4 MiB page: the page is cut to the
        // bytes this peer, and all peers together, may still be sent now.
        let budget = self.served_bytes.available(peer, now).min(self.all_served_bytes.available((), now));
        if budget < MIN_PAGE_BUDGET {
            debug!(%peer, "served-bytes budget exhausted");
            #[cfg(test)]
            {
                self.rate_limited += 1;
            }
            return;
        }
        let max_bytes = budget.min(PAGE_BYTES);
        // Reserved now, so answers running at the same time can't all spend
        // the same budget; the unused part is refunded when the page is sent.
        self.served_bytes.charge(peer, now, max_bytes);
        self.all_served_bytes.charge((), now, max_bytes);
        self.answering += 1;
        // Our binding (presence, M2) and receipt acks for the requester's own
        // records (B6) go only to a requester our read gate accepts as a
        // member: a leaked-link holder learns neither who we are nor what
        // we stored.
        let acks = reader.map(|r| self.acks.take(&r, MAX_ACKS, now)).unwrap_or_default();
        let ours = match (reader, self.access.read_gate.clone()) {
            (Some((server, identity)), Some(gate)) => {
                self.own_binding(server).map(|binding| (ReadCheck { gate, identity, server }, binding))
            }
            _ => None,
        };
        let allow_lan = self.allow_lan;
        let relay_only = self.relay_only;
        let mine: Vec<Multiaddr> = direct_candidates_of(self.swarm.listeners().cloned().collect());
        // Slice 2: our member relay offer (to members only, in `member_extras`).
        let offer = (!relay_only && self.swarm.behaviour_mut().member_relay.offering()).then(|| RelayOffer {
            addrs: mine.iter().map(|a| ByteBuf::from(a.to_vec())).collect(),
            preferred: self.swarm.behaviour().member_relay.preferred(),
        });
        let store = self.reader.clone();
        let answers = self.answers.clone();
        tokio::task::spawn_blocking(move || {
            let Ok(store) = store.lock() else {
                let _ = answers.send((peer, channel, empty_response(), max_bytes, Vec::new(), log));
                return;
            };
            let (mut response, ids) = match gate {
                Some(gate) if !gate.allows(&store) => (empty_response(), Vec::new()),
                _ => answer_with_ids(&store, &log, &request.have, max_bytes),
            };
            member_extras(&mut response, ours, &acks, &mine, allow_lan && !relay_only, offer.as_ref(), &store);
            let _ = answers.send((peer, channel, response, max_bytes, ids, log));
        });
    }

    /// Which open log a pull names, and the read check still to run on it;
    /// None if `peer` may not have it. A handle needs a valid binding from
    /// `peer`; for a channel, the read gate must also accept the identity.
    /// The control log goes to any bound peer (they know the secret): a
    /// joiner needs it before its own `Join` exists. A plain name serves only
    /// a log opened by name.
    fn who_may_read(&mut self, peer: PeerId, wire: String, binding: Option<Binding>) -> Option<Readable> {
        let Some(log) = self.sealing.log_of_wire(&wire).map(str::to_string) else {
            let plain = self.logs.contains(&wire) && self.sealing.get(&wire).is_none();
            return plain.then_some(Readable { log: wire, check: None, reader: None });
        };
        let (server, scope) = self.sealing.get(&log).map(|s| (s.server, s.scope))?;
        let Some(identity) = self.bound_identity(peer, server, binding) else {
            debug!(%peer, "pull without a valid binding");
            return None;
        };
        let check = match scope {
            Scope::Control => None,
            Scope::Channel(_) => Some(ReadCheck { gate: self.access.read_gate.clone()?, identity, server }),
        };
        Some(Readable { log, check, reader: Some((server, identity)) })
    }

    /// Sends a finished answer, charges its size to the byte budgets, and
    /// reports our own records in it that leave this device for the first time.
    fn send_answer(&mut self, answer: Answer) {
        let (peer, channel, response, reserved, ids, _log) = answer;
        #[cfg(test)]
        {
            *self.served.entry((peer, _log)).or_default() += response.records.len();
        }
        for id in ids {
            if self.unsent.remove(&id) {
                self.emit(NodeEvent::Sent { id });
            }
        }
        self.answering = self.answering.saturating_sub(1);
        let bytes: usize = response.records.iter().map(|r| r.len()).sum();
        let now = Instant::now();
        // Settle the reservation: refund what wasn't used, or charge the
        // overshoot (a page always carries at least one record).
        if bytes < reserved {
            self.served_bytes.refund(peer, now, reserved - bytes);
            self.all_served_bytes.refund((), now, reserved - bytes);
        } else {
            self.served_bytes.charge(peer, now, bytes - reserved);
            self.all_served_bytes.charge((), now, bytes - reserved);
        }
        let _ = self.swarm.behaviour_mut().sync.send_response(channel, response);
    }

    /// Checks a pushed message. Accept forwards it to our mesh peers; Reject
    /// stops it here (and counts against the sender once peer scoring is on);
    /// Ignore neither forwards nor blames (a duplicate, or not judgeable yet).
    fn on_gossip(&mut self, from: PeerId, message: &gossipsub::Message) -> MessageAcceptance {
        let record = match check_pushed(&self.logs, &self.sealing, message) {
            Ok(record) => record,
            Err(Refuse::Ignore) => return MessageAcceptance::Ignore,
            Err(Refuse::Reject) => {
                warn!(%from, "rejected pushed record");
                return MessageAcceptance::Reject;
            }
        };
        match self.ingest(from, record, Via::Push) {
            Ingest::Added => MessageAcceptance::Accept,
            Ingest::Known | Ingest::Waiting | Ingest::Refused => MessageAcceptance::Ignore,
            Ingest::Rejected => MessageAcceptance::Reject,
        }
    }

    /// Stores one record from a peer if it passes the checks, or parks it
    /// until its deps arrive.
    fn ingest(&mut self, from: PeerId, record: Record, via: Via) -> Ingest {
        if self.refused.contains(&record.id()) {
            return Ingest::Refused;
        }
        match self.store.append(&record, &*self.authorizer) {
            Ok(Append::Added) => {
                let id = record.id();
                self.remember_ack(&record);
                self.stored(log_of(&record), record, via, SystemTime::now());
                self.release_pending(id);
                Ingest::Added
            }
            Ok(Append::Known) => {
                self.remember_ack(&record);
                Ingest::Known
            }
            Ok(Append::StubPending) => Ingest::Known,
            Ok(Append::MissingDeps(missing)) if self.refused.covers(&missing) => {
                // Built only on refused records: refused as well.
                self.refused.insert(log_of(&record), record.id());
                Ingest::Refused
            }
            Ok(Append::MissingDeps(missing)) if missing.iter().all(|id| self.pending_stubs.contains_key(id)) => {
                match self.with_pending_stubs(record, &missing, via) {
                    Some(id) => {
                        self.release_pending(id);
                        Ingest::Added
                    }
                    None => Ingest::Waiting,
                }
            }
            Ok(Append::MissingDeps(missing)) => {
                let log = log_of(&record);
                let control = log_name(record.server(), Scope::Control);
                let needs_control = record.auth_deps().iter().any(|d| missing.contains(d));
                self.pending.insert(missing[0], record, Instant::now());
                self.pull(from, &log, "deps");
                if needs_control && self.logs.contains(&control) {
                    self.pull(from, &control, "deps");
                }
                Ingest::Waiting
            }
            Ok(Append::Invalid(err)) => {
                warn!(%from, %err, "rejected record");
                Ingest::Rejected
            }
            Ok(Append::Unauthorized) => {
                debug!(%from, "record refused by the authorizer");
                self.refused.insert(log_of(&record), record.id());
                Ingest::Refused
            }
            Err(err) => {
                warn!(%err, "storing record failed");
                Ingest::Known
            }
        }
    }

    /// Decodes a pulled page (up to 2,000 signature checks) on a blocking
    /// thread, so the network task keeps serving gossip meanwhile.
    fn on_response(&mut self, key: (PeerId, String), response: SyncResponse) {
        self.decoding.insert(key.clone());
        // Presence: the answerer's binding says who it is (sent to members only).
        if let (Some(binding), Some(s)) = (response.binding.clone(), self.sealing.get(&key.1)) {
            let server = s.server;
            let newly = !self.bound.contains_key(&(key.0, server));
            if let Some(identity) = self.verify_binding(key.0, server, binding) {
                self.mark_seen(server, identity, key.0);
                // Newly bound: its channels of this server are pulled now. On
                // open they were skipped (a channel goes only to a bound peer,
                // and the binding comes with this answer), and would otherwise
                // wait for the next anti-entropy round: a join's first messages
                // up to 5 s late.
                if newly {
                    self.pull_bound_channels(key.0, server);
                }
                // Slice 2: a member we know, and its member relay offer (if any).
                self.on_member_answer(key.0, response.relay.clone());
                // A member's direct addresses (F2): try a direct connection.
                let addrs: Vec<Multiaddr> =
                    response.direct_addrs.iter().filter_map(|b| Multiaddr::try_from(b.to_vec()).ok()).collect();
                debug!(peer = %key.0, addrs = addrs.len(), relayed = self.relayed.contains_key(&key.0), "member offered direct addresses");
                // Relay-down resilience: remembered, to redial after a restart.
                self.remember_addrs(key.0, server, identity, &addrs);
                if !addrs.is_empty() && self.relayed.contains_key(&key.0) {
                    self.direct_candidates.insert(key.0, direct_candidates_of(addrs));
                    self.try_direct(key.0);
                }
            }
        }
        // T23: an unbound peer with nothing for a control log isn't asked for
        // it again for a while (each ask carries our binding).
        if response.records.is_empty() && !response.more {
            if let Some(server) = self.sealing.get(&key.1).map(|s| s.server) {
                if key.1.ends_with(CONTROL_SUFFIX) && !self.bound.contains_key(&(key.0, server)) {
                    cap_oldest(&mut self.empty_from, &key, |until| *until);
                    self.empty_from.insert(key.clone(), Instant::now() + UNBOUND_REPROBE);
                }
            }
        }
        let acks = self.ack_check(&key, &response);
        let decoded = self.decoded.clone();
        let store = self.reader.clone();
        tokio::task::spawn_blocking(move || {
            let entries = decode_page(&key.1, &response.records);
            let acked = match (acks, store.lock()) {
                (Some((check, ids)), Ok(store)) if check.allows(&store) => ids,
                _ => Vec::new(),
            };
            let _ = decoded.send((key, entries, response.more, acked));
        });
    }

    /// The acks in a pull answer worth checking (B6): on a sealed log, with
    /// a binding that holds for the answering peer, at most [`MAX_ACKS`]
    /// well-formed ids. Whether that identity is a member is checked on the
    /// decoding thread (the read gate).
    fn ack_check(&mut self, (peer, log): &(PeerId, String), response: &SyncResponse) -> Option<(ReadCheck, Vec<RecordId>)> {
        if response.acks.is_empty() {
            return None;
        }
        let server = self.sealing.get(log)?.server;
        let control = self.secrets.get(&server)?.handle(Scope::Control);
        let identity = response.binding.as_ref()?.verify(peer, &control, unix_now())?;
        let gate = self.access.read_gate.clone()?;
        let ids = response
            .acks
            .iter()
            .take(MAX_ACKS)
            .filter_map(|b| <[u8; 32]>::try_from(b.as_slice()).ok().map(RecordId::from_bytes))
            .collect();
        Some((ReadCheck { gate, identity, server }, ids))
    }

    /// After storing (or finding we already had) a record from a peer:
    /// remember a receipt ack for its author, on servers opened with a secret.
    fn remember_ack(&mut self, record: &Record) {
        if self.secrets.contains_key(&record.server()) {
            self.acks.insert((record.server(), record.author()), record.id(), Instant::now());
        }
    }

    fn on_decoded(&mut self, key: (PeerId, String), entries: Vec<Incoming>, more: bool, acked: Vec<RecordId>) {
        self.decoding.remove(&key);
        for id in acked {
            if self.own.remove(&id) {
                self.emit(NodeEvent::Delivered { id });
            }
        }
        let (peer, log) = key.clone();
        // In page order: runs of full records in one transaction each,
        // stubs one at a time between them.
        let mut added = Vec::new();
        let mut run = Vec::new();
        for entry in entries {
            match entry {
                Incoming::Full(record) => run.push(record),
                Incoming::Stub(stub) => {
                    self.store_run(&log, std::mem::take(&mut run), &mut added);
                    self.store_stub(stub, &mut added);
                }
            }
        }
        self.store_run(&log, run, &mut added);
        let added_any = !added.is_empty();
        for id in added {
            self.release_pending(id);
        }
        if follow_up(more, added_any) || self.again.remove(&key) {
            self.pull(peer, &log, "more");
        }
    }

    /// Stores pulled full records in one transaction.
    fn store_run(&mut self, log: &str, records: Vec<Record>, added: &mut Vec<RecordId>) {
        if records.is_empty() {
            return;
        }
        let outcomes = match self.store.append_all(&records, &*self.authorizer) {
            Ok(outcomes) => outcomes,
            Err(err) => return warn!(%err, "storing pulled records failed"),
        };
        let now = SystemTime::now();
        for (record, outcome) in records.into_iter().zip(outcomes) {
            match outcome {
                Append::Added => {
                    added.push(record.id());
                    self.remember_ack(&record);
                    self.stored(log.to_string(), record, Via::Pull, now);
                }
                Append::Known => self.remember_ack(&record),
                Append::Unauthorized => self.refused.insert(log.to_string(), record.id()),
                Append::MissingDeps(missing) if self.refused.covers(&missing) => {
                    self.refused.insert(log.to_string(), record.id())
                }
                Append::MissingDeps(missing) => {
                    if let Some(id) = self.with_pending_stubs(record, &missing, Via::Pull) {
                        added.push(id);
                    }
                }
                _ => {}
            }
        }
    }

    /// Stores a peer's stub if the stub gate accepts it now (B6-p). A
    /// pending one is kept aside (not refused): it goes in with the delete
    /// or edit that replaced it, see [`Task::with_pending_stubs`].
    fn store_stub(&mut self, stub: Stub, added: &mut Vec<RecordId>) {
        match self.store.append_stub(&stub, &*self.stub_gate) {
            Ok(Append::Added) => {
                self.pending_stubs.remove(&stub.id());
                added.push(stub.id());
            }
            Ok(Append::StubPending) => {
                if self.pending_stubs.len() >= MAX_PENDING_STUBS {
                    self.pending_stubs.clear();
                }
                self.pending_stubs.insert(stub.id(), stub);
            }
            Ok(_) => {}
            Err(err) => warn!(%err, "storing a stub failed"),
        }
    }

    /// A record whose only missing deps are pending stubs (typically the
    /// delete of a message everyone else pruned): stores them together if
    /// the stub gate then accepts every stub. The record's id if stored.
    fn with_pending_stubs(&mut self, record: Record, missing: &[RecordId], via: Via) -> Option<RecordId> {
        let stubs: Vec<Stub> =
            missing.iter().map(|id| self.pending_stubs.get(id).cloned()).collect::<Option<_>>()?;
        match self.store.append_with_stubs(&record, &stubs, &*self.authorizer, &*self.stub_gate) {
            Ok(Append::Added) => {
                for stub in &stubs {
                    self.pending_stubs.remove(&stub.id());
                }
                let id = record.id();
                self.remember_ack(&record);
                self.stored(log_of(&record), record, via, SystemTime::now());
                Some(id)
            }
            Ok(_) => None,
            Err(err) => {
                warn!(%err, "storing a record with its stubs failed");
                None
            }
        }
    }

    /// Retries pushed records that were waiting for `id`.
    fn release_pending(&mut self, id: RecordId) {
        let mut ready = vec![id];
        while let Some(id) = ready.pop() {
            for waiting in self.pending.take(&id) {
                match self.store.append(&waiting.record, &*self.authorizer) {
                    Ok(Append::Added) => {
                        ready.push(waiting.record.id());
                        self.remember_ack(&waiting.record);
                        let log = log_of(&waiting.record);
                        self.stored(log, waiting.record, Via::Push, SystemTime::now());
                    }
                    Ok(Append::MissingDeps(missing)) if self.refused.covers(&missing) => {
                        self.refused.insert(log_of(&waiting.record), waiting.record.id());
                    }
                    Ok(Append::MissingDeps(missing)) => {
                        // Subject to the same caps as a new arrival.
                        self.pending.reinsert(missing[0], waiting);
                    }
                    Ok(Append::Unauthorized) => {
                        self.refused.insert(log_of(&waiting.record), waiting.record.id());
                    }
                    Ok(Append::Known | Append::Invalid(_) | Append::StubPending) => {}
                    Err(err) => warn!(%err, "storing pending record failed"),
                }
            }
        }
    }
}

/// The node's side of the event channel. If the app stops reading, events
/// are dropped rather than piling up, and a [`NodeEvent::Lagged`] with the
/// count goes out as soon as there is room again (before anything newer).
struct EventSink {
    tx: mpsc::Sender<NodeEvent>,
    /// Events dropped since the app last kept up.
    dropped: u64,
}

impl EventSink {
    fn emit(&mut self, event: NodeEvent) {
        if self.dropped > 0 {
            match self.tx.try_send(NodeEvent::Lagged { dropped: self.dropped }) {
                Ok(()) => self.dropped = 0,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    self.dropped += 1;
                    return;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            }
        }
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(event) {
            self.dropped += 1;
            debug!("event buffer full, dropping an event");
        }
    }
}

impl Task {
    /// Counts a direct incoming connection against its remote IP; false if
    /// that IP already has [`MAX_CONNECTIONS_PER_IP`].
    fn admit_by_ip(&mut self, id: ConnectionId, endpoint: &ConnectedPoint) -> bool {
        match incoming_ip(endpoint) {
            Some(ip) => self.per_ip.admit(id, ip),
            None => true,
        }
    }

    /// Records a new connection: a direct connection replaces any relayed
    /// one as the peer's link.
    fn track_connection(&mut self, peer: PeerId, id: ConnectionId, endpoint: &ConnectedPoint) {
        if let ConnectedPoint::Dialer { address, .. } = endpoint {
            for (addr, known) in &mut self.bootstrap {
                if addr == address {
                    *known = Some(peer);
                }
            }
        }
        if is_relayed(endpoint) {
            // One relayed connection per peer is enough: both sides often dial
            // each other's circuit at once, and a second one would use up the
            // per-peer limit and keep a direct connection out. Both sides must
            // keep the *same* one, whatever order they saw them in: the one
            // dialled by the smaller peer ID.
            let preferred = keep_relayed(self.swarm.local_peer_id(), &peer, endpoint.is_dialer());
            if self.direct.contains_key(&peer) {
                self.swarm.close_connection(id);
            } else if let Some(existing) = self.relayed.get(&peer) {
                let existing_preferred = existing.iter().any(|c| self.relayed_preferred.contains(c));
                if preferred && !existing_preferred {
                    for old in self.relayed.remove(&peer).unwrap_or_default() {
                        self.swarm.close_connection(old);
                    }
                    self.relayed.insert(peer, HashSet::from([id]));
                    self.relayed_preferred.insert(id);
                } else {
                    self.swarm.close_connection(id);
                }
            } else {
                self.relayed.insert(peer, HashSet::from([id]));
                if preferred {
                    self.relayed_preferred.insert(id);
                }
                self.emit(NodeEvent::Link { peer, direct: false });
            }
        } else {
            if !self.direct.contains_key(&peer) {
                self.emit(NodeEvent::Link { peer, direct: true });
            }
            self.direct.entry(peer).or_default().insert(id);
            // The old relayed connection is no longer tracked, but stays open
            // until it idles out (IDLE_TIMEOUT) or the relay ends the circuit.
            // v0.2.3: closing the relayed connection the gossip mesh was built
            // on left gossip dead over the new direct one (delivery only on
            // the 5 s pull).
            if let Some(old) = self.relayed.remove(&peer) {
                debug!(%peer, "direct connection replaces the relayed one (left open)");
                self.parked.entry(peer).or_default().extend(old);
            }
        }
    }
}

/// Device link (`device_link`): rendezvous, circuit-only requests, and the
/// one link a new device answers.
const MAX_LINK_FINDS: usize = 4;
const MAX_LINK_WAITING: usize = 8;
const MAX_LINK_PEERS: usize = 64;
const LINK_REQUEST_WAIT: Duration = Duration::from_secs(20);

impl Task {
    /// A relay circuit address of ours (the first relay holding a
    /// reservation for us), for the QR.
    fn our_circuit(&self) -> Option<Multiaddr> {
        let me = *self.swarm.local_peer_id();
        self.relays.iter().find_map(|r| {
            let circuit = r.circuit_addr();
            let reserved = r.circuit.is_some()
                && self.swarm.is_connected(&r.peer)
                && self.swarm.external_addresses().any(|a| *a == circuit);
            reserved.then(|| circuit.with(Protocol::P2p(me)))
        })
    }

    fn link_open(&mut self, rv: [u8; 32], e_new_pub: [u8; 32]) -> Option<(PeerId, Multiaddr)> {
        let circuit = self.our_circuit()?;
        self.link_close();
        if let Err(err) = self.swarm.behaviour_mut().kad.start_providing(kad::RecordKey::new(&rv)) {
            debug!(%err, "device link: announcing the rendezvous failed");
            return None;
        }
        self.link_host = Some(LinkHost::new(rv, e_new_pub, Instant::now()));
        info!("device link open");
        Some((*self.swarm.local_peer_id(), circuit))
    }

    fn link_close(&mut self) {
        if let Some(host) = self.link_host.take() {
            self.swarm.behaviour_mut().kad.stop_providing(&kad::RecordKey::new(&host.rv));
            info!("device link closed");
        }
    }

    /// Whether a direct path to `peer` is off because of a device link: any
    /// peer while a link is open here (new device), or a link peer.
    fn link_blocks(&self, peer: &PeerId) -> bool {
        self.link_host.is_some() || self.link_until.contains_key(peer)
    }

    /// From now on `peer` is reached through the relay only: the guard
    /// refuses any other connection, and direct ones already open close.
    fn mark_link_peer(&mut self, peer: PeerId) {
        if !self.link_until.contains_key(&peer) && self.link_until.len() >= MAX_LINK_PEERS {
            return;
        }
        let until = Instant::now() + crate::DEVICE_LINK_TTL + Duration::from_secs(60);
        self.link_until.insert(peer, until);
        self.link_peers.lock().unwrap().insert(peer);
        self.fallback_at.remove(&peer);
        self.swarm.behaviour_mut().punch.close(peer);
        for id in self.direct.get(&peer).cloned().unwrap_or_default() {
            debug!(%peer, "device link: closing a direct connection");
            self.swarm.close_connection(id);
        }
    }

    fn link_find(&mut self, rv: [u8; 32], reply: oneshot::Sender<Result<PeerId, LinkError>>) {
        if self.link_finds.len() >= MAX_LINK_FINDS {
            let _ = reply.send(Err(LinkError::Network));
            return;
        }
        let query = self.swarm.behaviour_mut().kad.get_providers(kad::RecordKey::new(&rv));
        self.link_finds.insert(query, (reply, Instant::now() + crate::DEVICE_LINK_FIND_WAIT));
    }

    fn on_link_providers(&mut self, query: kad::QueryId, providers: Vec<PeerId>, last: bool) {
        let me = *self.swarm.local_peer_id();
        let found = providers.into_iter().find(|p| *p != me);
        if found.is_none() && !last {
            return;
        }
        if let Some((reply, _)) = self.link_finds.remove(&query) {
            let _ = reply.send(found.ok_or(LinkError::NotFound));
        }
        if let Some(mut q) = self.swarm.behaviour_mut().kad.query_mut(&query) {
            q.finish();
        }
    }

    fn link_request(&mut self, peer: PeerId, request: LinkRequest, reply: LinkReply) {
        if peer == *self.swarm.local_peer_id() || self.is_our_relay(&peer) || self.link_waiting.len() >= MAX_LINK_WAITING {
            let _ = reply.send(Err(LinkError::Network));
            return;
        }
        self.mark_link_peer(peer);
        if !self.link_until.contains_key(&peer) {
            let _ = reply.send(Err(LinkError::Network));
            return;
        }
        self.link_waiting.push((peer, request, reply, Instant::now() + LINK_REQUEST_WAIT));
        if !self.relayed.contains_key(&peer) {
            // Through our relays' circuits only (each one we are connected
            // to), never an address from the DHT.
            let circuits = self.circuits_to(peer);
            let opts = DialOpts::peer_id(peer).addresses(circuits).condition(PeerCondition::Always).build();
            if let Err(err) = self.swarm.dial(opts) {
                debug!(%peer, ?err, "device link: dialling the circuit failed");
            }
        }
        self.flush_link_waiting();
    }

    /// Sends each waiting request whose peer is now reached through a
    /// relayed connection only; fails those past their time.
    fn flush_link_waiting(&mut self) {
        let now = Instant::now();
        for (peer, request, reply, until) in std::mem::take(&mut self.link_waiting) {
            if self.relayed.contains_key(&peer) && !self.direct.contains_key(&peer) {
                let id = self.swarm.behaviour_mut().device_link.send_request(&peer, request);
                self.link_out.insert(id, reply);
            } else if now >= until {
                let _ = reply.send(Err(LinkError::Network));
            } else {
                self.link_waiting.push((peer, request, reply, until));
            }
        }
    }

    fn on_link_request(&mut self, peer: PeerId, request: LinkRequest, channel: ResponseChannel<Vec<u8>>) {
        let (answer, inbound) = match self.link_host.as_mut() {
            Some(host) => host.answer(peer, request, Instant::now()),
            None => (vec![crate::device_link::GONE], None),
        };
        if matches!(inbound, Some(crate::device_link::Inbound::Hello { .. })) {
            self.mark_link_peer(peer);
            debug!(%peer, "device link: hello");
        }
        let _ = self.swarm.behaviour_mut().device_link.send_response(channel, answer);
        if let Some(inbound) = inbound {
            self.emit(NodeEvent::DeviceLink(inbound));
        }
    }

    /// Every second: the link's five minutes, link peers' marks, lookups and
    /// requests past their time.
    fn link_tick(&mut self) {
        let now = Instant::now();
        if self.link_host.as_ref().is_some_and(|h| h.expired(now)) {
            self.link_close();
        }
        let gone: Vec<PeerId> = self.link_until.iter().filter(|(_, until)| now >= **until).map(|(p, _)| *p).collect();
        for peer in gone {
            self.link_until.remove(&peer);
            self.link_peers.lock().unwrap().remove(&peer);
        }
        let late: Vec<kad::QueryId> =
            self.link_finds.iter().filter(|(_, (_, until))| now >= *until).map(|(q, _)| *q).collect();
        for query in late {
            self.on_link_providers(query, Vec::new(), true);
        }
        self.flush_link_waiting();
    }
}

/// Member relays, client side (design #368 §2).
/// Our relay counts as down after this long without a connection to it.
const RELAY_DOWN_AFTER: Duration = Duration::from_secs(60);
/// Member relays we reserve on at once (design §1 rule 3).
const MAX_MEMBER_RELAYS: usize = 2;
/// A member relay that failed (reservation refused or lost) rests this long.
const MEMBER_RELAY_REST: Duration = Duration::from_secs(120);
/// A refused reservation (no reservation held yet) is tried again after this.
const MEMBER_RELAY_RETRY: Duration = Duration::from_secs(15);
/// Each member is dialled through each member relay at most this often, and
/// at most this many such dials go out per round.
const FALLBACK_DIAL_EVERY: Duration = Duration::from_secs(30);
const MAX_FALLBACK_DIALS: usize = 16;
/// Offers and members remembered, and for how long a member counts as known.
const MAX_RELAY_OFFERS: usize = 64;
const MAX_KNOWN_MEMBERS: usize = 1024;
const KNOWN_MEMBER_TTL: Duration = Duration::from_secs(24 * 3600);

impl Task {
    /// A peer that proved a binding (in a request or an answer): one the
    /// fallback dials through member relays when our relay is down.
    fn remember_member(&mut self, peer: PeerId) {
        let now = Instant::now();
        if self.known_members.len() >= MAX_KNOWN_MEMBERS && !self.known_members.contains_key(&peer) {
            self.known_members.retain(|_, at| now.duration_since(*at) < KNOWN_MEMBER_TTL);
        }
        if self.known_members.len() < MAX_KNOWN_MEMBERS || self.known_members.contains_key(&peer) {
            self.known_members.insert(peer, now);
        }
    }

    /// A verified member's answer: remember it, and its relay offer (or that
    /// it no longer makes one). Only addresses we may dial for a member.
    fn on_member_answer(&mut self, peer: PeerId, offer: Option<RelayOffer>) {
        let now = Instant::now();
        self.remember_member(peer);
        let addrs: Vec<Multiaddr> = offer
            .as_ref()
            .map(|o| o.addrs.iter().filter_map(|b| Multiaddr::try_from(b.to_vec()).ok()).collect())
            .unwrap_or_default();
        let addrs: Vec<Multiaddr> =
            direct_candidates_of(addrs).into_iter().filter(|a| dialable(a, self.allow_lan)).collect();
        match offer {
            Some(offer) if !addrs.is_empty() => {
                if self.relay_offers.len() < MAX_RELAY_OFFERS || self.relay_offers.contains_key(&peer) {
                    self.relay_offers.insert(peer, (addrs, offer.preferred, now));
                }
            }
            _ => {
                self.relay_offers.remove(&peer);
            }
        }
    }

    /// Our relay is gone: from now on the fallback clock runs.
    fn relay_lost(&mut self) {
        if self.relay_lost_at.is_none() {
            self.relay_lost_at = Some(Instant::now());
        }
    }

    /// Our relay holds our reservation again: back to it, member relays let go.
    fn relay_back(&mut self) {
        self.relay_lost_at = None;
        self.drop_member_relays();
    }

    fn drop_member_relays(&mut self) {
        if !self.member_listeners.is_empty() {
            info!(count = self.member_listeners.len(), "leaving member relays");
        }
        self.member_reserved.clear();
        for (id, _) in std::mem::take(&mut self.member_listeners) {
            self.swarm.remove_listener(id);
        }
    }

    /// The circuit address through member relay `relay`.
    fn member_circuit(&self, relay: PeerId) -> Option<Multiaddr> {
        let (addrs, _, _) = self.relay_offers.get(&relay)?;
        Some(addrs.first()?.clone().with(Protocol::P2p(relay)).with(Protocol::P2pCircuit))
    }

    /// Every discovery round: once our relay has been down for
    /// [`RELAY_DOWN_AFTER`], hold reservations on up to [`MAX_MEMBER_RELAYS`]
    /// member relays (owner and admin relays first, then by peer ID, so the
    /// members of a server pick the same ones and meet there), and dial the
    /// members we know through them. Never while relay-only: relay-only
    /// promises no member sees our IP (design §2).
    fn member_relay_fallback(&mut self) {
        if self.relay_only {
            self.drop_member_relays();
            return;
        }
        let Some(lost) = self.relay_lost_at else { return };
        if lost.elapsed() < RELAY_DOWN_AFTER {
            return;
        }
        let now = Instant::now();
        let me = *self.swarm.local_peer_id();
        self.member_relay_rest.retain(|_, until| now < *until);
        self.relay_offers.retain(|_, (_, _, at)| now.duration_since(*at) < KNOWN_MEMBER_TTL);
        let active: HashSet<PeerId> = self.member_listeners.values().copied().collect();
        if active.len() < MAX_MEMBER_RELAYS {
            let mut offers: Vec<(bool, PeerId)> = self
                .relay_offers
                .iter()
                .filter(|(p, _)| **p != me && !active.contains(*p) && !self.member_relay_rest.contains_key(*p))
                .map(|(p, (_, preferred, _))| (!*preferred, *p))
                .collect();
            offers.sort();
            for (_, relay) in offers.into_iter().take(MAX_MEMBER_RELAYS - active.len()) {
                let Some(addr) = self.member_circuit(relay) else { continue };
                // Its gate opens only for a member it has verified on a direct
                // connection: connect first, and reserve once the binding went
                // both ways (we see it bound; our pull carried ours).
                if !self.direct.contains_key(&relay) {
                    // Chosen on purpose: a backoff left by circuit dials that
                    // failed when our relay went down doesn't hold it back.
                    self.dial_backoff.lock().unwrap().connected(&relay);
                    let addrs = self.relay_offers.get(&relay).map(|(a, _, _)| a.clone()).unwrap_or_default();
                    let opts = DialOpts::peer_id(relay).addresses(addrs).condition(PeerCondition::DisconnectedAndNotDialing).build();
                    if let Err(err) = self.swarm.dial(opts) {
                        debug!(%relay, %err, "dialling a member relay failed");
                    } else {
                        debug!(%relay, "dialling a member relay");
                    }
                    continue;
                }
                if !self.bound.keys().any(|(p, _)| *p == relay) {
                    debug!(%relay, "member relay not bound yet");
                    continue;
                }
                match self.swarm.listen_on(addr) {
                    Ok(id) => {
                        info!("our relay is down: reserving on a member relay");
                        self.member_listeners.insert(id, relay);
                    }
                    Err(err) => {
                        debug!(%relay, %err, "member relay reservation failed");
                        self.member_relay_rest.insert(relay, now + MEMBER_RELAY_REST);
                    }
                }
            }
        }
        // Meet the members we know through the member relays we hold.
        self.fallback_dialed.retain(|_, at| now.duration_since(*at) < FALLBACK_DIAL_EVERY);
        let relays: Vec<PeerId> = self.member_listeners.values().copied().collect();
        let members: Vec<PeerId> = self
            .known_members
            .iter()
            .filter(|(p, at)| now.duration_since(**at) < KNOWN_MEMBER_TTL && **p != me && !self.connected.contains(*p))
            .map(|(p, _)| *p)
            .collect();
        if !relays.is_empty() {
            debug!(relays = relays.len(), members = members.len(), "meeting members through member relays");
        }
        let mut dials = 0;
        for relay in relays {
            let Some(circuit) = self.member_circuit(relay) else { continue };
            for member in members.iter().filter(|m| **m != relay) {
                if dials >= MAX_FALLBACK_DIALS || self.fallback_dialed.contains_key(&(relay, *member)) {
                    continue;
                }
                self.fallback_dialed.insert((relay, *member), now);
                let opts = DialOpts::peer_id(*member)
                    .addresses(vec![circuit.clone().with(Protocol::P2p(*member))])
                    .condition(PeerCondition::DisconnectedAndNotDialing)
                    .build();
                let id = opts.connection_id();
                if self.swarm.dial(opts).is_ok() {
                    self.fallback_dials.insert(id);
                    dials += 1;
                }
            }
        }
    }

    /// A member relay reservation ended (rest that relay) or was refused
    /// before it began (try again shortly: its gate may not be open yet).
    fn member_listener_closed(&mut self, id: ListenerId) {
        if let Some(relay) = self.member_listeners.remove(&id) {
            let held = self.member_reserved.remove(&id);
            debug!(%relay, held, "member relay reservation ended");
            let rest = if held { MEMBER_RELAY_REST } else { MEMBER_RELAY_RETRY };
            self.member_relay_rest.insert(relay, Instant::now() + rest);
        }
    }
}

/// Relay-down resilience, remembered member addresses (design note and the
/// leads' verdicts, 2026-11-17): direct addresses of verified members, kept
/// in the store and redialled at start and while our relay is down. A dial
/// hint only: Noise checks the peer ID, and the peer binds again before it
/// counts as a member.
/// Remembered members dialled per discovery round, and how often each one.
const MAX_REMEMBERED_DIALS: usize = 16;
const REMEMBERED_DIAL_EVERY: Duration = Duration::from_secs(30);
/// How often remembered rows are checked against membership and expiry.
const REMEMBERED_CHECK_EVERY: Duration = Duration::from_secs(60);

impl Task {
    /// A bound member's direct addresses (from its pull answer): kept, if it
    /// is a current member and we aren't relay-only. Only addresses we would
    /// dial for a member; never logged.
    fn remember_addrs(&mut self, peer: PeerId, server: ServerId, identity: PublicKey, addrs: &[Multiaddr]) {
        if self.relay_only || !self.is_member(peer) {
            return;
        }
        let keep: Vec<String> = direct_candidates_of(addrs.to_vec())
            .into_iter()
            .filter(|a| dialable(a, self.allow_lan))
            .take(crate::store::MAX_REMEMBERED_ADDRS)
            .map(|a| a.to_string())
            .collect();
        if keep.is_empty() {
            return;
        }
        if let Err(err) = self.store.remember_peer(&server, &peer.to_bytes(), identity.as_bytes(), &keep, unix_now()) {
            debug!(%err, "remembering a member failed");
        }
    }

    /// Every discovery round while our relay doesn't hold our reservation
    /// (at start too): dial the remembered members we aren't connected to,
    /// directly. Never while relay-only.
    fn redial_remembered(&mut self) {
        // `direct_dials` off stands in for a firewall in tests: no redial either.
        if self.relay_only || self.relay_lost_at.is_none() || !self.direct_dials {
            return;
        }
        let now = Instant::now();
        self.remembered_dialed.retain(|_, at| now.duration_since(*at) < REMEMBERED_DIAL_EVERY);
        let rows = self.store.remembered_peers(unix_now(), crate::store::REMEMBERED_TTL).unwrap_or_default();
        let mut dials = 0;
        for (_, peer, _, addrs) in rows {
            if dials >= MAX_REMEMBERED_DIALS {
                break;
            }
            let Ok(peer) = PeerId::from_bytes(&peer) else { continue };
            if self.connected.contains(&peer) || self.remembered_dialed.contains_key(&peer) {
                continue;
            }
            let addrs: Vec<Multiaddr> =
                addrs.iter().filter_map(|a| a.parse().ok()).filter(|a| dialable(a, self.allow_lan)).collect();
            if addrs.is_empty() {
                continue;
            }
            self.remembered_dialed.insert(peer, now);
            let opts = DialOpts::peer_id(peer).addresses(addrs).condition(PeerCondition::DisconnectedAndNotDialing).build();
            if self.swarm.dial(opts).is_ok() {
                dials += 1;
            }
        }
        if dials > 0 {
            debug!(dials, "redialling remembered members");
        }
    }

    /// Every [`REMEMBERED_CHECK_EVERY`]: rows of peers that are no longer
    /// members (kicked, left, removed by authority) go at once, and rows
    /// past their 30 days.
    fn check_remembered(&mut self) {
        if self.remembered_checked.elapsed() < REMEMBERED_CHECK_EVERY {
            return;
        }
        self.remembered_checked = Instant::now();
        let _ = self.store.expire_peers(unix_now(), crate::store::REMEMBERED_TTL);
        // No read gate: nobody can be shown to be a member, so nothing
        // remembered stays (fail closed, Security Lead on #419).
        let Some(gate) = self.access.read_gate.clone() else {
            self.forget_remembered();
            return;
        };
        let rows = self.store.remembered_peers(unix_now(), crate::store::REMEMBERED_TTL).unwrap_or_default();
        let gone: Vec<(ServerId, Vec<u8>)> = rows
            .into_iter()
            .filter(|(server, _, identity, _)| {
                !self.secrets.contains_key(server)
                    || !gate.may_read(&PublicKey::from_bytes(*identity), &self.store.control_log(*server))
            })
            .map(|(server, peer, _, _)| (server, peer))
            .collect();
        for (server, peer) in gone {
            let _ = self.store.forget_peer(&server, &peer);
        }
    }

    /// Relay-only: every remembered address goes (Security Lead).
    fn forget_remembered(&mut self) {
        if let Err(err) = self.store.forget_all_peers() {
            warn!(%err, "forgetting remembered members failed");
        }
    }
}

/// The remote IP of a direct incoming connection; None for outgoing and
/// relayed ones (a relayed connection's address is the relay's).
fn incoming_ip(endpoint: &ConnectedPoint) -> Option<std::net::IpAddr> {
    let ConnectedPoint::Listener { send_back_addr, .. } = endpoint else { return None };
    if is_relayed(endpoint) {
        return None;
    }
    send_back_addr.iter().find_map(|p| match p {
        Protocol::Ip4(ip) => Some(ip.into()),
        Protocol::Ip6(ip) => Some(ip.into()),
        _ => None,
    })
}

/// Of two relayed connections between the same two peers, both keep the
/// one dialled by the smaller peer ID, so they never close different ones
/// (which would leave none). `we_dialed`: we dialled this connection.
fn keep_relayed(local: &PeerId, peer: &PeerId, we_dialed: bool) -> bool {
    if we_dialed { local < peer } else { peer < local }
}

/// G-81: where one target's frames go: the substream in use, one being
/// opened on a better connection, and the previous one during the
/// [`VOICE_OVERLAP`] after a move.
#[derive(Default)]
struct VoiceOut {
    current: Option<(ConnectionId, SendQueue)>,
    opening: Option<(u64, ConnectionId)>,
    old: Option<(ConnectionId, SendQueue, Instant)>,
}

impl VoiceOut {
    /// Ends both substreams at once; nothing queued leaves (SL 3).
    fn close(self) {
        for queue in self.current.map(|(_, q)| q).into_iter().chain(self.old.map(|(_, q, _)| q)) {
            queue.close();
        }
    }
}

/// G-81: the substreams one participant's frames come in on: at most two,
/// the newest last, so a move to another connection is make-before-break
/// (TL fix 2). The older one goes after [`VOICE_OVERLAP`], or when it ends.
struct VoiceIn {
    peer: PeerId,
    readers: Vec<(ConnectionId, tokio::task::AbortHandle, Instant)>,
}

impl VoiceIn {
    fn abort(self) {
        for (_, reader, _) in self.readers {
            reader.abort();
        }
    }
}

/// G-81: the order paths are preferred in (#509 §2.4, decision (c)).
fn voice_rank(path: VoicePath) -> u8 {
    match path {
        VoicePath::Lan => 0,
        VoicePath::Direct => 1,
        VoicePath::Circuit => 2,
        VoicePath::MemberCircuit => 3,
        VoicePath::None => 4,
    }
}

impl Task {
    /// What kind of path a new connection is, for voice: a circuit through
    /// one of our relays or a member's, or direct (LAN when the remote
    /// address is LAN scope).
    fn voice_kind(&self, endpoint: &ConnectedPoint) -> VoicePath {
        if is_relayed(endpoint) {
            let addr = match endpoint {
                ConnectedPoint::Dialer { address, .. } => address,
                ConnectedPoint::Listener { local_addr, .. } => local_addr,
            };
            let mut relay = None;
            let mut last = None;
            for p in addr.iter() {
                match p {
                    Protocol::P2pCircuit => {
                        relay = last;
                        break;
                    }
                    Protocol::P2p(peer) => last = Some(peer),
                    _ => {}
                }
            }
            return match relay {
                Some(relay) if self.is_our_relay(&relay) => VoicePath::Circuit,
                _ => VoicePath::MemberCircuit,
            };
        }
        let remote = match endpoint {
            ConnectedPoint::Dialer { address, .. } => address,
            ConnectedPoint::Listener { send_back_addr, .. } => send_back_addr,
        };
        let lan = remote.iter().any(|p| matches!(p, Protocol::Ip4(ip) if crate::lan_beacon::lan_scope(ip)));
        if lan {
            VoicePath::Lan
        } else {
            VoicePath::Direct
        }
    }

    /// Whether voice may use `connection` now: it is open, and relay-only
    /// (SL B5) allows only our circuits.
    fn voice_allowed(&self, connection: ConnectionId) -> bool {
        self.voice_conns.get(&connection).is_some_and(|path| !self.relay_only || *path == VoicePath::Circuit)
    }

    /// The best open connection to `identity` for voice (#509 §2.4, TL):
    /// LAN, then direct, then a circuit through our relays, then a member's
    /// circuit only when none of ours exists. Relay-only: our circuits
    /// only. Never a dial.
    fn voice_route(&self, identity: PublicKey) -> Option<(PeerId, ConnectionId, VoicePath)> {
        let peer = self.member_peer(identity)?;
        [&self.direct, &self.relayed, &self.parked]
            .into_iter()
            .filter_map(|conns| conns.get(&peer))
            .flatten()
            .filter(|c| self.voice_allowed(**c))
            .filter_map(|c| self.voice_conns.get(c).map(|path| (*c, *path)))
            .min_by_key(|(c, path)| (voice_rank(*path), *c))
            .map(|(c, path)| (peer, c, path))
    }

    /// My current call changed. A new call ID (or none) ends every voice
    /// substream at once and starts sequences afresh; a participant who
    /// left loses theirs, and their sequence (TL fix 4).
    fn set_voice_call(&mut self, call: Option<VoiceCall>) {
        let same = self.voice_call.as_ref().map(|c| c.call_id) == call.as_ref().map(|c| c.call_id);
        if !same {
            for (_, out) in self.voice_out.drain() {
                out.close();
            }
            for (_, reader) in self.voice_in.drain() {
                reader.abort();
            }
            self.voice_seq.clear();
            self.voice_paths.clear();
        }
        self.voice_call = call;
        let participants: HashSet<PublicKey> =
            self.voice_call.iter().flat_map(|c| c.participants.iter().copied()).collect();
        let left: Vec<PublicKey> = self.voice_in.keys().filter(|id| !participants.contains(id)).copied().collect();
        for identity in left {
            if let Some(reader) = self.voice_in.remove(&identity) {
                reader.abort();
            }
        }
        self.voice_seq.retain(|identity, _| participants.contains(identity));
        self.voice_reroute();
    }

    /// Every second, on a connection change and on a call change: each
    /// target's frames go on its best path (A5: a better one is opened
    /// first, the old one keeps frames for [`VOICE_OVERLAP`]). A path the
    /// policy no longer allows (relay-only) ends at once, with no overlap
    /// (TL fix 1); a target with no path, or no longer a member, gets none.
    fn voice_reroute(&mut self) {
        self.voice_dirty = false;
        let now = Instant::now();
        let Some(call) = self.voice_call.clone() else { return };
        let targets: Vec<PublicKey> =
            call.targets.iter().filter(|t| call.participants.contains(t)).copied().collect();
        self.voice_out.retain(|identity, out| {
            let keep = targets.contains(identity);
            if !keep {
                std::mem::take(out).close();
            }
            keep
        });
        for identity in targets {
            let route = self.voice_route(identity);
            let path = route.map_or(VoicePath::None, |(_, _, path)| path);
            if self.voice_paths.get(&identity) != Some(&path) {
                self.voice_paths.insert(identity, path);
                self.emit(NodeEvent::VoicePath { identity, path });
            }
            let current_ok = self
                .voice_out
                .get(&identity)
                .and_then(|o| o.current.as_ref())
                .map(|(c, q)| !q.is_closed() && self.voice_allowed(*c));
            let old_ok = self
                .voice_out
                .get(&identity)
                .and_then(|o| o.old.as_ref())
                .map(|(c, q, until)| now < *until && !q.is_closed() && self.voice_allowed(*c));
            let out = self.voice_out.entry(identity).or_default();
            if current_ok == Some(false) {
                if let Some((_, queue)) = out.current.take() {
                    queue.close();
                }
            }
            if old_ok == Some(false) {
                if let Some((_, queue, _)) = out.old.take() {
                    queue.close();
                }
            }
            let Some((peer, connection, _)) = route else {
                std::mem::take(out).close();
                continue;
            };
            let current = out.current.as_ref().map(|(c, _)| *c);
            let opening = out.opening.map(|(_, c)| c);
            if current == Some(connection) || opening == Some(connection) {
                continue;
            }
            if let Some(id) = self.swarm.behaviour_mut().voice_media.open(peer, connection) {
                self.voice_out.entry(identity).or_default().opening = Some((id, connection));
            }
        }
        // Inbound: a sender no longer a member (kicked, or our read gate
        // changed) loses its substreams; one on a connection the policy now
        // forbids loses that one; the older of two goes after the overlap.
        let identities: Vec<PublicKey> = self.voice_in.keys().copied().collect();
        for identity in identities {
            let Some(reader) = self.voice_in.get(&identity) else { continue };
            if self.member_identity(reader.peer) != Some(identity) {
                if let Some(reader) = self.voice_in.remove(&identity) {
                    reader.abort();
                }
                continue;
            }
            let allowed: Vec<bool> = reader.readers.iter().map(|(c, _, _)| self.voice_allowed(*c)).collect();
            let reader = self.voice_in.get_mut(&identity).expect("just seen");
            let newest = reader.readers.last().map(|(_, _, at)| *at);
            let mut i = 0;
            reader.readers.retain(|(_, handle, _)| {
                let ok = allowed[i];
                i += 1;
                let keep = ok && !handle.is_finished();
                if !keep {
                    handle.abort();
                }
                keep
            });
            if reader.readers.len() == 2 && newest.is_some_and(|at| now >= at + VOICE_OVERLAP) {
                let (_, older, _) = reader.readers.remove(0);
                older.abort();
            }
            if reader.readers.is_empty() {
                self.voice_in.remove(&identity);
            }
        }
    }

    fn on_voice_media(&mut self, event: crate::voice_media::Event) {
        use crate::voice_media::Event;
        match event {
            Event::Opened { connection, id, stream } => {
                let allowed = self.voice_allowed(connection);
                let Some(out) = self.voice_out.values_mut().find(|o| o.opening.map(|(i, _)| i) == Some(id)) else {
                    return; // stale: dropping it closes the substream
                };
                out.opening = None;
                if !allowed {
                    return; // relay-only came on meanwhile
                }
                let queue = SendQueue::default();
                tokio::spawn(crate::voice_media::write_loop(stream, queue.clone()));
                if let Some((previous_at, previous)) = out.current.replace((connection, queue)) {
                    if let Some((_, older, _)) = out.old.replace((previous_at, previous, Instant::now() + VOICE_OVERLAP)) {
                        older.close();
                    }
                }
            }
            Event::OpenFailed { id } => {
                if let Some(out) = self.voice_out.values_mut().find(|o| o.opening.map(|(i, _)| i) == Some(id)) {
                    out.opening = None;
                }
            }
            Event::Inbound { peer, connection, stream } => self.on_voice_inbound(peer, connection, stream),
        }
    }

    /// The gate, before a byte is read (#509 §2.3, SL B1, TL): a peer bound
    /// to a current member who is a participant of my current call, on a
    /// connection the policy allows (relay-only: our circuits). At most
    /// one substream per connection, two per participant during a move;
    /// a fresh one (no other live) starts the sequence afresh (a rejoin).
    /// Refused ones are dropped, which closes them.
    fn on_voice_inbound(&mut self, peer: PeerId, connection: ConnectionId, stream: libp2p::Stream) {
        let Some(identity) = self.member_identity(peer) else {
            debug!(%peer, "voice media from a non-member refused");
            return;
        };
        if self.voice_call.as_ref().is_none_or(|c| !c.participants.contains(&identity)) {
            debug!(%peer, "voice media from outside my call refused");
            return;
        }
        if !self.voice_allowed(connection) {
            debug!(%peer, "voice media on a connection relay-only forbids refused");
            return;
        }
        let entry = self.voice_in.entry(identity).or_insert_with(|| VoiceIn { peer, readers: Vec::new() });
        entry.readers.retain(|(_, handle, _)| !handle.is_finished());
        if entry.readers.iter().any(|(c, _, _)| *c == connection) {
            debug!(%peer, "a second voice substream on one connection refused");
            return;
        }
        let fresh = entry.readers.is_empty();
        if entry.readers.len() >= 2 {
            let (_, oldest, _) = entry.readers.remove(0);
            oldest.abort();
        }
        let tx = self.voice_in_tx.clone();
        let reader =
            tokio::spawn(crate::voice_media::read_loop(identity, connection, stream, tx, VOICE_PER_PEER)).abort_handle();
        entry.peer = peer;
        entry.readers.push((connection, reader, Instant::now()));
        if fresh {
            self.voice_seq.remove(&identity);
        }
    }

    /// A frame read from one of `identity`'s substreams: under my call ID,
    /// within the caps and the sequence rules (SL #530: no jump over
    /// [`VOICE_SEQ_JUMP`]; nothing old or repeated, which also drops the
    /// copies a move sends twice).
    fn voice_in_frame(&mut self, identity: PublicKey, connection: ConnectionId, frame: VoiceFrame) {
        if self.voice_in.get(&identity).is_none_or(|r| !r.readers.iter().any(|(c, _, _)| *c == connection)) {
            return;
        }
        if self.voice_call.as_ref().is_none_or(|c| c.call_id != frame.call_id || !c.participants.contains(&identity)) {
            return;
        }
        if let Some(last) = self.voice_seq.get(&identity) {
            let ahead = frame.seq.wrapping_sub(*last);
            // The sender's engine restarted mid-call (SL nit on #554): a
            // low seq far behind the last one starts afresh. A forward jump
            // over the bound is never taken.
            let restart = frame.seq <= VOICE_SEQ_JUMP && last.wrapping_sub(frame.seq) > VOICE_SEQ_JUMP;
            if !restart && (ahead == 0 || ahead > VOICE_SEQ_JUMP) {
                return;
            }
        }
        let now = Instant::now();
        if !self.voice_rate_peer.allow(identity, now) || !self.voice_rate_all.allow((), now) {
            crate::voice_media::DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return;
        }
        self.voice_seq.insert(identity, frame.seq);
        self.emit(NodeEvent::VoiceFrame { from: identity, frame });
    }

    /// One of my frames: to every target's substream, and the old one
    /// during an overlap (checked per send, each copy counted against my
    /// cap: TL nit 5), under my call ID.
    fn voice_out_frame(&mut self, frame: VoiceFrame) {
        if self.voice_call.as_ref().is_none_or(|c| c.call_id != frame.call_id) {
            return;
        }
        let Some(wire) = frame.encode() else { return };
        let now = Instant::now();
        let mut reroute = false;
        for (identity, out) in self.voice_out.iter_mut() {
            if out.old.as_ref().is_some_and(|(_, q, until)| now >= *until || q.is_closed()) {
                if let Some((_, queue, _)) = out.old.take() {
                    queue.close();
                }
            }
            let queues = out.current.iter().map(|(_, q)| q).chain(out.old.iter().map(|(_, q, _)| q));
            for queue in queues {
                if queue.is_closed() {
                    reroute = true;
                    continue;
                }
                if !self.voice_rate_out.allow(*identity, now) {
                    crate::voice_media::DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    continue;
                }
                queue.push(wire.clone());
            }
        }
        // A substream that died (the far side's idle cutoff, a closed
        // circuit): reopen now, not at the next tick (TL nit 7).
        if reroute {
            self.voice_reroute();
        }
    }
}

fn is_relayed(endpoint: &ConnectedPoint) -> bool {
    let has_circuit = |addr: &Multiaddr| addr.iter().any(|p| p == Protocol::P2pCircuit);
    match endpoint {
        ConnectedPoint::Dialer { address, .. } => has_circuit(address),
        // An incoming relayed connection carries the circuit in the local
        // (listening) address, not in the remote one.
        ConnectedPoint::Listener { local_addr, send_back_addr } => has_circuit(local_addr) || has_circuit(send_back_addr),
    }
}

/// `addr` without a trailing `/p2p/<id>`, to compare a dialled address
/// with a configured one whichever of the two carries it.
fn without_peer(addr: &Multiaddr) -> Multiaddr {
    addr.iter().filter(|p| !matches!(p, Protocol::P2p(_))).collect()
}

/// Whether to dial `addr` to reach a peer directly: not a relay circuit, and
/// a global address unless `allow_lan`. DNS names count as global.
///
/// Every address component must be global, not just the last one. A public
/// DNS name that resolves to a private address (DNS rebinding) is not caught
/// here: that needs a check at resolve time (residual risk, GAP-6).
fn dialable(addr: &Multiaddr, allow_lan: bool) -> bool {
    !addr.iter().any(|p| p == Protocol::P2pCircuit) && reachable(addr, allow_lan)
}

/// `listen`, with its TCP port 0 replaced by the port saved in `file`, if any.
fn with_saved_port(listen: &Multiaddr, file: &std::path::Path) -> Multiaddr {
    let saved = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| *p != 0);
    match saved {
        Some(port) => listen.iter().map(|p| if p == Protocol::Tcp(0) { Protocol::Tcp(port) } else { p }).collect(),
        None => listen.clone(),
    }
}

/// `listen` (`/ip4|ip6/<ip>/tcp/<port>`) as QUIC on the same UDP port:
/// `/ip4|ip6/<ip>/udp/<port>/quic-v1`. None for anything else.
fn quic_of(listen: &Multiaddr) -> Option<Multiaddr> {
    let mut parts = listen.iter();
    let ip = parts.next().filter(|p| matches!(p, Protocol::Ip4(_) | Protocol::Ip6(_)))?;
    let Some(Protocol::Tcp(port)) = parts.next() else { return None };
    parts.next().is_none().then(|| Multiaddr::empty().with(ip).with(Protocol::Udp(port)).with(Protocol::QuicV1))
}

/// Listens on QUIC beside the TCP listener `listen`, on `bound`'s TCP port
/// (the port it got, saved for next time, #200) when that is free over UDP,
/// else any. Not fatal: without it, TCP and the relay remain.
fn listen_quic(swarm: &mut Swarm<Behaviour>, listen: &Multiaddr, bound: &Multiaddr) -> Option<ListenerId> {
    let port = bound.iter().find_map(|p| if let Protocol::Tcp(port) = p { Some(port) } else { None })?;
    let on = |port: u16| listen.iter().map(|p| if let Protocol::Tcp(_) = p { Protocol::Tcp(port) } else { p }).collect();
    let addr = quic_of(&on(port))?;
    let any = quic_of(&on(0))?;
    match swarm.listen_on(addr).or_else(|_| swarm.listen_on(any)) {
        Ok(id) => Some(id),
        Err(err) => {
            warn!(%err, "listening on QUIC failed; TCP and the relay only");
            None
        }
    }
}

/// Saves the TCP port of our listen address the first time we get one.
fn save_port(file: &std::path::Path, address: &Multiaddr) {
    if file.exists() {
        return;
    }
    if let Some(Protocol::Tcp(port)) = address.iter().find(|p| matches!(p, Protocol::Tcp(_))) {
        if let Err(err) = std::fs::write(file, port.to_string()) {
            warn!(%err, "saving the listen port failed");
        }
    }
}

/// The addresses a relayed peer reported that we keep for a direct upgrade:
/// direct ones only (no circuits), at most [`MAX_DIRECT_CANDIDATES`], so a
/// peer can't make us dial dozens of addresses.
fn direct_candidates_of(listen_addrs: Vec<Multiaddr>) -> Vec<Multiaddr> {
    let specified = |a: &Multiaddr| {
        !a.iter().any(|p| matches!(p, Protocol::Ip4(ip) if ip.is_unspecified()) || matches!(p, Protocol::Ip6(ip) if ip.is_unspecified()))
    };
    // Machines with VPN, Hyper-V or Docker adapters list many addresses:
    // drop link-local ones (never routable between hosts), and try private
    // LAN addresses first, loopback last, before the cap.
    let link_local = |a: &Multiaddr| {
        a.iter().any(|p| match p {
            Protocol::Ip4(ip) => ip.is_link_local(),
            Protocol::Ip6(ip) => (ip.segments()[0] & 0xffc0) == 0xfe80,
            _ => false,
        })
    };
    let rank = |a: &Multiaddr| match a.iter().next() {
        Some(Protocol::Ip4(ip)) if ip.is_private() => 0,
        Some(Protocol::Ip4(ip)) if ip.is_loopback() => 2,
        Some(Protocol::Ip6(ip)) if ip.is_loopback() => 2,
        _ => 1,
    };
    let mut addrs: Vec<Multiaddr> =
        listen_addrs.into_iter().filter(|a| dialable(a, true) && specified(a) && !link_local(a)).collect();
    addrs.sort_by_key(rank);
    addrs.truncate(MAX_DIRECT_CANDIDATES);
    addrs
}

/// Whether `addr` is a circuit through our configured relay: everything
/// before `/p2p-circuit` must be exactly `relay` (its address and peer ID).
/// Matching the peer ID alone would let a peer put any address in front
/// of it, e.g. a LAN one, and make us dial it.
pub(crate) fn via_relay(addr: &Multiaddr, relay: &Multiaddr) -> bool {
    let parts: Vec<Protocol<'_>> = addr.iter().collect();
    let Some(circuit) = parts.iter().position(|p| *p == Protocol::P2pCircuit) else { return false };
    let prefix: Multiaddr = parts[..circuit].iter().cloned().collect();
    prefix == *relay
}

/// Whether `addr` is exactly our configured relay address, with or
/// without its trailing `/p2p/<relay ID>` (Kademlia may store either).
pub(crate) fn is_configured_relay(addr: &Multiaddr, relay: &Multiaddr) -> bool {
    if addr == relay {
        return true;
    }
    let mut base = relay.clone();
    matches!(base.pop(), Some(Protocol::P2p(_))) && *addr == base
}

/// P0 (#416 broke joins over a relay with a DNS name): a peer-learned
/// circuit through *our configured relay*, matched by the relay's peer ID
/// and rebuilt from our own configured `relay` address, so the
/// peer-supplied base (a DNS name, another port, another transport) is
/// never dialled (Security Lead's rules):
/// - the shape is exactly `<base>/p2p/<relay ID>/p2p-circuit[/p2p/<target>]`:
///   nothing else after `/p2p-circuit`, no nested circuits;
/// - `<relay ID>` is our configured relay's (member relays get no
///   exception);
/// - `<target>`, when present, is `expected` (the peer being dialled).
///
/// The rebuilt `relay/p2p-circuit/p2p/<expected>`, or None.
pub(crate) fn our_relay_circuit(addr: &Multiaddr, relay: &Multiaddr, expected: &PeerId) -> Option<Multiaddr> {
    let relay_id = match relay.iter().last() {
        Some(Protocol::P2p(id)) => id,
        _ => return None,
    };
    let parts: Vec<Protocol<'_>> = addr.iter().collect();
    let circuit = parts.iter().position(|p| *p == Protocol::P2pCircuit)?;
    if circuit == 0 || parts[circuit - 1] != Protocol::P2p(relay_id) {
        return None;
    }
    if parts[..circuit - 1].iter().any(|p| matches!(p, Protocol::P2p(_) | Protocol::P2pCircuit)) {
        return None;
    }
    match &parts[circuit + 1..] {
        [] => {}
        [Protocol::P2p(target)] if target == expected => {}
        _ => return None,
    }
    Some(relay.clone().with(Protocol::P2pCircuit).with(Protocol::P2p(*expected)))
}

/// Like [`dialable`], but a relay circuit is fine (it is how peers behind
/// NAT are reached) as long as the relay's own address is global. Used for
/// addresses learned from peers (Kademlia, identify, member answers) before
/// storing or
/// dialling them. A DNS name is never reachable: see below.
pub(crate) fn reachable(addr: &Multiaddr, allow_lan: bool) -> bool {
    let mut global = true;
    for p in addr.iter() {
        match p {
            Protocol::P2pCircuit => break,
            Protocol::Ip4(ip) => global &= global_v4(ip),
            Protocol::Ip6(ip) => global &= global_v6(ip),
            // Never a DNS name learned from a peer: resolving it would query a
            // server the peer may control, and a crafted answer reaches the
            // resolver's decoding bugs (CPU, memory, panics; hickory-advisories,
            // Tech Lead). Only configured addresses (our relays) are names.
            Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_) | Protocol::Dnsaddr(_) => return false,
            _ => {}
        }
    }
    global || allow_lan
}

/// Whether any part of `addr` is a DNS name.
fn has_dns(addr: &Multiaddr) -> bool {
    addr.iter().any(|p| matches!(p, Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_) | Protocol::Dnsaddr(_)))
}

fn global_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(a == 0 // "this network" 0.0.0.0/8
        || ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a >= 240 // reserved 240/4
        || (a == 100 && (b & 0xc0) == 64)) // CGNAT 100.64/10
}

fn global_v6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return global_v4(v4);
    }
    let seg = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (seg & 0xfe00) == 0xfc00 // unique local
        || (seg & 0xffc0) == 0xfe80) // link local
}

/// Why a pushed message isn't ingested: Ignore (not ours to judge) or Reject
/// (invalid; not forwarded and, once scoring is on, held against the sender).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refuse {
    Ignore,
    Reject,
}

/// The record in a pushed message, if it may be ingested: the topic is a
/// log we have open (else Ignore); on a handle topic the message opens with
/// that log's key (else Reject); the bytes decode and verify, and the record
/// signed the topic's log (else Reject). Opening never replaces those checks.
fn check_pushed(open: &HashSet<String>, sealing: &Sealing, message: &gossipsub::Message) -> Result<Record, Refuse> {
    let (topic_log, data) = if let Some(log) = sealing.log_of_wire(message.topic.as_str()) {
        let s = sealing.get(log).ok_or(Refuse::Ignore)?;
        let data = access::open(&s.key, &s.handle, &message.data).ok_or(Refuse::Reject)?;
        (log, std::borrow::Cow::Owned(data))
    } else if Handle::parse(message.topic.as_str()).is_some() {
        // A handle we don't hold.
        return Err(Refuse::Ignore);
    } else {
        let log = log_of_topic(&message.topic).ok_or(Refuse::Reject)?;
        // A sealed log is never taken by its plain name.
        if sealing.get(log).is_some() {
            return Err(Refuse::Ignore);
        }
        (log, std::borrow::Cow::Borrowed(&message.data[..]))
    };
    if !open.contains(topic_log) {
        return Err(Refuse::Ignore);
    }
    let record = Record::decode(&data).map_err(|_| Refuse::Reject)?;
    // Filed under the log it signed, never the topic it came on.
    if log_of(&record) != topic_log {
        return Err(Refuse::Reject);
    }
    Ok(record)
}

/// Decodes (and so verifies) a pulled page for `log`. A page is for one log:
/// entries that don't decode as what their tag says, or that signed another
/// log, are dropped.
fn decode_page(log: &str, page: &[WireEntry]) -> Vec<Incoming> {
    let records: Vec<Incoming> = page
        .iter()
        .filter_map(|entry| match entry {
            WireEntry::Full(bytes) => Record::decode(bytes).ok().filter(|r| log_of(r) == log).map(Incoming::Full),
            WireEntry::Stub(bytes) => {
                Stub::decode(bytes).ok().filter(|s| log_name(s.server(), s.scope()) == log).map(Incoming::Stub)
            }
        })
        .collect();
    if records.len() != page.len() {
        debug!(dropped = page.len() - records.len(), "dropped invalid or misfiled pulled records");
    }
    records
}

fn empty_response() -> SyncResponse {
    SyncResponse { records: Vec::new(), more: false, acks: Vec::new(), binding: None, direct_addrs: Vec::new(), relay: None }
}

/// What a pull answer carries beyond the page: our binding and the
/// requester's acks for a member ([`for_members_only`]), and our direct
/// (LAN) addresses only where the binding went, and only when
/// `share_direct` (LAN allowed, not relay-only). Identify never carries them.
fn member_extras(
    response: &mut SyncResponse,
    ours: Option<(ReadCheck, Binding)>,
    acks: &[RecordId],
    direct: &[Multiaddr],
    share_direct: bool,
    offer: Option<&RelayOffer>,
    store: &Store,
) {
    for_members_only(response, ours, acks, store);
    if response.binding.is_some() && share_direct {
        response.direct_addrs = direct.iter().map(|a| ByteBuf::from(a.to_vec())).collect();
    }
    if response.binding.is_some() {
        response.relay = offer.cloned();
    }
}

/// Adds our binding (presence) and the requester's receipt acks to an
/// answer, only if our read gate accepts the requester as a member: a
/// leaked-link holder learns neither who we are nor what we stored.
fn for_members_only(response: &mut SyncResponse, ours: Option<(ReadCheck, Binding)>, acks: &[RecordId], store: &Store) {
    if let Some((member, binding)) = ours {
        if member.allows(store) {
            response.acks = acks.iter().map(|id| ByteBuf::from(id.as_bytes().to_vec())).collect();
            response.binding = Some(binding);
        }
    }
}

/// Answers a pull: what the requester is missing from `request.log`, one
/// page, straight from the stored bytes (they passed the ingest checks when
/// they were stored). At most [`MAX_HAVE`] `have` ids are looked at, and
/// malformed ones are skipped. The caller checks the log is open and the
/// requester may read it.
#[cfg(test)]
fn answer(store: &Store, log: &str, have: &[ByteBuf], max_bytes: usize) -> SyncResponse {
    answer_with_ids(store, log, have, max_bytes).0
}

/// [`answer`], plus the ids of the records in the page.
fn answer_with_ids(store: &Store, log: &str, have: &[ByteBuf], max_bytes: usize) -> (SyncResponse, Vec<RecordId>) {
    let have: Vec<RecordId> = have
        .iter()
        .take(MAX_HAVE)
        .filter_map(|b| <[u8; 32]>::try_from(b.as_slice()).ok().map(RecordId::from_bytes))
        .collect();
    match store.missing_since(log, &have, PAGE, max_bytes) {
        Ok((page, more)) => {
            let ids = page.iter().map(|s| s.id).collect();
            let records = page
                .into_iter()
                .map(|s| if s.stub { WireEntry::Stub(ByteBuf::from(s.bytes)) } else { WireEntry::Full(ByteBuf::from(s.bytes)) })
                .collect();
            (SyncResponse { records, more, ..empty_response() }, ids)
        }
        Err(err) => {
            warn!(%err, "missing_since failed");
            (empty_response(), Vec::new())
        }
    }
}

/// Whether to ask for the next page right away. A peer that keeps saying
/// "more" without sending anything new is not followed; the anti-entropy
/// timer tries again later.
/// Before an insert into a T23 map: at [`MAX_T23_ENTRIES`], drop the entry
/// whose time (`at`) is earliest, so the map never grows past the cap.
fn cap_oldest<K: Clone + Eq + std::hash::Hash, V>(map: &mut HashMap<K, V>, key: &K, at: impl Fn(&V) -> Instant) {
    // An overwrite doesn't grow the map (tech lead): nothing to drop.
    if map.len() < MAX_T23_ENTRIES || map.contains_key(key) {
        return;
    }
    if let Some(oldest) = map.iter().min_by_key(|(_, v)| at(v)).map(|(k, _)| k.clone()) {
        map.remove(&oldest);
    }
}

fn follow_up(more: bool, added_any: bool) -> bool {
    more && added_any
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{channel, message_chain, server};
    use crate::AcceptAll;

    /// G-81 path order (#509 §2.4, decision (c)): LAN, direct, our circuit,
    /// a member's circuit last.
    #[test]
    fn voice_paths_rank_lan_direct_ours_then_a_members() {
        let order = [VoicePath::Lan, VoicePath::Direct, VoicePath::Circuit, VoicePath::MemberCircuit, VoicePath::None];
        assert!(order.windows(2).all(|w| voice_rank(w[0]) < voice_rank(w[1])));
    }

    fn chan() -> String {
        log_name(server(), Scope::Channel(channel()))
    }

    fn store_with(n: usize, size: usize) -> (Store, Vec<Record>) {
        let mut store = Store::in_memory().unwrap();
        let chain = message_chain(n, size);
        store.append_all(&chain, &AcceptAll).unwrap();
        (store, chain)
    }

    #[test]
    fn malformed_and_excess_have_ids_are_ignored() {
        let (store, chain) = store_with(5, 0);
        let have = vec![ByteBuf::from(vec![1, 2, 3]), ByteBuf::from(chain[4].id().as_bytes().to_vec())];
        assert!(answer(&store, &chan(), &have, PAGE_BYTES).records.is_empty());
        // 100,000 have ids cost the same as MAX_HAVE.
        let flood = vec![ByteBuf::from(vec![0xee; 32]); 100_000];
        assert_eq!(answer(&store, &chan(), &flood, PAGE_BYTES).records.len(), 5);
        // An unknown log name is just empty (SQL parameter, never SQL text).
        assert!(answer(&store, "x'; DROP TABLE records; --", &[], PAGE_BYTES).records.is_empty());
        assert_eq!(store.count(&chan()).unwrap(), 5);
    }

    #[test]
    fn response_pages_fit_the_codec_limit() {
        // 400 records of ~16 KiB is ~6.5 MB; a page stops at PAGE_BYTES.
        let (store, _) = store_with(400, 16 * 1024 - 8);
        let response = answer(&store, &chan(), &[], PAGE_BYTES);
        assert!(response.more);
        let size: usize = response.records.iter().map(|b| b.len()).sum();
        assert!(size <= PAGE_BYTES + records::MAX_RECORD_BYTES, "page is {size} bytes");
        // Every record in it decodes and belongs to the log.
        for entry in &response.records {
            let WireEntry::Full(bytes) = entry else { panic!("a stub in a log with none") };
            assert_eq!(log_of(&Record::decode(bytes).unwrap()), chan());
        }
    }

    fn pushed(topic_log: &str, data: Vec<u8>) -> gossipsub::Message {
        gossipsub::Message {
            source: None,
            data,
            sequence_number: None,
            topic: TopicHash::from_raw(format!("log/{topic_log}")),
        }
    }

    #[test]
    fn pushed_records_are_decoded_and_filed_by_what_they_signed() {
        let control = log_name(server(), Scope::Control);
        let open: HashSet<String> = [chan(), control.clone()].into();
        let m = crate::testutil::message(0, &[], 0);
        assert_eq!(check_pushed(&open, &Sealing::default(), &pushed(&chan(), m.encode())), Ok(m.clone()));

        // A real record on another open log's topic: refused, not refiled.
        assert_eq!(check_pushed(&open, &Sealing::default(), &pushed(&control, m.encode())), Err(Refuse::Reject));
        // Garbage, truncated, or a bad signature.
        assert_eq!(check_pushed(&open, &Sealing::default(), &pushed(&chan(), vec![1, 2, 3])), Err(Refuse::Reject));
        let mut bytes = m.encode();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert_eq!(check_pushed(&open, &Sealing::default(), &pushed(&chan(), bytes.clone())), Err(Refuse::Reject));
        assert_eq!(check_pushed(&open, &Sealing::default(), &pushed(&chan(), bytes[..last].to_vec())), Err(Refuse::Reject));
        // A log we don't have open: not ours to judge.
        assert_eq!(check_pushed(&HashSet::new(), &Sealing::default(), &pushed(&chan(), m.encode())), Err(Refuse::Ignore));
        // Not a log topic at all.
        let mut odd = pushed(&chan(), m.encode());
        odd.topic = TopicHash::from_raw("other");
        assert_eq!(check_pushed(&open, &Sealing::default(), &odd), Err(Refuse::Reject));
    }

    #[tokio::test]
    async fn dropped_events_are_reported_as_lagged() {
        let (tx, mut rx) = mpsc::channel(2);
        let mut sink = EventSink { tx, dropped: 0 };
        let peer = PeerId::random();
        for _ in 0..5 {
            sink.emit(NodeEvent::PeerConnected(peer));
        }
        // Two fit, three were dropped.
        assert!(matches!(rx.recv().await, Some(NodeEvent::PeerConnected(_))));
        assert!(matches!(rx.recv().await, Some(NodeEvent::PeerConnected(_))));
        // The next event is preceded by the count of what was lost.
        sink.emit(NodeEvent::PeerDisconnected(peer));
        assert!(matches!(rx.recv().await, Some(NodeEvent::Lagged { dropped: 3 })));
        assert!(matches!(rx.recv().await, Some(NodeEvent::PeerDisconnected(_))));
        sink.emit(NodeEvent::PeerConnected(peer));
        assert!(matches!(rx.recv().await, Some(NodeEvent::PeerConnected(_))));
    }

    #[test]
    fn pulled_pages_keep_only_valid_records_of_the_log() {
        let good = crate::testutil::message(0, &[], 0);
        let other_log = crate::testutil::genesis();
        let mut forged = good.encode();
        forged[40] ^= 1;
        let page = [good.encode(), other_log.encode(), forged, vec![], vec![0; 100_000]]
            .map(|b| WireEntry::Full(ByteBuf::from(b)));
        assert_eq!(decode_page(&chan(), &page), vec![Incoming::Full(good)]);
    }

    /// Rule 1 (B6-p): stubs travel tagged, and an entry is only ever decoded
    /// as what its tag says: a stub tagged as a record, or a record tagged as
    /// a stub, is dropped.
    #[test]
    fn stubs_and_records_are_never_taken_for_each_other() {
        let m = crate::testutil::message(0, &[], 10);
        let stub = m.prune().unwrap();
        let entry = |full: bool, bytes: Vec<u8>| {
            if full { WireEntry::Full(ByteBuf::from(bytes)) } else { WireEntry::Stub(ByteBuf::from(bytes)) }
        };
        let page = [entry(false, stub.encode()), entry(true, stub.encode()), entry(false, m.encode()), entry(true, m.encode())];
        assert_eq!(decode_page(&chan(), &page), vec![Incoming::Stub(stub.clone()), Incoming::Full(m)]);
        // A stub of another log is dropped too.
        assert!(decode_page(&log_name(server(), Scope::Control), &[entry(false, stub.encode())]).is_empty());
        // The tag survives the wire.
        let response = SyncResponse { records: vec![entry(false, stub.encode())], ..empty_response() };
        let bytes = serde_json::to_vec(&response).unwrap();
        let back: SyncResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.records, vec![WireEntry::Stub(ByteBuf::from(stub.encode()))]);
    }

    /// Two relayed connections between A and B, X dialled by A and Y by B:
    /// both sides keep the same one, whichever order each saw them in.
    #[test]
    fn both_sides_keep_the_same_relayed_connection() {
        for _ in 0..20 {
            let (a, b) = (PeerId::random(), PeerId::random());
            // X: A dialled it; on A we_dialed, on B not. Y: the reverse.
            let a_keeps_x = keep_relayed(&a, &b, true);
            let a_keeps_y = keep_relayed(&a, &b, false);
            let b_keeps_x = keep_relayed(&b, &a, false);
            let b_keeps_y = keep_relayed(&b, &a, true);
            // Exactly one is kept, and the same one on both sides (so the
            // order they arrived in doesn't matter).
            assert!(a_keeps_x != a_keeps_y);
            assert_eq!((a_keeps_x, a_keeps_y), (b_keeps_x, b_keeps_y));
            // It's the one dialled by the smaller peer ID.
            assert_eq!(a_keeps_x, a < b);
        }
    }

    /// A Windows PC with Hyper-V, Docker and VPN adapters: link-local ones
    /// are dropped, and the real LAN address survives the cap, ahead of the
    /// rest, with loopback last.
    #[test]
    fn lan_addresses_come_first_and_link_local_ones_never() {
        let mut addrs: Vec<Multiaddr> = Vec::new();
        for i in 0..10 {
            addrs.push(format!("/ip4/169.254.{i}.1/tcp/4001").parse().unwrap());
            addrs.push(format!("/ip4/100.64.0.{i}/tcp/4001").parse().unwrap()); // CGNAT / VPN
        }
        addrs.push("/ip6/fe80::1/tcp/4001".parse().unwrap());
        addrs.push("/ip4/127.0.0.1/tcp/4001".parse().unwrap());
        addrs.push("/ip4/192.168.1.20/tcp/4001".parse().unwrap()); // the real LAN, listed last
        let kept = direct_candidates_of(addrs);
        assert_eq!(kept.len(), MAX_DIRECT_CANDIDATES);
        assert_eq!(kept[0].to_string(), "/ip4/192.168.1.20/tcp/4001");
        assert!(!kept.iter().any(|a| a.to_string().contains("169.254") || a.to_string().contains("fe80")));
    }

    /// F2: a peer reporting dozens of addresses gets at most 8 tried, and
    /// never a relay circuit among them.
    #[test]
    fn direct_candidates_are_capped() {
        let mut addrs: Vec<Multiaddr> =
            (0..30).map(|i| format!("/ip4/192.168.1.{i}/tcp/4001").parse().unwrap()).collect();
        addrs.insert(0, format!("/ip4/1.2.3.4/tcp/1/p2p/{}/p2p-circuit", PeerId::random()).parse().unwrap());
        addrs.insert(0, "/ip4/0.0.0.0/tcp/4001".parse().unwrap());
        let kept = direct_candidates_of(addrs);
        assert_eq!(kept.len(), MAX_DIRECT_CANDIDATES);
        assert!(kept.iter().all(|a| !a.iter().any(|p| p == Protocol::P2pCircuit)));
        assert!(!kept.iter().any(|a| a.to_string().starts_with("/ip4/0.0.0.0")));
    }

    /// The listen port stays the same across restarts (so a firewall or
    /// router rule can allow it once); if it's taken, a random one this time,
    /// and the saved one is kept.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_listen_port_is_kept_across_restarts() {
        let dir = std::env::temp_dir().join(format!("sync-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = || NodeConfig {
            relay: format!("/ip4/127.0.0.1/tcp/9/p2p/{}", PeerId::random()).parse().unwrap(),
            more_relays: vec![],
            data_dir: dir.clone(),
            logs: Vec::new(),
            authorizer: Arc::new(AcceptAll),
            listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
            bootstrap: Vec::new(),
            allow_lan: true,
            relay_only: false,
        };
        let (first, _) = Node::start(config()).await.unwrap();
        let port = port_of(&first).await;
        first.shutdown().await.unwrap();
        let (again, _) = Node::start(config()).await.unwrap();
        assert_eq!(port_of(&again).await, port, "a new port after a restart");
        again.shutdown().await.unwrap();
        // Something else holds the port now: a random one, the saved one kept.
        // (Windows may take a moment to release it after the shutdown.)
        let deadline = Instant::now() + Duration::from_secs(10);
        let taken = loop {
            match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(l) => break l,
                Err(err) => {
                    assert!(Instant::now() < deadline, "port {port} never released: {err}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        };
        let (moved, _) = Node::start(config()).await.unwrap();
        assert_ne!(port_of(&moved).await, port);
        assert_eq!(std::fs::read_to_string(dir.join("listen.port")).unwrap(), port.to_string());
        moved.shutdown().await.unwrap();
        drop(taken);
    }

    /// What we send members as our direct addresses comes from
    /// `swarm.listeners()`: listening on 0.0.0.0 gives one address per
    /// interface there, never 0.0.0.0 itself.
    #[tokio::test]
    async fn listening_on_all_interfaces_lists_each_interface() {
        let dir = std::env::temp_dir().join(format!("sync-listen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = NodeConfig {
            relay: format!("/ip4/127.0.0.1/tcp/9/p2p/{}", PeerId::random()).parse().unwrap(),
            more_relays: vec![],
            data_dir: dir,
            logs: Vec::new(),
            authorizer: Arc::new(AcceptAll),
            listen: "/ip4/0.0.0.0/tcp/0".parse().unwrap(),
            bootstrap: Vec::new(),
            allow_lan: true,
            relay_only: false,
        };
        let (node, _events) = Node::start(config).await.unwrap();
        port_of(&node).await;
        let addrs = node.listen_addrs().await.unwrap();
        assert!(addrs.iter().any(|a| a.to_string().starts_with("/ip4/127.0.0.1/")), "{addrs:?}");
        assert!(!addrs.iter().any(|a| a.to_string().starts_with("/ip4/0.0.0.0/")), "{addrs:?}");
        node.shutdown().await.unwrap();
    }

    /// Only a circuit through exactly our configured relay address passes;
    /// our relay's peer ID behind any other address (a LAN one) does not.
    #[test]
    fn only_circuits_through_our_exact_relay_address_are_trusted() {
        let relay_id = PeerId::random();
        let relay: Multiaddr = format!("/ip4/127.0.0.1/tcp/4001/p2p/{relay_id}").parse().unwrap();
        let target = PeerId::random();
        let ok: Multiaddr = format!("{relay}/p2p-circuit/p2p/{target}").parse().unwrap();
        assert!(via_relay(&ok, &relay));
        for bad in [
            format!("/ip4/192.168.1.1/tcp/22/p2p/{relay_id}/p2p-circuit/p2p/{target}"),
            format!("/ip4/127.0.0.1/tcp/22/p2p/{relay_id}/p2p-circuit/p2p/{target}"),
            format!("/ip4/127.0.0.1/tcp/4001/p2p/{}/p2p-circuit/p2p/{target}", PeerId::random()),
            format!("/ip4/127.0.0.1/tcp/4001/p2p/{relay_id}"),
        ] {
            let bad: Multiaddr = bad.parse().unwrap();
            assert!(!via_relay(&bad, &relay), "{bad} trusted");
            // Nor does the general rule let the LAN ones through without allow_lan.
            assert!(!reachable(&bad, false) || bad.iter().all(|p| !matches!(p, Protocol::Ip4(ip) if ip.is_private())));
        }
    }

    #[test]
    fn a_circuit_through_our_dns_relay_is_rebuilt_from_our_own_address() {
        // P0 on #416: the relay announces itself under a DNS name (or another
        // port or transport) than ours; matched by its peer ID, the circuit
        // is rebuilt from our configured address (Security Lead's rules).
        let relay_id = PeerId::random();
        let target = PeerId::random();
        let ours: Multiaddr = format!("/dns4/relay.example/tcp/4001/p2p/{relay_id}").parse().unwrap();
        let want: Multiaddr = format!("{ours}/p2p-circuit/p2p/{target}").parse().unwrap();
        let a = |s: String| s.parse::<Multiaddr>().unwrap();
        // Our relay's ID with the configured base passes, and so do another
        // name, port or transport for it: all rewritten to ours.
        for base in [
            "/dns4/relay.example/tcp/4001",
            "/dns4/relay.example/tcp/443/wss",
            "/dns4/other.example/udp/4001/quic-v1",
            "/ip4/192.168.1.5/tcp/4001",
        ] {
            for tail in [format!("/p2p-circuit/p2p/{target}"), "/p2p-circuit".to_owned()] {
                let got = our_relay_circuit(&a(format!("{base}/p2p/{relay_id}{tail}")), &ours, &target);
                assert_eq!(got.as_ref(), Some(&want), "{base}{tail}");
            }
        }
        // The same host with another peer ID: refused (a member relay too).
        let member_relay = PeerId::random();
        assert!(our_relay_circuit(&a(format!("/dns4/relay.example/tcp/4001/p2p/{member_relay}/p2p-circuit/p2p/{target}")), &ours, &target).is_none());
        // Another target than the peer being dialled.
        let other = PeerId::random();
        assert!(our_relay_circuit(&a(format!("/dns4/relay.example/tcp/4001/p2p/{relay_id}/p2p-circuit/p2p/{other}")), &ours, &target).is_none());
        // Extra protocols after /p2p-circuit, nested circuits, a peer ID in the base.
        for bad in [
            format!("/dns4/relay.example/tcp/4001/p2p/{relay_id}/p2p-circuit/p2p/{target}/tcp/1"),
            format!("/dns4/relay.example/tcp/4001/p2p/{relay_id}/p2p-circuit/ip4/1.2.3.4/tcp/1/p2p/{target}"),
            format!("/dns4/relay.example/tcp/4001/p2p/{relay_id}/p2p-circuit/p2p/{other}/p2p-circuit/p2p/{target}"),
            format!("/ip4/1.2.3.4/tcp/1/p2p/{other}/p2p-circuit/dns4/relay.example/tcp/4001/p2p/{relay_id}/p2p-circuit/p2p/{target}"),
            format!("/p2p/{relay_id}/p2p-circuit/p2p/{target}/p2p/{target}"),
            format!("/dns4/relay.example/tcp/4001/p2p/{relay_id}"),
        ] {
            assert!(our_relay_circuit(&a(bad.clone()), &ours, &target).is_none(), "{bad}");
        }
        // A plain DNS address stays unreachable (#416 unchanged).
        assert!(!reachable(&a("/dns4/relay.example/tcp/4001".into()), false));
        // Kademlia keeps our configured relay's own address (with or without
        // its /p2p), and nothing else under that name.
        assert!(is_configured_relay(&ours, &ours));
        assert!(is_configured_relay(&a("/dns4/relay.example/tcp/4001".into()), &ours));
        assert!(!is_configured_relay(&a("/dns4/relay.example/tcp/443/wss".into()), &ours));
        assert!(!is_configured_relay(&a("/dns4/evil.example/tcp/4001".into()), &ours));
    }

    #[test]
    fn only_global_addresses_are_dialled_unless_lan_is_allowed() {
        let a = |s: &str| s.parse::<Multiaddr>().unwrap();
        for global in ["/ip4/8.8.8.8/tcp/4001", "/ip6/2001:4860::1/tcp/1"] {
            assert!(dialable(&a(global), false), "{global}");
        }
        for local in [
            "/ip4/10.1.2.3/tcp/4001",
            "/ip4/192.168.1.5/tcp/1",
            "/ip4/172.18.0.2/tcp/1",
            "/ip4/127.0.0.1/tcp/1",
            "/ip4/169.254.1.1/tcp/1",
            "/ip4/100.64.0.1/tcp/1",
            "/ip4/0.0.0.0/tcp/1",
            "/ip6/::1/tcp/1",
            "/ip6/fd00::1/tcp/1",
            "/ip6/fe80::1/tcp/1",
            "/ip4/0.1.2.3/tcp/1",
            "/ip4/240.0.0.1/tcp/1",
            "/ip4/224.0.0.251/udp/5353",
            "/ip6/::ffff:192.168.1.5/tcp/1",
            "/ip6/ff02::1/tcp/1",
        ] {
            assert!(!dialable(&a(local), false), "{local}");
            assert!(dialable(&a(local), true), "{local} with LAN allowed");
        }
        // A DNS name learned from a peer is never dialled or stored, LAN or
        // not (hickory-advisories): only configured addresses are names.
        for name in [
            "/dns4/relay.example/tcp/443",
            "/dns/peer.example.org/tcp/4001",
            "/dns6/x.example/udp/1/quic-v1",
            "/dnsaddr/bootstrap.example",
            "/dns4/localhost/tcp/1",
            "/dns4/evil.example/tcp/1/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc/p2p-circuit",
        ] {
            assert!(!dialable(&a(name), true) && !reachable(&a(name), true), "{name}");
        }
        // Every component counts, not only the last.
        assert!(!dialable(&a("/ip4/10.0.0.1/tcp/1/ip4/8.8.8.8/tcp/2"), false));

        // Never a relay circuit for a direct dial: that is what we are trying to get off.
        let relay = "/ip4/8.8.8.8/tcp/4001/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc/p2p-circuit";
        assert!(!dialable(&a(relay), true));
        // But a circuit through a global relay is a fine address to learn and
        // dial when that's all we have; one through a LAN relay is not.
        assert!(reachable(&a(relay), false));
        assert!(!reachable(&a(&relay.replace("8.8.8.8", "192.168.1.5")), false));
    }

    #[test]
    fn quic_listens_beside_tcp_on_the_same_port() {
        let a = |s: &str| s.parse::<Multiaddr>().unwrap();
        assert_eq!(quic_of(&a("/ip4/0.0.0.0/tcp/4001")), Some(a("/ip4/0.0.0.0/udp/4001/quic-v1")));
        assert_eq!(quic_of(&a("/ip6/::/tcp/0")), Some(a("/ip6/::/udp/0/quic-v1")));
        assert_eq!(quic_of(&a("/dns4/example.com/tcp/4001")), None);
        assert_eq!(quic_of(&a("/ip4/0.0.0.0/tcp/443/wss")), None);
        assert_eq!(quic_of(&a("/ip4/0.0.0.0/udp/4001/quic-v1")), None);
    }

    #[test]
    fn only_direct_incoming_connections_count_per_ip() {
        let a = |s: &str| s.parse::<Multiaddr>().unwrap();
        let incoming = |local: &str, remote: &str| ConnectedPoint::Listener { local_addr: a(local), send_back_addr: a(remote) };
        let direct = incoming("/ip4/0.0.0.0/tcp/4001", "/ip4/203.0.113.7/tcp/51000");
        assert_eq!(incoming_ip(&direct), Some("203.0.113.7".parse().unwrap()));
        // QUIC counts against the same per-IP budget as TCP.
        let quic = incoming("/ip4/0.0.0.0/udp/4001/quic-v1", "/ip4/203.0.113.7/udp/51000/quic-v1");
        assert_eq!(incoming_ip(&quic), Some("203.0.113.7".parse().unwrap()));
        let quic6 = incoming("/ip6/::/udp/4001/quic-v1", "/ip6/2001:db8::7/udp/51000/quic-v1");
        assert_eq!(incoming_ip(&quic6), Some("2001:db8::7".parse().unwrap()));
        let relayed = incoming(
            "/ip4/198.51.100.1/tcp/4001/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc/p2p-circuit",
            "/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc",
        );
        assert_eq!(incoming_ip(&relayed), None);
        let outgoing = ConnectedPoint::Dialer {
            address: a("/ip4/203.0.113.7/tcp/4001"),
            role_override: libp2p::core::Endpoint::Dialer,
            port_use: libp2p::core::transport::PortUse::Reuse,
        };
        assert_eq!(incoming_ip(&outgoing), None);
    }

    #[test]
    fn a_small_byte_budget_gives_a_small_page() {
        let (store, _) = store_with(50, 10_000);
        let full = answer(&store, &chan(), &[], PAGE_BYTES);
        let cut = answer(&store, &chan(), &[], 64 * 1024);
        assert_eq!(full.records.len(), 50);
        assert!(cut.more && cut.records.len() < 10, "{} records", cut.records.len());
        assert!(cut.records.iter().map(|r| r.len()).sum::<usize>() <= 64 * 1024);
    }

    #[test]
    fn empty_more_responses_are_not_followed() {
        assert!(follow_up(true, true));
        assert!(!follow_up(true, false));
        assert!(!follow_up(false, true));
    }

    #[test]
    fn relay_backoff_is_jittered_by_at_most_20_percent() {
        let base = Duration::from_secs(10);
        assert_eq!(jittered(base, 0), Duration::from_secs(8));
        assert_eq!(jittered(base, u32::MAX), Duration::from_secs(12));
        for _ in 0..1000 {
            let d = jittered(base, OsRng.next_u32());
            assert!(d >= Duration::from_secs(8) && d <= Duration::from_secs(12), "{d:?}");
        }
        // The cap with jitter still reconnects within a minute.
        assert!(jittered(RELAY_BACKOFF_MAX, u32::MAX) <= Duration::from_secs(36));
    }

    #[test]
    fn topic_filter_accepts_only_log_topics() {
        let mut filter = LogTopics;
        assert!(filter.can_subscribe(&TopicHash::from_raw(format!("log/{}", chan()))));
        assert!(!filter.can_subscribe(&TopicHash::from_raw("log/")));
        assert!(!filter.can_subscribe(&TopicHash::from_raw("something-else")));
        assert!(!filter.can_subscribe(&TopicHash::from_raw(format!("log/{}", "x".repeat(10_000)))));
        let handle = ServerSecret::from_bytes([9; 32]).handle(Scope::Control);
        assert!(filter.can_subscribe(&TopicHash::from_raw(handle.wire())));
        assert!(!filter.can_subscribe(&TopicHash::from_raw("h/1234")));
    }

    fn sealed_logs(secret: &ServerSecret) -> (HashSet<String>, Sealing) {
        let mut sealing = Sealing::default();
        let mut open = HashSet::new();
        for scope in [Scope::Control, Scope::Channel(channel())] {
            let log = log_name(server(), scope);
            open.insert(log.clone());
            let sealed = Sealed { server: server(), scope, handle: secret.handle(scope), key: secret.gossip_key(scope) };
            sealing.insert(log, sealed);
        }
        (open, sealing)
    }

    #[test]
    fn sealed_gossip_is_opened_then_checked_like_any_record() {
        let secret = ServerSecret::from_bytes([9; 32]);
        let (open, sealing) = sealed_logs(&secret);
        let chan_scope = Scope::Channel(channel());
        let (handle, key) = (secret.handle(chan_scope), secret.gossip_key(chan_scope));
        let on = |topic: &Handle, data: Vec<u8>| gossipsub::Message {
            source: None,
            data,
            sequence_number: None,
            topic: TopicHash::from_raw(topic.wire()),
        };
        let m = crate::testutil::message(0, &[], 0);
        assert_eq!(check_pushed(&open, &sealing, &on(&handle, access::seal(&key, &handle, &m.encode()))), Ok(m.clone()));

        // Plaintext, or sealed under another log's key or topic: refused.
        assert_eq!(check_pushed(&open, &sealing, &on(&handle, m.encode())), Err(Refuse::Reject));
        let control = secret.handle(Scope::Control);
        let moved = access::seal(&key, &handle, &m.encode());
        assert_eq!(check_pushed(&open, &sealing, &on(&control, moved)), Err(Refuse::Reject));
        let wrong_key = ServerSecret::from_bytes([8; 32]).gossip_key(chan_scope);
        assert_eq!(check_pushed(&open, &sealing, &on(&handle, access::seal(&wrong_key, &handle, &m.encode()))), Err(Refuse::Reject));
        // Opens fine but signed another log (sealed by a secret holder): still refused.
        let g = crate::testutil::genesis();
        assert_eq!(check_pushed(&open, &sealing, &on(&handle, access::seal(&key, &handle, &g.encode()))), Err(Refuse::Reject));
        // A handle we don't hold, or a sealed log under its plain name: not ours.
        let unknown = ServerSecret::from_bytes([7; 32]).handle(chan_scope);
        assert_eq!(check_pushed(&open, &sealing, &on(&unknown, m.encode())), Err(Refuse::Ignore));
        assert_eq!(check_pushed(&open, &sealing, &pushed(&chan(), m.encode())), Err(Refuse::Ignore));
    }

    /// Lets one identity read channels.
    struct OnlyReader(PublicKey);

    impl ReadGate for OnlyReader {
        fn may_read(&self, reader: &PublicKey, _: &crate::ControlLog<'_>) -> bool {
            *reader == self.0
        }
    }

    /// The TCP port `node` actually listens on (it was started on port 0).
    /// Tests used to pick a free port first and bind it later; on Windows a
    /// parallel test could get the same port in between, and nodes of two
    /// tests then met each other.
    async fn port_of(node: &Node) -> u16 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            for addr in node.listen_addrs().await.unwrap() {
                if let Some(Protocol::Tcp(port)) = addr.iter().find(|p| matches!(p, Protocol::Tcp(_))) {
                    return port;
                }
            }
            assert!(Instant::now() < deadline, "node never listened");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn test_node(name: &str, listen: Option<u16>, bootstrap: Option<u16>, access: Access) -> Node {
        test_node_events(name, listen, bootstrap, access).await.0
    }

    async fn test_node_events(
        name: &str,
        listen: Option<u16>,
        bootstrap: Option<u16>,
        access: Access,
    ) -> (Node, mpsc::Receiver<NodeEvent>) {
        // One folder per test node: parallel tests reuse names ("member",
        // "stranger"), and a shared folder would share its key and store.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sync-gap4-{}-{n}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = NodeConfig {
            // Nothing listens there: no relay in this test.
            relay: format!("/ip4/127.0.0.1/tcp/9/p2p/{}", PeerId::random()).parse().unwrap(),
            more_relays: vec![],
            data_dir: dir,
            logs: Vec::new(),
            authorizer: Arc::new(AcceptAll),
            listen: format!("/ip4/127.0.0.1/tcp/{}", listen.unwrap_or(0)).parse().unwrap(),
            bootstrap: bootstrap.map(|p| format!("/ip4/127.0.0.1/tcp/{p}").parse().unwrap()).into_iter().collect(),
            allow_lan: true,
            relay_only: false,
        };
        Node::start_with(config, access).await.unwrap()
    }

    /// The next Sent/Delivered event for `id`, or None after `secs`.
    async fn tick(events: &mut mpsc::Receiver<NodeEvent>, id: RecordId, secs: u64) -> Option<&'static str> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            match tokio::time::timeout_at(deadline, events.recv()).await {
                Ok(Some(NodeEvent::Sent { id: got })) if got == id => return Some("sent"),
                Ok(Some(NodeEvent::Delivered { id: got })) if got == id => return Some("delivered"),
                Ok(Some(_)) => {}
                _ => return None,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_message_is_sent_then_delivered_once_a_member_stored_it() {
        use crate::testutil::{message, test_key};
        let secret = ServerSecret::from_bytes([10; 32]);
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        // The author (test key 1, who signs `message`) counts only key 0 as a member.
        let members: Arc<dyn ReadGate> = Arc::new(OnlyReader(test_key(0).identity()));
        let (author, mut events) =
            test_node_events("author", None, None, Access { binder: key(1), read_gate: Some(members), stub_gate: None }).await;
        let port = port_of(&author).await;
        author.open_server(server(), secret.clone()).unwrap();
        author.open_channel(server(), channel()).await.unwrap();

        // Nobody connected: stored and signed, but not sent.
        let first = message(0, &[], 0);
        author.append(first.clone()).await.unwrap();
        assert_eq!(tick(&mut events, first.id(), 1).await, None);

        // A bound non-member (key 2) can't pull the channel: still not sent.
        let peer = |name: &'static str, n: u8| {
            let secret = secret.clone();
            async move {
                let access = Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
                let node = test_node(name, None, Some(port), access).await;
                node.open_server(server(), secret).unwrap();
                node.open_channel(server(), channel()).await.unwrap();
                node
            }
        };
        let stranger = peer("stranger", 2).await;
        assert_eq!(tick(&mut events, first.id(), ANTI_ENTROPY.as_secs() + 1).await, None);

        // A member (key 0) pulls it (sent), stores it and acks it (delivered).
        let member = peer("member", 0).await;
        assert_eq!(tick(&mut events, first.id(), 20).await, Some("sent"));
        assert_eq!(tick(&mut events, first.id(), 20).await, Some("delivered"));

        // A new message with peers connected: sent at once, then delivered.
        let second = message(1, &[first.id()], 0);
        author.append(second.clone()).await.unwrap();
        assert_eq!(tick(&mut events, second.id(), 1).await, Some("sent"));
        assert_eq!(tick(&mut events, second.id(), 10).await, Some("delivered"));
        for node in [author, stranger, member] {
            node.shutdown().await.unwrap();
        }
    }

    /// P0 (0.3.1 joins): a long-used node with many servers no longer floods
    /// a peer that shares one of them with pulls for every log it holds. A
    /// fresh peer opening that one server gets its records in normal time,
    /// and neither side ever has to refuse the other's pulls.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_node_with_many_servers_pulls_only_what_a_peer_shares() {
        use crate::testutil::{message, test_key};
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        let access = |n: u8| Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
        let secret = ServerSecret::from_bytes([10; 32]);
        let (many, _events) = test_node_events("many", None, None, access(1)).await;
        let port = port_of(&many).await;
        for i in 0..40u8 {
            let other = ServerId::from_bytes([100 + i; 32]);
            many.open_server(other, ServerSecret::from_bytes([200 - i; 32])).unwrap();
            many.open_channel(other, ChannelId::from_bytes([150 + i; 32])).await.unwrap();
        }
        many.open_server(server(), secret.clone()).unwrap();
        many.open_channel(server(), channel()).await.unwrap();
        many.append(message(0, &[], 0)).await.unwrap();

        let fresh = test_node("fresh", None, Some(port), access(0)).await;
        fresh.open_server(server(), secret).unwrap();
        fresh.open_channel(server(), channel()).await.unwrap();
        // Timed from here: what's measured is the sync, not how long a new
        // node takes to create its key and store (seconds on a busy disk,
        // the flake that put this test on the board).
        let start = Instant::now();
        eventually(&fresh, (0, 1), 15).await;
        let took = start.elapsed();
        assert!(took < Duration::from_secs(10), "the shared server's records took {took:?}");
        // Two more anti-entropy rounds with 82 logs on one side: nobody had to
        // refuse a pull (before, the first round alone was 82 pulls at once).
        tokio::time::sleep(ANTI_ENTROPY * 2 + Duration::from_secs(1)).await;
        assert_eq!((many.rate_limited().await, fresh.rate_limited().await), (0, 0), "pulls refused (many, fresh)");
        for node in [many, fresh] {
            node.shutdown().await.unwrap();
        }
    }

    /// A burst of local writes while a peer that shares none of our servers
    /// is connected (QA's owner posting with a second device online): the
    /// receipt pulls after each write go only to members, so that peer never
    /// has to refuse a pull.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_burst_pulls_only_from_members() {
        use crate::testutil::{message_in, test_key};
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        let access = |n: u8| Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
        let (writer, _events) = test_node_events("writer", None, None, access(1)).await;
        let port = port_of(&writer).await;
        writer.open_server(server(), ServerSecret::from_bytes([11; 32])).unwrap();
        // 60 channels: each write lands in a log of its own, as QA's owner
        // writing across many servers did (one log's writes coalesce).
        let channels: Vec<ChannelId> = (0..60u8).map(|i| ChannelId::from_bytes([100 + i; 32])).collect();
        for c in &channels {
            writer.open_channel(server(), *c).await.unwrap();
        }
        let other = test_node("other", None, Some(port), access(0)).await;
        other.open_server(ServerId::from_bytes([77; 32]), ServerSecret::from_bytes([78; 32])).unwrap();
        let start = Instant::now();
        while writer.peers().await.unwrap().is_empty() {
            assert!(start.elapsed() < Duration::from_secs(10), "never connected");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        for c in &channels {
            writer.append(message_in(*c)).await.unwrap();
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(other.rate_limited().await, 0, "the non-member refused pulls after a write burst");
        for node in [writer, other] {
            node.shutdown().await.unwrap();
        }
    }

    /// T23: once an unbound peer answered our servers' control logs empty, it
    /// isn't asked for them again (each ask carries our binding): after the
    /// first rounds, a fresh peer gets only the pulls for the server it shares.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unbound_peer_is_not_asked_again_for_what_it_answered_empty() {
        use crate::testutil::test_key;
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        let access = |n: u8| Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
        let secret = ServerSecret::from_bytes([12; 32]);
        let (many, _events) = test_node_events("t23-many", None, None, access(1)).await;
        let port = port_of(&many).await;
        for i in 0..40u8 {
            let other = ServerId::from_bytes([60 + i; 32]);
            many.open_server(other, ServerSecret::from_bytes([150 - i; 32])).unwrap();
        }
        many.open_server(server(), secret.clone()).unwrap();
        let fresh = test_node("t23-fresh", None, Some(port), access(0)).await;
        fresh.open_server(server(), secret).unwrap();
        // Connect, then three rounds: every control log probed once.
        tokio::time::sleep(ANTI_ENTROPY * 3 + Duration::from_secs(2)).await;
        let before = fresh.pulls_received().await;
        tokio::time::sleep(ANTI_ENTROPY * 2 + Duration::from_secs(1)).await;
        let later = fresh.pulls_received().await - before;
        // Two more rounds: only the shared server's control log (and
        // follow-ups), not the 40 it has nothing of.
        assert!(later <= 6, "{later} pulls in two rounds after the probes");
        assert!(before >= 40, "only {before} pulls before: the probes never ran");
        for node in [many, fresh] {
            node.shutdown().await.unwrap();
        }
    }

    /// T23: two members who each already have a bound peer for the server
    /// still bind when they meet later (the first probe is allowed).
    #[tokio::test(flavor = "multi_thread")]
    async fn members_who_meet_late_still_bind() {
        use crate::testutil::test_key;
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        let access = |n: u8| Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
        let secret = ServerSecret::from_bytes([13; 32]);
        let identity = |n: u8| test_key(n).identity();
        let start_pair = |a: &'static str, b: &'static str, ka: u8, kb: u8| {
            let secret = secret.clone();
            async move {
                let (first, _) = test_node_events(a, None, None, access(ka)).await;
                first.open_server(server(), secret.clone()).unwrap();
                let second = test_node(b, None, Some(port_of(&first).await), access(kb)).await;
                second.open_server(server(), secret).unwrap();
                (first, second)
            }
        };
        async fn online(node: &Node, want: PublicKey) -> bool {
            node.presence(server()).await.unwrap().online.contains(&want)
        }
        let seen = |node, n: u8| online(node, identity(n));
        let (a, b) = start_pair("late-a", "late-b", 1, 0).await;
        let (c, d) = start_pair("late-c", "late-d", 2, 3).await;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !(seen(&a, 0).await && seen(&c, 3).await) {
            assert!(Instant::now() < deadline, "the first pairs never bound");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // Now A and C meet: each already has a bound member.
        c.test_dial(format!("/ip4/127.0.0.1/tcp/{}", port_of(&a).await).parse().unwrap());
        let deadline = Instant::now() + Duration::from_secs(20);
        while !(seen(&a, 2).await && seen(&c, 1).await) {
            assert!(Instant::now() < deadline, "members who met late never bound");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for node in [a, b, c, d] {
            node.shutdown().await.unwrap();
        }
    }

    /// The Tech Lead on #399: a silently dead connection to our relay is
    /// closed within about a minute (two failed pings in a row), so the
    /// member relay fallback starts; one lost ping alone closes nothing.
    #[test]
    fn a_silent_relay_is_closed_within_a_minute() {
        assert!(relay_silent_for() <= Duration::from_secs(60), "{:?}", relay_silent_for());
        let mut misses = 0;
        assert!(!relay_ping(&mut misses, false), "one miss");
        assert!(!relay_ping(&mut misses, true), "an answer resets");
        assert!(!relay_ping(&mut misses, false));
        assert!(relay_ping(&mut misses, false), "two in a row close it");
        assert_eq!(misses, 0);
    }

    #[test]
    fn t23_maps_stay_under_the_cap_dropping_the_oldest() {
        let mut map: HashMap<u32, Instant> = HashMap::new();
        let start = Instant::now();
        for i in 0..(MAX_T23_ENTRIES as u32 + 50) {
            cap_oldest(&mut map, &i, |at| *at);
            map.insert(i, start + Duration::from_millis(u64::from(i)));
        }
        assert_eq!(map.len(), MAX_T23_ENTRIES);
        assert!(!map.contains_key(&0) && !map.contains_key(&49), "the oldest stayed");
        assert!(map.contains_key(&(MAX_T23_ENTRIES as u32 + 49)), "the newest went");
        // At the cap, overwriting a key drops nothing.
        let key = MAX_T23_ENTRIES as u32 + 49;
        cap_oldest(&mut map, &key, |at| *at);
        map.insert(key, start);
        assert_eq!(map.len(), MAX_T23_ENTRIES);
        assert!(map.contains_key(&50), "an overwrite evicted the oldest");
    }

    /// 0.4.1 presence bug: three members in a triangle (each has another bound
    /// member). One link resets and comes back: both ends must see each other
    /// online again soon, not after T23's 10-minute re-probe wait.
    #[tokio::test(flavor = "multi_thread")]
    async fn members_see_each_other_online_again_after_a_link_reset() {
        use crate::testutil::test_key;
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        let access = |n: u8| Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
        let secret = ServerSecret::from_bytes([14; 32]);
        async fn online(node: &Node, want: PublicKey) -> bool {
            node.presence(server()).await.unwrap().online.contains(&want)
        }
        let id = |n: u8| test_key(n).identity();
        let addr = |port: u16| -> Multiaddr { format!("/ip4/127.0.0.1/tcp/{port}").parse().unwrap() };
        // C first; B meets C, then A meets C: A and B each already have a
        // bound member when they meet, so their first probes are recorded.
        let (c, _) = test_node_events("tri-c", None, None, access(2)).await;
        c.open_server(server(), secret.clone()).unwrap();
        let b = test_node("tri-b", None, Some(port_of(&c).await), access(1)).await;
        b.open_server(server(), secret.clone()).unwrap();
        let a = test_node("tri-a", None, Some(port_of(&c).await), access(0)).await;
        a.open_server(server(), secret).unwrap();
        // Generous: the Windows runner is slow to set up connections.
        let wait = |what: &'static str| (what, Instant::now() + Duration::from_secs(60));
        let (what, until) = wait("B and A bound to C");
        while !(online(&b, id(2)).await && online(&a, id(2)).await) {
            assert!(Instant::now() < until, "{what}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        a.test_dial(addr(port_of(&b).await));
        let (what, until) = wait("A and B bound");
        while !(online(&a, id(1)).await && online(&b, id(0)).await) {
            assert!(Instant::now() < until, "{what}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // The A–B link resets (a relay circuit reset), then A dials B again.
        a.test_disconnect(b.peer_id());
        tokio::time::sleep(Duration::from_secs(1)).await;
        // Redial until linked again, over TCP and QUIC: on Windows a TCP
        // redial from the reused listen port to the same peer can sit in
        // TIME_WAIT for minutes (a real device would come back through the
        // relay). Only the link is retried; the claim stays the same.
        let port_b = port_of(&b).await;
        let quic_b: Multiaddr = format!("/ip4/127.0.0.1/udp/{port_b}/quic-v1").parse().unwrap();
        let (what, until) = wait("A and B online again after the reset");
        let mut redial = Instant::now() - Duration::from_secs(10);
        while !(online(&a, id(1)).await && online(&b, id(0)).await) {
            assert!(Instant::now() < until, "{what}");
            if redial.elapsed() >= Duration::from_secs(3) && !a.peers().await.unwrap().contains(&b.peer_id()) {
                a.test_dial(addr(port_b));
                a.test_dial(quic_b.clone());
                redial = Instant::now();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for node in [a, b, c] {
            node.shutdown().await.unwrap();
        }
    }

    /// T24: T23 under `open` plus
    /// the queue. Opening 40 servers back to back while an unbound peer is
    /// connected sends ~40 control pulls within a second, past the peer's
    /// burst (30); refused pulls aren't recorded as empty and are re-asked
    /// (51 pulls for 40 logs). Fix: pace outgoing pulls per peer (e.g. burst
    /// 20, 8/s) and drain the queue on a 1 s tick.
    #[tokio::test(flavor = "multi_thread")]
    async fn servers_opened_while_a_peer_is_connected_are_probed_once_each() {
        use crate::testutil::test_key;
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        let access = |n: u8| Access { binder: key(n), read_gate: Some(Arc::new(AcceptAll)), stub_gate: None };
        let (opener, _events) = test_node_events("t23-opener", None, None, access(1)).await;
        let peer = test_node("t23-peer", None, Some(port_of(&opener).await), access(0)).await;
        peer.open_server(ServerId::from_bytes([99; 32]), ServerSecret::from_bytes([98; 32])).unwrap();
        let start = Instant::now();
        while opener.peers().await.unwrap().is_empty() {
            assert!(start.elapsed() < Duration::from_secs(10), "never connected");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let before = peer.pulls_received().await;
        for i in 0..40u8 {
            opener.open_server(ServerId::from_bytes([20 + i; 32]), ServerSecret::from_bytes([120 + i; 32])).unwrap();
        }
        tokio::time::sleep(ANTI_ENTROPY * 3 + Duration::from_secs(1)).await;
        let asked = peer.pulls_received().await - before;
        assert!(asked <= 44, "{asked} pulls for 40 control logs (at most one each, plus a few)");
        assert!(asked >= 40, "only {asked}: the opened servers weren't probed");
        for node in [opener, peer] {
            node.shutdown().await.unwrap();
        }
    }

    async fn counts(node: &Node) -> (u64, u64) {
        let control = node.state(&log_name(server(), Scope::Control)).await.unwrap().count;
        (control, node.state(&chan()).await.unwrap().count)
    }

    /// Waits until `node` holds `want`, or fails after `secs`.
    async fn eventually(node: &Node, want: (u64, u64), secs: u64) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while counts(node).await != want {
            assert!(Instant::now() < deadline, "expected {want:?}, have {:?}", counts(node).await);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sealed_servers_are_served_to_bound_members_only() {
        use crate::testutil::{genesis, message, test_key};
        let secret = ServerSecret::from_bytes([9; 32]);
        let key = |n: u8| -> Option<Arc<dyn Binder>> { Some(Arc::new(test_key(n))) };
        // The owner's node serves channels to test key 1 only.
        let reader: Arc<dyn ReadGate> = Arc::new(OnlyReader(test_key(1).identity()));
        let owner = test_node("owner", None, None, Access { binder: key(0), read_gate: Some(reader), stub_gate: None }).await;
        let port = port_of(&owner).await;
        owner.open_server(server(), secret.clone()).unwrap();
        owner.open_channel(server(), channel()).await.unwrap();
        owner.append(genesis()).await.unwrap();
        owner.append(message(0, &[], 0)).await.unwrap();
        // A plain-name request for a sealed log is never answered.
        owner.open(&chan()).unwrap();

        let peer = |name: &'static str, binder, secret: ServerSecret| async move {
            let node = test_node(name, None, Some(port), Access { binder, read_gate: None, stub_gate: None }).await;
            node.open_server(server(), secret).unwrap();
            node.open_channel(server(), channel()).await.unwrap();
            node
        };
        let member = peer("member", key(1), secret.clone()).await;
        // The stranger's stored records, with how they came (pull or push).
        let (stranger, mut events) =
            test_node_events("stranger", None, Some(port), Access { binder: key(2), read_gate: None, stub_gate: None })
                .await;
        stranger.open_server(server(), secret.clone()).unwrap();
        stranger.open_channel(server(), channel()).await.unwrap();
        let stored = Arc::new(Mutex::new(Vec::<(String, RecordId, Via)>::new()));
        let log_events = stored.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if let NodeEvent::Stored { log, record, via, .. } = event {
                    log_events.lock().unwrap().push((log, record.id(), via));
                }
            }
        });
        let unbound = peer("unbound", None, secret.clone()).await;
        let outsider = peer("outsider", key(1), ServerSecret::from_bytes([8; 32])).await;
        let by_name = test_node("by-name", None, Some(port), Access::default()).await;
        by_name.open(&chan()).unwrap();
        by_name.open(&log_name(server(), Scope::Control)).unwrap();

        // The member gets everything; a bound non-member only the control log.
        eventually(&member, (1, 1), 20).await;
        eventually(&stranger, (1, 0), 20).await;
        // Live push reaches the member (sealed gossip, or the next pull). The
        // non-member holds the secret, so the push may reach it too (residual
        // GAP-4b), but it builds on a record only a pull would give it.
        let first = message(0, &[], 0);
        owner.append(message(1, &[first.id()], 0)).await.unwrap();
        eventually(&member, (1, 2), 20).await;
        // A control record written after all that: once the stranger has it,
        // its later pulls (control and channel alike) have been answered. No
        // fixed sleep; the stranger's own progress is the clock.
        let later = crate::testutil::post(1, &[genesis().id()]);
        owner.append(later.clone()).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !stored.lock().unwrap().iter().any(|(_, id, _)| *id == later.id()) {
            assert!(Instant::now() < deadline, "the stranger stopped syncing its control log");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(ANTI_ENTROPY).await; // one more full round of pulls
        // The security property: no channel record ever reached the bound
        // non-member *by pull*. (Sealed gossip to a secret holder is the
        // documented GAP-4b residual; it only got m1, which waits for m0.)
        let pulled: Vec<_> = stored.lock().unwrap().iter().filter(|(log, _, via)| *log == chan() && *via == Via::Pull).cloned().collect();
        assert!(pulled.is_empty(), "a bound non-member pulled a channel: {pulled:?}");
        // And at the source: the owner's answers to the stranger carried
        // control records but not one channel entry. So this checks the
        // ReadGate path itself, not gossip.
        assert!(owner.served(stranger.peer_id(), &log_name(server(), Scope::Control)).await >= 1);
        assert_eq!(owner.served(stranger.peer_id(), &chan()).await, 0, "the owner served the channel to a non-member");
        assert!(owner.served(member.peer_id(), &chan()).await >= 1);
        assert_eq!(counts(&stranger).await, (2, 0));
        assert_eq!(counts(&unbound).await, (0, 0), "a pull without a binding was answered");
        assert_eq!(counts(&outsider).await, (0, 0), "a wrong secret was answered");
        assert_eq!(counts(&by_name).await, (0, 0), "a sealed log was served by its plain name");
        for node in [owner, member, stranger, unbound, outsider, by_name] {
            node.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn the_relay_can_be_dialled_over_wss() {
        let mut swarm = build_swarm(
            identity::Keypair::generate_ed25519(),
            vec!["/ip4/1.2.3.4/tcp/1".parse().unwrap()],
            Arc::new(Mutex::new(DialBackoff::new(DIAL_BACKOFF_MIN, DIAL_BACKOFF_MAX, 4))),
            false,
        ).await.unwrap();
        let relay = PeerId::random();
        // Without a WebSocket transport this fails at once ("multiaddr not
        // supported"); with it, the dial is started (DNS + TLS + WebSocket).
        let wss: Multiaddr = format!("/dns4/relay.example.org/tcp/443/wss/p2p/{relay}").parse().unwrap();
        swarm.dial(wss).unwrap();
        let ws: Multiaddr = format!("/ip4/127.0.0.1/tcp/9/ws/p2p/{relay}").parse().unwrap();
        swarm.dial(ws).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_nodes_sync_over_websocket() {
        let node = |name: &str, listen: String, bootstrap: Vec<Multiaddr>| {
            let dir = std::env::temp_dir().join(format!("sync-ws-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            NodeConfig {
                // Nothing listens there: no relay in this test.
                relay: format!("/ip4/127.0.0.1/tcp/9/p2p/{}", PeerId::random()).parse().unwrap(),
                more_relays: vec![],
                data_dir: dir,
                logs: vec![chan()],
                authorizer: Arc::new(AcceptAll),
                listen: listen.parse().unwrap(),
                bootstrap,
                allow_lan: true,
                relay_only: false,
            }
        };
        let (a, _a_events) = Node::start(node("a", "/ip4/127.0.0.1/tcp/0/ws".into(), vec![])).await.unwrap();
        let port = port_of(&a).await;
        let ws = format!("/ip4/127.0.0.1/tcp/{port}/ws").parse().unwrap();
        let (b, _b_events) = Node::start(node("b", "/ip4/127.0.0.1/tcp/0".into(), vec![ws])).await.unwrap();
        a.append(crate::testutil::message(0, &[], 0)).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while b.state(&chan()).await.unwrap().count == 0 {
            assert!(Instant::now() < deadline, "no sync over /ws");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(b.peers().await.unwrap(), vec![a.peer_id()]);
        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
    }

    /// Presence (M2) end to end: a member is online on both sides within
    /// 5 s; a bound non-member learns only who pulls from it (GAP-4b); a member that
    /// leaves is offline within 30 s.
    #[tokio::test(flavor = "multi_thread")]
    async fn members_are_online_within_5_s_and_offline_within_30_s_of_leaving() {
        use crate::testutil::test_key;
        let secret = ServerSecret::from_bytes([11; 32]);
        let id = |n: u8| test_key(n).identity();
        let node = |name: &'static str, n: u8, listen, bootstrap, gate: Arc<dyn ReadGate>| {
            let secret = secret.clone();
            async move {
                let access = Access { binder: Some(Arc::new(test_key(n))), read_gate: Some(gate), stub_gate: None };
                let node = test_node(name, listen, bootstrap, access).await;
                node.open_server(server(), secret).unwrap();
                node
            }
        };
        // The owner (key 0) counts key 1 as a member, not key 2.
        let owner = node("p-owner", 0, None, None, Arc::new(OnlyReader(id(1)))).await;
        let port = port_of(&owner).await;
        let started = Instant::now();
        let member = node("p-member", 1, None, Some(port), Arc::new(AcceptAll)).await;
        let stranger = node("p-stranger", 2, None, Some(port), Arc::new(AcceptAll)).await;
        async fn online(n: &Node) -> PresenceState {
            n.presence(server()).await.unwrap()
        }
        while !(online(&owner).await.online.contains(&id(1)) && online(&member).await.online.contains(&id(0))) {
            assert!(started.elapsed() < Duration::from_secs(5), "member not online on both sides within 5 s");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(online(&member).await.reachability, Reachability::Online);
        tokio::time::sleep(ANTI_ENTROPY + Duration::from_secs(1)).await;
        // The stranger is bound (reported to the owner; the app filters), but
        // never gets the owner's binding, so it sees nobody.
        assert!(online(&owner).await.online.contains(&id(2)));
        // Residual GAP-4b (PRESENCE.md): members pull from the stranger too,
        // and a pull carries the requester's binding, so the stranger learns
        // who pulls from it (here the owner; it meets nobody else since LAN
        // addresses never enter the DHT, F2). Its answers never told it
        // anything (below).
        assert!(online(&stranger).await.online.contains(&id(0)));
        // Our own identity is never listed.
        assert!(!online(&owner).await.online.contains(&id(0)));

        member.shutdown().await.unwrap();
        let left = Instant::now();
        while online(&owner).await.online.contains(&id(1)) {
            assert!(left.elapsed() < Duration::from_secs(30), "member still online 30 s after leaving");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(online(&owner).await.last_seen.is_some());
        owner.shutdown().await.unwrap();
        stranger.shutdown().await.unwrap();
    }

    /// Direct (LAN) addresses go only to a member, and never in relay-only
    /// mode or without LAN allowed (`share_direct` false).
    #[test]
    fn direct_addresses_go_to_members_only_and_never_when_relay_only() {
        use crate::testutil::test_key;
        let store = Store::in_memory().unwrap();
        let control = ServerSecret::from_bytes([9; 32]).handle(Scope::Control);
        let binding = Binding::sign(&test_key(0), &PeerId::random(), &control, unix_now() + 3600);
        let direct: Vec<Multiaddr> = vec!["/ip4/192.168.1.5/tcp/4001".parse().unwrap()];
        let gate: Arc<dyn ReadGate> = Arc::new(OnlyReader(test_key(1).identity()));
        let answer = |n: u8, share_direct: bool| {
            let mut response = empty_response();
            let check = ReadCheck { gate: gate.clone(), identity: test_key(n).identity(), server: server() };
            member_extras(&mut response, Some((check, binding.clone())), &[], &direct, share_direct, None, &store);
            response.direct_addrs
        };
        assert_eq!(answer(1, true).len(), 1, "a member gets our direct addresses");
        assert!(answer(1, false).is_empty(), "relay-only (or LAN off): none, even to a member");
        assert!(answer(2, true).is_empty(), "a non-member: none");
        // Slice 2: our member relay offer, to a member only.
        let offer = RelayOffer { addrs: vec![ByteBuf::from(direct[0].to_vec())], preferred: true };
        let offered = |n: u8| {
            let mut response = empty_response();
            let check = ReadCheck { gate: gate.clone(), identity: test_key(n).identity(), server: server() };
            member_extras(&mut response, Some((check, binding.clone())), &[], &direct, false, Some(&offer), &store);
            response.relay
        };
        assert_eq!(offered(1), Some(offer.clone()), "a member learns we relay");
        assert_eq!(offered(2), None, "a non-member never does");
    }

    /// The answer side of presence: our binding and acks go only to a
    /// requester our read gate accepts as a member.
    #[test]
    fn our_binding_and_acks_go_to_members_only() {
        use crate::testutil::test_key;
        let store = Store::in_memory().unwrap();
        let control = ServerSecret::from_bytes([9; 32]).handle(Scope::Control);
        let binding = Binding::sign(&test_key(0), &PeerId::random(), &control, unix_now() + 3600);
        let acks = [RecordId::from_bytes([1; 32])];
        let gate: Arc<dyn ReadGate> = Arc::new(OnlyReader(test_key(1).identity()));
        let answer_to = |n: u8| {
            let mut response = empty_response();
            let check = ReadCheck { gate: gate.clone(), identity: test_key(n).identity(), server: server() };
            for_members_only(&mut response, Some((check, binding.clone())), &acks, &store);
            response
        };
        let member = answer_to(1);
        assert_eq!(member.binding, Some(binding.clone()));
        assert_eq!(member.acks.len(), 1);
        let stranger = answer_to(2);
        assert_eq!(stranger.binding, None);
        assert!(stranger.acks.is_empty());
    }

    /// B6-p end to end: the only peer pruned a deleted message, so a newcomer
    /// can only get the stub. It arrives before the delete (page order) and
    /// ends up stored with it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_newcomer_gets_the_stub_of_a_message_everyone_pruned() {
        use crate::testutil::{delete, message, DeletedOnly};
        let access = || Access { stub_gate: Some(Arc::new(DeletedOnly)), ..Access::default() };
        let old = test_node("pruner", None, None, access()).await;
        let port = port_of(&old).await;
        old.open(&chan()).unwrap();
        let m = message(0, &[], 100);
        let d = delete(1, &m);
        old.append(m.clone()).await.unwrap();
        // Not before its delete is held.
        assert!(!old.prune(m.id()).await.unwrap());
        old.append(d.clone()).await.unwrap();
        assert!(old.prune(m.id()).await.unwrap());

        let new = test_node("newcomer", None, Some(port), access()).await;
        new.open(&chan()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while new.state(&chan()).await.unwrap().count < 2 {
            assert!(Instant::now() < deadline, "the newcomer never stored the stub and its delete");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(new.state(&chan()).await.unwrap().hash, old.state(&chan()).await.unwrap().hash);
        // Without a stub gate, the newcomer would wait for a full record nobody has.
        let strict = test_node("strict", None, Some(port), Access::default()).await;
        strict.open(&chan()).unwrap();
        tokio::time::sleep(ANTI_ENTROPY + Duration::from_secs(1)).await;
        assert_eq!(strict.state(&chan()).await.unwrap().count, 0);
        for node in [old, new, strict] {
            node.shutdown().await.unwrap();
        }
    }
}
