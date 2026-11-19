//! The core: `CoreCommands` from `ui/src/core/api.ts`, one method each.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use authority::{Action, Cut};
use groupkeys::MemberSecret;
use identity::{PhraseError, RecoveryPhrase, Vault, VaultError, VaultState};
use rand_core::{OsRng, RngCore};
use records::{ChannelId, Draft, Kind, PublicKey, Record, RecordId, Scope, ServerId};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::applock;
use crate::avatar;
use crate::backup;
use crate::devicelink::{self, OneTimeKey, Target};
use crate::chat;
use crate::reaction;
use crate::db::Db;
use crate::model::{self, GenesisBody, Log, ServerView};
use crate::ports::{CipherError, DeviceLinkAddr, DeviceLinkError, DeviceLinkInbound, GroupCipher, Network, Ports, Reach, SharedSecrets};
use crate::recovery;
use crate::rekey::JoinBucket;
use crate::types::*;
use crate::update::Updates;
use crate::typing::{self, TypingNet};
use crate::voice::{self, VoiceNet};
use updater::client::UpdateEvent;

const DEFAULT_STORAGE_LIMIT: u64 = 5 * 1024 * 1024 * 1024;
const KV_STORAGE_LIMIT: &str = "storage-limit";
const KV_UPDATE_CHANNEL: &str = "update-channel";
/// GAP-6r: `[1]` while relay-only is on. Per device, not per identity: it's
/// about this computer's network.
const KV_RELAY_ONLY: &str = "relay-only";
/// G-51: when this device last set a server's icon, per server (u64 LE ms).
const KV_ICON_SET_PREFIX: &str = "icon-set/";
/// G-51: at most one icon change per server per 10 minutes from this device:
/// every icon (up to 8 KiB) stays in the control log.
const ICON_EVERY_MS: u64 = 10 * 60_000;
/// Device link: "a new device was added" notices not yet acknowledged
/// (`ackDeviceNotice`), as JSON `[at, …]` (ms). Re-announced after each
/// start until acknowledged; the cross-device notice will feed it too.
const KV_DEVICE_NOTICES: &str = "device-notices";
/// At most this many notices are kept, the newest.
const MAX_DEVICE_NOTICES: usize = 32;
/// Member relays (#368, slice 1): `auto`, `on` or `off` (default `auto`);
/// the one-time disclosure seen (`[1]`); the daily cap in MB (u32le).
const KV_MEMBER_RELAY: &str = "member-relay";
const KV_MEMBER_RELAY_SEEN: &str = "member-relay-disclosure-seen";
const KV_MEMBER_RELAY_CAP: &str = "member-relay-cap-mb";
/// Slice 3b: the last verified `memberRelayOff` from the signed `flags.json`.
/// Written only by the update loop; there is no command for it.
const KV_MEMBER_RELAY_GLOBAL_OFF: &str = "member-relay-global-off";
/// G-29: "0" when "Show others when I'm typing" is off; absent is on.
const KV_TYPING_INDICATOR: &str = "typing-indicator";
/// The member relay's daily cap: default and accepted range, in MB.
pub const MEMBER_RELAY_CAP_DEFAULT_MB: u32 = 2_048;
pub const MEMBER_RELAY_CAP_MB: std::ops::RangeInclusive<u32> = 256..=51_200;

/// Fails closed: off only when never set or set to off (`[0]`); any other
/// value is on.
fn relay_only_in(db: &Db) -> CoreResult<bool> {
    Ok(!matches!(db.get(KV_RELAY_ONLY)?.as_deref(), None | Some([0])))
}

/// GAP-6r: the stored relay-only setting in the core database at
/// `db_path`, read before the network starts so the node starts with it.
/// Fails closed: a database that can't be opened or read means on, so an
/// error never starts a relay-only user with direct connections. A fresh
/// data dir (no `core.db` yet) is off: the database is created empty.
pub fn stored_relay_only(db_path: &Path) -> bool {
    match Db::open(Some(db_path)).and_then(|db| relay_only_in(&db)) {
        Ok(on) => on,
        Err(e) => {
            // No path: it names the user's profile folder.
            eprintln!("mvs-core: can't read the relay-only setting ({:?}); starting relay-only", e.code);
            true
        }
    }
}
const KV_RECOVERY_CHALLENGE: &str = "recovery-challenge";
/// Restore servers (#291): my servers as the backup last saw them, server
/// ID (hex) to when this device first listed it. Not secret.
const KV_BACKUP_KNOWN: &str = "backup-known";
/// G-21: per channel, `read/<channel hex>` = the last message read, as
/// JSON `[ts, "<record id hex>"]`. Local only (phase 3 syncs it).
const KV_READ_PREFIX: &str = "read/";
/// #354: a profile change waits to be published (coalesced).
const KV_PROFILE_PENDING: &str = "profile-pending";
/// Profile save (#378): the post limit's next-allowed time (GCRA's
/// theoretical arrival time, u64le ms). Replaces `profile-posted-at`.
const KV_PROFILE_POST_TAT: &str = "profile-post-tat";
/// #359 follow-up: servers whose profile post was refused (JSON hex list).
const KV_PROFILE_RETRY: &str = "profile-retry";
/// Profile posts (Tech Lead, #378): a burst of [`PROFILE_POST_BURST`] at
/// once, so an explicit save goes out right away, then one per this long
/// (later changes coalesce: the latest values go).
pub const PROFILE_POST_EVERY_MS: u64 = 10 * 60_000;
pub const PROFILE_POST_BURST: u64 = 3;
/// Restore servers: a restore still has servers to rejoin from the backup.
const KV_BACKUP_PENDING: &str = "backup-pending";
/// Restore servers: a fingerprint of the server set last backed up, and
/// when it was last put (u64le ms).
const KV_BACKUP_WRITTEN: &str = "backup-written";
const KV_BACKUP_PUT_AT: &str = "backup-put-at";
/// G-91 phase B: my backup buddies (JSON [`Buddies`]) and when each
/// co-member was last seen online (JSON hex key -> ms).
const KV_BACKUP_BUDDIES: &str = "backup-buddies";
const KV_MEMBER_SEEN: &str = "member-seen";
/// G-91 phase B: how many co-members hold my backup (design §2), one per
/// owner group (Tech Lead).
pub const BACKUP_BUDDIES: usize = 3;
/// G-91 phase B: how often the buddies are checked (a gone one is
/// replaced at the check after it went).
pub const BUDDY_CHECK_MS: u64 = 10 * 60_000;
/// Restore servers: an unchanged backup is put again this often (design
/// §4), so holders keep it and copies heal.
pub const BACKUP_REPUBLISH_MS: u64 = 24 * 3_600_000;
/// Restore servers: a restore still waiting (no backup found yet, or
/// servers nobody could be reached for) is retried after 1 min, doubling
/// to at most 1 h (Tech Lead); back to 1 min once it's done.
pub const BACKUP_RETRY_FIRST_MS: u64 = 60_000;
pub const BACKUP_RETRY_MAX_MS: u64 = 60 * 60_000;
/// G-91: once the backup is found, the servers still waiting are tried
/// this often (no backup fetch), so each is back within 2 minutes of a
/// member of it being reachable (PO acceptance).
pub const REJOIN_EVERY_MS: u64 = 30_000;

pub struct Config {
    /// `None` keeps everything in memory (tests).
    pub db_path: Option<PathBuf>,
    pub app_version: String,
}

/// What is stored about me, sealed in the local database.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    display_name: String,
    bio: Option<String>,
    avatar_data_url: Option<String>,
    country: String,
    birth_date: String,
    /// The UI language at sign-up; names what this identity creates
    /// (#general). Older profiles and restored identities have none: English.
    #[serde(default)]
    locale: Option<Locale>,
    /// B7 §9 / B13 §3 (decision 18): a birth date that raises my age over an
    /// earlier "not adult" claim counts only from `effective_at`; until
    /// then I count as under 18. `None`: nothing pending.
    #[serde(default)]
    pending_birth_date: Option<PendingBirth>,
    /// #354: the small picture and colour other members see.
    #[serde(default)]
    avatar_small: Option<String>,
    #[serde(default)]
    color: Option<String>,
    /// The birth date is the one my claims were made from: set at sign-up
    /// here, agreeing with a claim a server already holds, or past its 30
    /// days. Turning 18 with a trusted date is just a birthday: no wait.
    /// False after a restore (the date was entered again) until one of
    /// those happens. Profiles saved before this field: trusted.
    #[serde(default = "trusted")]
    birth_date_trusted: bool,
}

fn trusted() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingBirth {
    date: String,
    effective_at: u64,
    /// G-77: a correction (`correctBirthDate`) that raises my age. My
    /// birth date stays the current one until `effective_at`, then becomes
    /// `date`. False: the restore form, where the birth date is already
    /// `date` and I count as at most 17 until then.
    #[serde(default)]
    correction: bool,
    /// G-77: a correction made while a restore-form raise was waiting: I
    /// still count as at most 17 until `effective_at`.
    #[serde(default)]
    capped: bool,
}

/// Decision 18: a raise of the age takes effect this long after it was found.
pub const AGE_RAISE_DELAY_MS: u64 = 30 * 86_400_000;

impl Profile {
    /// A raise is waiting at `now`.
    fn raise_pending(&self, now: u64) -> bool {
        self.pending_birth_date.as_ref().is_some_and(|p| now < p.effective_at)
    }

    /// My age as it counts at `now`: from the birth date, but at most 17
    /// while a restore-form raise is pending (the earlier "not adult" claim
    /// stands). A pending correction counts from the current date.
    fn effective_age(&self, now: u64) -> Option<u32> {
        let age = model::age_on(&self.birth_date, now)?;
        Some(if self.cap_waiting(now) { age.min(17) } else { age })
    }

    /// A restore's cap (at most 17) is still waiting at `now`: a restore-form
    /// pending, or a correction made over one.
    fn cap_waiting(&self, now: u64) -> bool {
        self.raise_pending(now) && self.pending_birth_date.as_ref().is_some_and(|p| !p.correction || p.capped)
    }

    /// G-77: applies a correction already judged as `kind` (never
    /// `too-young`). A raise waits until `effective_at` and keeps a waiting
    /// restore cap. Same or lower: the date at once, but a waiting restore
    /// cap stays until its own time, for the new date, so a lowering can't
    /// lift it (Tech Lead on #512); cancel can't remove it (restore form).
    fn correct(&mut self, kind: AgeCorrectionKind, date: &str, effective_at: u64, now: u64) {
        let cap = self.cap_waiting(now);
        if kind == AgeCorrectionKind::Raise {
            self.pending_birth_date =
                Some(PendingBirth { date: date.to_owned(), effective_at, correction: true, capped: cap });
            return;
        }
        let until = self.pending_birth_date.as_ref().map_or(0, |p| p.effective_at);
        self.birth_date = date.to_owned();
        self.pending_birth_date = cap.then(|| PendingBirth {
            date: date.to_owned(),
            effective_at: until,
            correction: false,
            capped: false,
        });
    }

    /// A pending raise whose 30 days are up takes effect: a correction's
    /// date becomes my birth date. True if it did.
    fn settle(&mut self, now: u64) -> bool {
        match self.pending_birth_date.take() {
            Some(p) if now >= p.effective_at => {
                if p.correction {
                    self.birth_date = p.date;
                }
                self.birth_date_trusted = true;
                true
            }
            other => {
                self.pending_birth_date = other;
                false
            }
        }
    }
}

/// Kept in the store so a restart neither resets the count nor offers new
/// positions (B19 §6). Positions are 1-based. Not secret: they say which
/// words to ask for, not the words.
#[derive(Serialize, Deserialize)]
struct Challenge {
    positions: Vec<usize>,
    failures: u8,
    burned: bool,
}

pub const CHALLENGE_POSITIONS: usize = 3;
pub const MAX_CHECK_FAILURES: u8 = 5;
/// How often the background sync runs without a hint.
pub const SYNC_EVERY: Duration = Duration::from_secs(2);
/// How long a message held for its channel key (the re-key a moderator
/// makes when they read the join) waits before it is marked `failed`.
pub const KEY_PENDING_FOR: Duration = Duration::from_secs(120);
/// How long messages wait for a join re-key (lost-message P1): while
/// current members can't read the channel's key (they just joined), a new
/// message is held until a re-key covers them, so it isn't sealed under a
/// key they never get. Counted per channel from when those members were
/// first seen missing; past it (no moderator online to re-key), messages go
/// out under the current key again, and the joiners can't read those.
pub const JOIN_KEY_WAIT: Duration = Duration::from_secs(20);
/// Provisional IDs of messages held for their key.
pub const KEY_PENDING_PREFIX: &str = "pending-";
/// Messages held for their key per channel at once; more get `not-allowed`.
pub const MAX_KEY_PENDING: usize = 50;
/// A join that found nobody online is retried in the background: first
/// after `JOIN_RETRY_FIRST`, doubling up to `JOIN_RETRY_MAX`, for at most
/// `JOIN_RETRY_FOR` (until then the inviter may still come online).
pub const JOIN_RETRY_FIRST: Duration = Duration::from_secs(2);
pub const JOIN_RETRY_MAX: Duration = Duration::from_secs(30);
pub const JOIN_RETRY_FOR: Duration = Duration::from_secs(10 * 60);
/// Server lifecycle: how long a closed server stays listed, read-only,
/// after its close was received (the Tech Lead's #229 answer).
pub const CLOSED_RETENTION_MS: u64 = 30 * 24 * 3600 * 1000;
/// The shortest wait the sync loop takes for a due join re-key.
pub const REKEY_WAKE_FLOOR: Duration = Duration::from_millis(250);

struct Me {
    /// Held only until the recovery check passes, so the UI can show and
    /// check the words; dropped (zeroized) after. TODO(#31): with the app
    /// lock, re-read from the vault after re-authentication instead.
    phrase: Option<RecoveryPhrase>,
    identity: identity::Identity,
    profile: Profile,
}

impl Me {
    fn key(&self) -> PublicKey {
        self.identity.public_key()
    }
}

/// Device link, the new device's side: the one-time key, until when, and
/// the approving device's key once its Hello came (one session).
struct NewLink {
    key: OneTimeKey,
    expires_at: u64,
    old_pub: Option<[u8; 32]>,
    /// My user said the digits match (`confirmDeviceLink(true)`). Nothing
    /// is applied before: a DHT server that saw the rendezvous could race
    /// the first Hello and send its own seed (Security Lead on #394).
    confirmed: bool,
    /// The opened account, held until `confirmed`.
    held: Option<devicelink::Payload>,
}

/// Device link, the approving device's side, per link: the one-time key
/// (the same for a retry, so the one session stays ours), the attempts, and
/// once a Hello was answered, the address, the new device's key and when
/// it ends.
struct Approval {
    key: OneTimeKey,
    attempts: u32,
    link: Option<(DeviceLinkAddr, [u8; 32])>,
    expires_at: u64,
}

struct Inner {
    db: Db,
    /// The core clock (G-26: the reaction fold skips records from the future).
    clock: Arc<dyn crate::ports::Clock>,
    vault: Vault<SharedSecrets>,
    me: Option<Me>,
    /// The OS keychain failed at startup (QA-20).
    keyring_unavailable: bool,
    /// Member relays: the value last announced (`memberRelay.changed` fires
    /// when it differs). `None` until first worked out.
    member_relay: Option<MemberRelay>,
    /// Slice 3a: the shell says the network is metered (`setMetered`). In
    /// memory only: the shell sets it at every start.
    metered: bool,
    /// Device link, the new device: my one link.
    device_link: Option<NewLink>,
    /// Device link, the approving device: by link (the QR's key or the
    /// code's rendezvous), with the one in progress.
    approvals: HashMap<[u8; 32], Approval>,
    approving: Option<[u8; 32]>,
    /// Loaded on first use per server, then kept current record by record.
    logs: HashMap<ServerId, Log>,
    /// Messages already announced to the UI, per server, with what was
    /// announced (edit time, deleted), so sync emits only what is new.
    announced: HashMap<ServerId, HashMap<RecordId, Announced>>,
    /// For my messages' send state (B6).
    net: Arc<dyn Network>,
    /// The online members last reported per server (M2).
    presence_seen: HashMap<ServerId, Reach>,
    /// G-91: when each co-member was last seen online (core clock), for
    /// picking backup buddies; persisted with each buddy check.
    member_seen: HashMap<PublicKey, u64>,
    /// Who each channel was last keyed for by our own rotation, so a
    /// moderator re-keys when members join (in memory: once after a restart).
    keyed_for: HashMap<(ServerId, ChannelId), BTreeSet<PublicKey>>,
    /// Join re-key tokens per server (GAP-8, `rekey`), and the servers
    /// whose joiners wait for the next token.
    join_buckets: HashMap<ServerId, JoinBucket>,
    join_waiting: BTreeSet<ServerId>,
    /// Voice calls: mine, and who is in which call.
    calls: voice::Calls,
    /// G-29: who is typing, what I sent, the replay cache. Never stored.
    typing: typing::Typing,
    /// Messages written before their channel key reached me (a member who
    /// just joined), oldest first: sent by the sync loop when it comes.
    /// In memory only (never the plain text on disk): lost on restart.
    key_pending: Vec<KeyPending>,
    /// Channels whose current key some members can't read, and since when
    /// (ms), for [`JOIN_KEY_WAIT`]. One entry per channel at most; dropped
    /// once nobody is missing.
    /// Who was missing then: a new joiner (someone not in that set) starts
    /// a wait of its own (dev-identity on #517).
    join_key_wait: HashMap<(ServerId, ChannelId), (BTreeSet<PublicKey>, u64)>,
    /// B7-k K2: servers whose `adult-keys-outdated` notice was sent; cleared
    /// once every member posts the cap, so it comes again if it reopens.
    adult_keys_warned: HashSet<ServerId>,
}

/// A message held for its channel key (`Core::send_message`).
struct KeyPending {
    /// Provisional, `pending-` + 16 random hex: never a record ID.
    id: String,
    server: ServerId,
    channel: ChannelId,
    author: PublicKey,
    body: Zeroizing<String>,
    created_at: u64,
    failed: bool,
}

impl KeyPending {
    fn message(&self, index: usize) -> Message {
        Message {
            id: self.id.clone(),
            channel_id: model::hex_id(self.channel.as_bytes()),
            index,
            author_id: model::hex_id(self.author.as_bytes()),
            body: self.body.as_str().to_owned(),
            created_at: self.created_at,
            edited_at: None,
            deleted: None,
            send_state: Some(if self.failed { SendState::Failed } else { SendState::Pending }),
            replaces: None,
            mentions: None,
            mentions_me: None,
            reactions: None,
        }
    }
}

pub struct Core {
    inner: Mutex<Inner>,
    ports: Ports,
    app_version: String,
    /// In-app update; `None` unless `--update-root` (see `with_updates`).
    updates: Option<Arc<Updates>>,
    /// Joins that found nobody online yet, by link: retried by `sync_now`.
    pending_joins: Mutex<HashMap<String, PendingJoin>>,
    /// Where `core.db` lives (`None` in memory): sign-out leaves its wipe
    /// marker beside it.
    db_path: Option<PathBuf>,
    /// Signed out: the shell restarts the core, which finishes the wipe.
    signed_out: AtomicBool,
    /// Restore servers: the first sync round after start backs up (login).
    backup_started: AtomicBool,
    /// Device link: the stored notices were announced since this start.
    notices_announced: AtomicBool,
    /// Restore servers: when the next retry of a pending restore is due and
    /// the wait after it (ms, core clock): 1 min doubling to 1 h, reset
    /// once the restore is done.
    backup_retry: Mutex<(u64, u64)>,
    /// G-91 phase B: when the buddies were last checked (core clock).
    buddies_checked: Mutex<Option<u64>>,
    /// G-91: the restore under way, once its backup is found.
    restore: Mutex<RestoreProgress>,
    /// The app lock is on (`lock_keys` until `unlock_keys`): a restore
    /// waits, holding no server secrets.
    keys_locked: AtomicBool,
    /// G-78: app-lock attempts run one at a time, so the counter can't be
    /// raced past its delay.
    app_lock_gate: Mutex<()>,
}

/// G-91: a restore's progress. The backup is fetched until found (with
/// backoff: a holder lookup is slow); after that only the servers still
/// waiting are tried, every [`REJOIN_EVERY_MS`], so each comes back soon
/// after a member of it is reachable (PO: within 2 minutes).
struct RestoreProgress {
    /// Live servers the backup lists (`None` until it's found).
    found: Option<u32>,
    /// Those not back yet: server → its sync secret.
    waiting: BTreeMap<ServerId, Zeroizing<[u8; 32]>>,
    /// What `getServerRestore` answers; announced when it changes.
    status: ServerRestore,
}

impl RestoreProgress {
    fn new(state: ServerRestoreState) -> RestoreProgress {
        RestoreProgress { found: None, waiting: BTreeMap::new(), status: ServerRestore { state, found: 0, waiting: 0 } }
    }
}

/// G-91 phase B: my backup buddies, as stored.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Buddies {
    /// When this set was picked (core clock, ms).
    picked_at: u64,
    list: Vec<Buddy>,
}

/// One buddy: its identity key and the owner group it was picked
/// through (both hex).
#[derive(Serialize, Deserialize)]
struct Buddy {
    member: String,
    owner: String,
}

struct PendingJoin {
    next: Instant,
    wait: Duration,
    until: Instant,
}

/// Events collected while the lock is held, emitted after it is released.
type Events = Vec<Event>;

fn vault_error(e: VaultError) -> CoreError {
    match e {
        // QA-20: the OS keychain failed (no Secret Service, locked, denied).
        VaultError::Store(_) => ErrorCode::KeyringUnavailable.into(),
        VaultError::AlreadyExists => ErrorCode::NotAllowed.into(),
        VaultError::NotFound => ErrorCode::NotFound.into(),
        VaultError::RecoveryCheckRequired => ErrorCode::RecoveryCheckRequired.into(),
        // TODO(app lock): commands to unlock and set a passphrase.
        VaultError::Locked | VaultError::WrongPassphrase => ErrorCode::NotAllowed.into(),
        _ => ErrorCode::Internal.into(),
    }
}

/// Beside `core.db`: present from a sign-out until its files are gone.
fn sign_out_marker(db_path: &Path) -> PathBuf {
    db_path.with_file_name("signed-out")
}

/// A sign-out's marker is still there after [`finish_sign_out`]: the
/// keychain couldn't be read, so its files weren't deleted. The network
/// must stay off (the old `node.key`).
pub fn sign_out_pending(db_path: &Path) -> bool {
    sign_out_marker(db_path).exists()
}

/// Sign-out, at the next start, before the database or the network opens.
/// The marker beside `db_path` is an intent; `secret_present` is what the
/// keychain says now (`None`: it can't be read).
/// - No marker: nothing to do.
/// - Marker, secret gone: the sign-out happened. Deletes `core.db` (and its
///   `-wal`/`-shm`) and `sync_dir`, then the marker, and returns true.
/// - Marker, secret still there: the sign-out never deleted it. The intent
///   is cleared and nothing else is touched.
/// - Marker, keychain unreadable: nothing is touched and the marker stays
///   for the next start.
///
/// An error leaves the marker, so the next start tries again; the caller
/// must not start the network on an error (the old `node.key` would link
/// the next identity here to the last one).
pub fn finish_sign_out(
    db_path: &Path,
    sync_dir: &Path,
    secret_present: Option<bool>,
) -> std::io::Result<bool> {
    let marker = sign_out_marker(db_path);
    if !marker.exists() {
        return Ok(false);
    }
    match secret_present {
        None => return Ok(false),
        Some(true) => {
            std::fs::remove_file(marker)?;
            return Ok(false);
        }
        Some(false) => {}
    }
    let gone = |r: std::io::Result<()>| match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    };
    gone(std::fs::remove_dir_all(sync_dir))?;
    for suffix in ["", "-wal", "-shm"] {
        let mut name = db_path.as_os_str().to_owned();
        name.push(suffix);
        gone(std::fs::remove_file(PathBuf::from(name)))?;
    }
    std::fs::remove_file(marker)?;
    Ok(true)
}

fn phrase_error(e: PhraseError) -> CoreError {
    let positions = e.positions().into_iter().map(|p| p + 1).collect();
    CoreError { code: ErrorCode::InvalidWords, positions: Some(positions), servers: None }
}

fn parse_user(id: &str) -> CoreResult<PublicKey> {
    model::parse_hex32(id).map(PublicKey::from_bytes).ok_or_else(|| ErrorCode::NotFound.into())
}

/// G-47: where the name known when `user` was blocked is kept. Local only:
/// never in the account backup (`backup_set` holds server secrets only) or
/// `exportDiagnostics` (counts only); `tests/blocked.rs` checks the export.
fn blocked_name_key(user: &PublicKey) -> String {
    format!("blocked-name/{}", model::hex_id(user.as_bytes()))
}

fn parse_server(id: &str) -> CoreResult<ServerId> {
    model::parse_hex32(id).map(ServerId::from_bytes).ok_or_else(|| ErrorCode::NotFound.into())
}

/// A rollout gate (#229, G-26): every current, non-kicked member but `me`
/// has `cap` in their latest profile post (none counts as needing an
/// update).
fn gate_open(view: &ServerView, me: PublicKey, cap: &str) -> bool {
    view.lacking(cap, me).is_empty()
}

impl Core {
    pub fn open(config: Config, ports: Ports) -> CoreResult<Core> {
        let db = Db::open(config.db_path.as_deref())?;
        let vault = Vault::new(SharedSecrets(ports.secrets.clone()));
        let mut inner = Inner {
            db,
            clock: ports.clock.clone(),
            vault,
            me: None,
            keyring_unavailable: false,
            member_relay: None,
            metered: false,
            device_link: None,
            approvals: HashMap::new(),
            approving: None,
            logs: HashMap::new(),
            announced: HashMap::new(),
            net: ports.network.clone(),
            presence_seen: HashMap::new(),
            member_seen: HashMap::new(),
            keyed_for: HashMap::new(),
            join_buckets: HashMap::new(),
            join_waiting: BTreeSet::new(),
            calls: voice::Calls::default(),
            typing: typing::Typing::default(),
            key_pending: Vec::new(),
            join_key_wait: HashMap::new(),
            adult_keys_warned: HashSet::new(),
        };
        // GAP-6r: the stored relay-only setting, applied before anything
        // else reaches the network.
        let relay_only = relay_only_in(&inner.db)?;
        inner.calls.set_relay_only(relay_only);
        ports.network.set_relay_only(relay_only);
        // QA-20: without a usable keychain the core still starts, and says so
        // (`keyring-unavailable`) instead of crashing or looking empty.
        let state = match inner.vault.state() {
            Ok(state) => Some(state),
            Err(VaultError::Store(e)) => {
                eprintln!("mvs-core: the OS keychain is unavailable: {}", e.0);
                inner.keyring_unavailable = true;
                None
            }
            Err(e) => return Err(vault_error(e)),
        };
        if state == Some(VaultState::Ready) {
            inner.open_stored(&ports)?;
        }
        // The first member relay value: later changes are announced.
        inner.check_member_relay(&ports, &mut Vec::new());
        // G-91: a restore that was still bringing servers back before a
        // restart searches again.
        let restore_state = if inner.db.get(KV_BACKUP_PENDING)?.is_some() {
            ServerRestoreState::Searching
        } else {
            ServerRestoreState::None
        };
        Ok(Core {
            inner: Mutex::new(inner),
            ports,
            app_version: config.app_version,
            updates: None,
            pending_joins: Mutex::default(),
            db_path: config.db_path,
            signed_out: AtomicBool::new(false),
            backup_started: AtomicBool::new(false),
            notices_announced: AtomicBool::new(false),
            backup_retry: Mutex::new((0, BACKUP_RETRY_FIRST_MS)),
            buddies_checked: Mutex::new(None),
            restore: Mutex::new(RestoreProgress::new(restore_state)),
            keys_locked: AtomicBool::new(false),
            app_lock_gate: Mutex::new(()),
        })
    }

    /// What the app lock and sign-out call: the group cipher drops our
    /// secret and every channel key, and we leave any call. TODO(app lock):
    /// the commands.
    pub fn lock_keys(&self) {
        let _ = self.leave_call();
        // Messages held for a key: their text is dropped (zeroized) at lock
        // and sign-out, never kept past them (lost-message P1, SL C3). Each
        // one still listed turns `failed` with no text (`message.updated`),
        // so the UI never shows it as about to be sent (dev-identity on
        // #517). Before the cipher locks: the index needs the count.
        let _ = self.run(|inner, ports, events| {
            let held = std::mem::take(&mut inner.key_pending);
            inner.join_key_wait.clear();
            let mut before: HashMap<ChannelId, usize> = HashMap::new();
            for mut p in held {
                let earlier = before.entry(p.channel).or_default();
                let index = inner.message_count(&*ports.cipher, p.server, p.channel).unwrap_or(0) + *earlier;
                *earlier += 1;
                p.failed = true;
                p.body = Zeroizing::new(String::new());
                events.push(Event::MessageUpdated(p.message(index)));
            }
            Ok(())
        });
        self.ports.cipher.lock();
        self.ports.network.lock();
        self.keys_locked.store(true, Ordering::SeqCst);
        // G-91 (Security Lead on #457): the server secrets a restore took
        // from the backup go too; the backup is fetched again after unlock.
        let mut restore = self.restore.lock().expect("not poisoned");
        restore.found = None;
        restore.waiting.clear();
        drop(restore);
        *self.backup_retry.lock().expect("not poisoned") = (0, BACKUP_RETRY_FIRST_MS);
    }

    /// `signOut({ words } | { withoutWords: true })`: removes this identity
    /// from this computer. The UI first makes sure the user has their
    /// words: `words` must be this identity's 12 words (`invalid-words` for
    /// unknown words, `not-allowed` for another identity's); `withoutWords`
    /// is the explicit "I accept losing this account" path.
    ///
    /// Fail safe, in this order:
    /// 1. the keychain secret is deleted; if that fails nothing changed
    ///    (`keyring-unavailable`) and the identity still opens;
    /// 2. once it's gone, the local database is emptied and a wipe marker
    ///    is written beside it; the next start deletes `core.db` and the
    ///    sync folder (its `node.key` too, so a new identity here gets a
    ///    new peer ID) before opening anything ([`finish_sign_out`]);
    /// 3. the core then exits, and the shell restarts it at "create or
    ///    restore".
    ///
    /// With the secret gone the identity can't come back on its own; a
    /// later failure only leaves data nobody can open, and the marker
    /// retries its deletion at every start.
    pub fn sign_out(&self, words: Option<Vec<String>>, without_words: bool) -> CoreResult<()> {
        {
            let inner = self.lock();
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
            match words {
                Some(words) => {
                    let phrase =
                        RecoveryPhrase::parse(&words.join(" ")).map_err(phrase_error)?;
                    if phrase.identity().public_key() != me.key() {
                        return Err(ErrorCode::NotAllowed.into());
                    }
                }
                None if without_words => {}
                None => return Err(ErrorCode::BadRequest.into()),
            }
        }
        let _ = self.leave_call();
        self.pending_joins.lock().expect("not poisoned").clear();
        let mut inner = self.lock();
        // 1. The intent: the marker, before anything is deleted. Without it
        //    a crash could leave the files of a gone identity. It can't be
        //    written: nothing changed.
        let marker = self.db_path.as_deref().map(sign_out_marker);
        if let Some(marker) = &marker {
            if let Err(e) = std::fs::write(marker, b"") {
                eprintln!("mvs-core: the sign-out marker wasn't written: {}", e.kind());
                return Err(ErrorCode::Internal.into());
            }
        }
        // 2. The keychain: the identity is gone once its secret is. If that
        //    fails, the intent is withdrawn and nothing changed. (A marker
        //    that can't be removed is cleared at the next start, since the
        //    secret is still there: `finish_sign_out`.)
        match inner.vault.forget() {
            Ok(true) => {}
            Ok(false) => eprintln!("mvs-core: signed out; the recovery-check marker stays"),
            Err(e) => {
                if let Some(marker) = &marker {
                    let _ = std::fs::remove_file(marker);
                }
                return Err(vault_error(e));
            }
        }
        // 3. Nothing below may stop the sign-out: the identity is gone.
        self.ports.cipher.lock();
        self.ports.network.lock();
        if let Ok(servers) = inner.db.servers() {
            for server in servers {
                self.ports.network.close_server(server);
            }
        }
        if let Err(e) = inner.db.wipe() {
            eprintln!("mvs-core: the database wasn't emptied: {:?}", e.code);
        }
        inner.me = None;
        inner.logs.clear();
        inner.calls = voice::Calls::default();
        inner.key_pending.clear();
        inner.join_key_wait.clear();
        self.signed_out.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Signed out: the request loop answers this request, then stops, and
    /// the shell restarts the core.
    pub fn signed_out(&self) -> bool {
        self.signed_out.load(Ordering::SeqCst)
    }

    /// After the app lock: the cipher gets our secret back. The next read or
    /// send replays what it lost (see `unlock_cipher`).
    pub fn unlock_keys(&self) {
        self.keys_locked.store(false, Ordering::SeqCst);
        unlock_cipher(&self.ports, self.lock().me.as_ref());
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("a panic inside the core poisoned its lock")
    }

    fn emit(&self, events: Events) {
        for event in &events {
            self.ports.events.emit(event);
        }
    }

    /// Runs `f` under the lock, then emits what it collected.
    fn run<T>(
        &self,
        f: impl FnOnce(&mut Inner, &Ports, &mut Events) -> CoreResult<T>,
    ) -> CoreResult<T> {
        let mut events = Vec::new();
        let result = {
            let mut inner = self.lock();
            let result = f(&mut inner, &self.ports, &mut events);
            // Member relays: anything the command changed is announced.
            inner.check_member_relay(&self.ports, &mut events);
            result
        };
        self.emit(events);
        result
    }

    // ---- identity -------------------------------------------------------

    pub fn get_identity(&self) -> CoreResult<Option<Identity>> {
        let mut inner = self.lock();
        inner.recheck_keyring(&self.ports)?;
        inner.me.as_ref().map(|me| inner.identity_json(me)).transpose()
    }

    pub fn create_identity(&self, input: NewIdentityInput) -> CoreResult<CreatedIdentity> {
        self.run(|inner, ports, events| {
            inner.recheck_keyring(ports)?;
            if inner.me.is_some() {
                return Err(ErrorCode::NotAllowed.into());
            }
            let progress = |step, percent| Event::IdentityProgress { step, percent };
            events.push(progress(ProgressStep::Keys, 25));
            let phrase = inner.vault.create().map_err(vault_error)?;
            events.push(progress(ProgressStep::Storage, 55));
            let profile = Profile {
                country: input.country,
                birth_date: input.birth_date,
                locale: Some(input.locale),
                // Entered at sign-up here: my claims come from it.
                birth_date_trusted: true,
                ..Profile::default()
            };
            let me = inner.new_me(phrase, profile)?;
            events.push(progress(ProgressStep::Encryption, 85));
            let phrase = me.phrase.as_ref().ok_or(ErrorCode::Internal)?;
            let words = phrase.words().iter().map(|w| (*w).to_owned()).collect();
            let identity = inner.identity_json(&me)?;
            inner.me = Some(me);
            unlock_cipher(ports, inner.me.as_ref());
            events.push(progress(ProgressStep::Done, 100));
            Ok(CreatedIdentity { identity, words })
        })
    }

    /// The current word check (B19 §6): [`CHALLENGE_POSITIONS`] 1-based
    /// positions, the same until passed or burned. `too-many-attempts`
    /// while burned; `not-allowed` once the check has passed.
    pub fn get_recovery_challenge(&self) -> CoreResult<RecoveryChallenge> {
        let inner = self.lock();
        let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
        // Already passed: the phrase is gone (see `Me::phrase`).
        me.phrase.as_ref().ok_or(ErrorCode::NotAllowed)?;
        let challenge = match inner.challenge()? {
            Some(c) if c.burned => return Err(ErrorCode::TooManyAttempts.into()),
            Some(c) => c,
            None => {
                let positions = identity::check_positions(CHALLENGE_POSITIONS)
                    .into_iter()
                    .map(|p| p + 1)
                    .collect();
                let fresh = Challenge { positions, failures: 0, burned: false };
                inner.save_challenge(&fresh)?;
                fresh
            }
        };
        Ok(RecoveryChallenge { positions: challenge.positions })
    }

    /// Answers for exactly the current challenge's positions (1-based),
    /// else `not-allowed`. The [`MAX_CHECK_FAILURES`]th failure burns the
    /// challenge and itself rejects with `too-many-attempts`.
    pub fn check_recovery_words(
        &self,
        answers: BTreeMap<usize, String>,
    ) -> CoreResult<RecoveryCheckResult> {
        self.run(|inner, _, events| {
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
            let phrase = me.phrase.as_ref().ok_or(ErrorCode::NotAllowed)?;
            let mut challenge = inner.challenge()?.ok_or(ErrorCode::NotAllowed)?;
            if challenge.burned {
                return Err(ErrorCode::TooManyAttempts.into());
            }
            if !answers.keys().copied().eq(challenge.positions.iter().copied()) {
                return Err(ErrorCode::NotAllowed.into());
            }
            let wrong: Vec<usize> = answers
                .iter()
                .filter(|(p, w)| !phrase.check_words(&[(*p - 1, w.as_str())]))
                .map(|(p, _)| *p)
                .collect();
            if wrong.is_empty() {
                let answers: Vec<(usize, &str)> =
                    answers.iter().map(|(p, w)| (p - 1, w.as_str())).collect();
                if !inner.vault.confirm_recovery_check(phrase, &answers).map_err(vault_error)? {
                    return Err(ErrorCode::Internal.into());
                }
                inner.db.delete(KV_RECOVERY_CHALLENGE)?;
                inner.me.as_mut().expect("checked above").phrase = None;
                let me = inner.me.as_ref().expect("checked above");
                events.push(Event::IdentityChanged(inner.identity_json(me)?));
                return Ok(RecoveryCheckResult::passed());
            }
            challenge.failures += 1;
            challenge.burned = challenge.failures >= MAX_CHECK_FAILURES;
            inner.save_challenge(&challenge)?;
            if challenge.burned {
                return Err(ErrorCode::TooManyAttempts.into());
            }
            Ok(RecoveryCheckResult::wrong(wrong))
        })
    }

    /// Only before the recovery check passes: one XSS in the UI must not be
    /// able to read the words any time later. Success lifts a burned
    /// challenge (the next one has new positions and a fresh count).
    /// TODO(app lock, #31): OS authentication first (`auth-cancelled`),
    /// and the words again after the check, behind it.
    pub fn get_recovery_words(&self) -> CoreResult<Vec<String>> {
        let inner = self.lock();
        let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let phrase = me.phrase.as_ref().ok_or(ErrorCode::NotAllowed)?;
        if inner.challenge()?.is_some_and(|c| c.burned) {
            inner.db.delete(KV_RECOVERY_CHALLENGE)?;
        }
        Ok(phrase.words().iter().map(|w| (*w).to_owned()).collect())
    }

    pub fn restore_identity(&self, words: Vec<String>) -> CoreResult<Identity> {
        self.restore_identity_with(words, None)
    }

    /// `restoreIdentity(words, input?)`: the words don't carry the country
    /// or birth date (spec, age §), so the UI asks them again before the
    /// words and passes them here, as `createIdentity` takes them. Without
    /// `input` this device has neither, and a rejoin keeps what my servers
    /// already hold (no age claim from no date).
    pub fn restore_identity_with(
        &self,
        words: Vec<String>,
        input: Option<NewIdentityInput>,
    ) -> CoreResult<Identity> {
        // TODO(backup): the spec restores these from the encrypted identity
        // backup (docs/design, restore servers); until then the UI asks
        // again. The name comes after, from `updateProfile`.
        let profile = match input {
            Some(input) => Profile {
                country: input.country,
                birth_date: input.birth_date,
                locale: Some(input.locale),
                ..Profile::default()
            },
            None => Profile::default(),
        };
        self.restore_with_profile(&words.join(" "), profile)
    }

    /// The restore path: the words into the keychain, `profile` sealed, then
    /// my servers back from my backup (#291). Device link comes here too,
    /// with the profile the approving device sent.
    fn restore_with_profile(&self, words: &str, profile: Profile) -> CoreResult<Identity> {
        let identity = self.run(|inner, ports, _| {
            inner.recheck_keyring(ports)?;
            if inner.me.is_some() {
                return Err(ErrorCode::NotAllowed.into());
            }
            let phrase = RecoveryPhrase::parse(words).map_err(phrase_error)?;
            inner.vault.restore(&phrase).map_err(vault_error)?;
            inner.db.delete(KV_RECOVERY_CHALLENGE)?;
            let me = inner.new_me(phrase, profile)?;
            let identity = inner.identity_json(&me)?;
            inner.me = Some(me);
            unlock_cipher(ports, inner.me.as_ref());
            Ok(identity)
        })?;
        // Restore servers (#291 phase A): my backup on the network brings
        // my servers back, rejoined as the same member (the #290 path).
        self.lock().db.set(KV_BACKUP_PENDING, b"1")?;
        *self.restore.lock().expect("not poisoned") = RestoreProgress::new(ServerRestoreState::None);
        self.set_restore_status(ServerRestoreState::Searching);
        let done = self.restore_from_backup();
        self.schedule_backup_retry(done);
        Ok(identity)
    }

    /// G-91: `getServerRestore`.
    pub fn get_server_restore(&self) -> ServerRestore {
        self.restore.lock().expect("not poisoned").status
    }

    /// Sets the restore's state (counts from the progress) and announces
    /// `serverRestore.changed` if anything changed.
    fn set_restore_status(&self, state: ServerRestoreState) {
        let changed = {
            let mut progress = self.restore.lock().expect("not poisoned");
            let status = ServerRestore {
                state,
                found: progress.found.unwrap_or(0),
                waiting: progress.waiting.len() as u32,
            };
            let changed = progress.status != status;
            progress.status = status;
            changed.then_some(status)
        };
        if let Some(status) = changed {
            self.emit(vec![Event::ServerRestoreChanged(status)]);
        }
    }

    /// Restore servers (#291 phase A): fetches my backup from the holders,
    /// keeps the newest valid one, and rejoins each live server I don't have
    /// yet as the same member (`Inner::join`: no new join, nothing posted
    /// over what the server holds). A server it lists that no longer has
    /// me as a member isn't entered (a stale backup can't undo a leave or a
    /// kick). Servers nobody can be reached for are tried again (G-91: every
    /// [`REJOIN_EVERY_MS`], without fetching the backup again) until all
    /// are in. Returns whether the restore is done.
    fn restore_from_backup(&self) -> bool {
        let Some(keys) = self.lock().me.as_ref().map(|me| me.identity.backup_keys()) else {
            return true;
        };
        if self.restore.lock().expect("not poisoned").found.is_none() {
            let answers = self.ports.network.fetch_backup(keys.tag());
            // No backup found (yet): try again later.
            let Some(plain) = backup::newest(&keys, &answers) else {
                self.set_restore_status(ServerRestoreState::Searching);
                return false;
            };
            let live: Vec<(ServerId, Zeroizing<[u8; 32]>)> = plain
                .servers
                .iter()
                .filter(|(_, e)| e.live())
                .filter_map(|(id, entry)| {
                    Some((
                        model::parse_hex32(id).map(ServerId::from_bytes)?,
                        model::parse_hex32(&entry.secret).map(Zeroizing::new)?,
                    ))
                })
                .collect();
            let mut progress = self.restore.lock().expect("not poisoned");
            progress.found = Some(live.len() as u32);
            progress.waiting = live.into_iter().collect();
        }
        let tries: Vec<(ServerId, Zeroizing<[u8; 32]>)> = {
            let progress = self.restore.lock().expect("not poisoned");
            progress.waiting.iter().map(|(server, secret)| (*server, secret.clone())).collect()
        };
        for (server, secret) in tries {
            if self.lock().db.has_server(server).unwrap_or(true) {
                self.restore.lock().expect("not poisoned").waiting.remove(&server);
                continue;
            }
            let fetched = self.open_and_fetch(server, &secret);
            // "Invalid" is final only with evidence in the log (Security Lead
            // on #457): a partial log could otherwise drop a server I'm in.
            let me = self.lock().me.as_ref().map(Me::key);
            let judged = me.is_some_and(|me| removal_shown(server, me, &fetched));
            let status = self.run(|inner, ports, events| {
                // No invite: a member I still am needs none; anyone else is
                // refused by authority and nothing is stored or sent.
                let none = RecordId::from_bytes([0; 32]);
                inner.join(ports, server, none, &secret, "", fetched, events)
            });
            if restore_settles(&status, judged) {
                self.restore.lock().expect("not poisoned").waiting.remove(&server);
                if !matches!(status, Ok(JoinStatus::Joined { .. })) {
                    let _ = self.close_candidate(server);
                }
            }
        }
        let done = self.restore.lock().expect("not poisoned").waiting.is_empty();
        if done {
            let _ = self.lock().db.delete(KV_BACKUP_PENDING);
        }
        self.set_restore_status(if done { ServerRestoreState::Done } else { ServerRestoreState::Waiting });
        done
    }

    /// After a restore attempt that isn't done: while the backup isn't
    /// found, the next fetch after the current wait, and the wait after
    /// that doubled, at most [`BACKUP_RETRY_MAX_MS`]; once it's found, the
    /// waiting servers again after [`REJOIN_EVERY_MS`]. `done`: back to
    /// [`BACKUP_RETRY_FIRST_MS`].
    fn schedule_backup_retry(&self, done: bool) {
        let now = self.ports.clock.now_ms();
        let found = self.restore.lock().expect("not poisoned").found.is_some();
        let mut retry = self.backup_retry.lock().expect("not poisoned");
        *retry = if done {
            (0, BACKUP_RETRY_FIRST_MS)
        } else if found {
            (now + REJOIN_EVERY_MS, retry.1)
        } else {
            (now + retry.1, (retry.1 * 2).min(BACKUP_RETRY_MAX_MS))
        };
    }

    /// Each sync round: a pending restore is tried again only when its
    /// wait is up (dev-sync on #339: a real holder lookup is slow; G-91:
    /// found servers every [`REJOIN_EVERY_MS`]).
    fn retry_backup_restore(&self) {
        if self.keys_locked.load(Ordering::SeqCst) {
            return;
        }
        if self.lock().db.get(KV_BACKUP_PENDING).ok().flatten().is_none() {
            return;
        }
        let due = self.backup_retry.lock().expect("not poisoned").0 <= self.ports.clock.now_ms();
        if due {
            let done = self.restore_from_backup();
            self.schedule_backup_retry(done);
        }
    }

    /// One backup round (Tech Lead on #317): decide under the lock, fetch
    /// outside it, merge and seal under it, put outside it. Nothing at all
    /// happens on a round with nothing due (`Inner::backup_due`).
    fn backup_round(&self) {
        let now = self.ports.clock.now_ms();
        let login = !self.backup_started.load(Ordering::SeqCst);
        // G-91 phase B: the buddies, checked every BUDDY_CHECK_MS; a new set
        // makes this round write.
        {
            let mut checked = self.buddies_checked.lock().expect("not poisoned");
            if checked.is_none_or(|at| now.saturating_sub(at) >= BUDDY_CHECK_MS) {
                let mut inner = self.lock();
                if inner.me.is_some() {
                    if let Err(e) = inner.buddy_check(now) {
                        eprintln!("mvs-core: the backup buddies weren't checked: {:?}", e.code);
                    }
                    *checked = Some(now);
                }
            }
        }
        let tag = {
            let inner = self.lock();
            match inner.backup_due(now, login) {
                Ok(true) => inner.me.as_ref().map(|me| me.identity.backup_keys().tag()),
                Ok(false) => None,
                Err(e) => {
                    eprintln!("mvs-core: the server backup wasn't checked: {:?}", e.code);
                    None
                }
            }
        };
        let Some(tag) = tag else {
            if login && self.lock().me.is_some() {
                self.backup_started.store(true, Ordering::SeqCst);
            }
            return;
        };
        let answers = self.ports.network.fetch_backup(tag);
        let blob = self.lock().backup_merge(now, &answers);
        match blob {
            Ok(Some(blob)) => {
                self.ports.network.put_backup(tag, &blob);
                // G-91 phase B: and to my buddies (the network re-checks each
                // is a bound current co-member at send time).
                let buddies: Vec<PublicKey> = match self.lock().buddies() {
                    Ok(b) => b.list.iter().filter_map(|b| model::parse_hex32(&b.member)).map(PublicKey::from_bytes).collect(),
                    Err(_) => Vec::new(),
                };
                if !buddies.is_empty() {
                    self.ports.network.put_backup_to(tag, &blob, &buddies);
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("mvs-core: the server backup wasn't written: {:?}", e.code),
        }
        self.backup_started.store(true, Ordering::SeqCst);
    }

    pub fn update_profile(&self, input: ProfileInput) -> CoreResult<Identity> {
        self.run(|inner, ports, events| {
            model::check_profile(&input)?;
            // #354: the picture and colour other members see. Absent:
            // unchanged; "": cleared (published as "", so it clears for
            // everyone); otherwise checked strictly.
            let ok = |v: &Option<String>, valid: fn(&str) -> bool| {
                v.as_deref().is_none_or(|s| s.is_empty() || valid(s))
            };
            if !ok(&input.avatar_small, avatar::valid_avatar) || !ok(&input.color, avatar::valid_color) {
                return Err(ErrorCode::BadRequest.into());
            }
            let me = inner.me.as_mut().ok_or(ErrorCode::NotFound)?;
            let name = input.display_name.trim().to_owned();
            let small = input.avatar_small.or_else(|| me.profile.avatar_small.clone());
            let color = input.color.or_else(|| me.profile.color.clone());
            // The whole post must fit a control Post (Tech Lead).
            let authority::Action::Post { text } =
                model::profile_action_with(&name, small.as_deref(), color.as_deref())
            else {
                unreachable!("a profile is a post")
            };
            if text.len() > records::Kind::Post.max_body() {
                return Err(ErrorCode::BadRequest.into());
            }
            let changed =
                me.profile.display_name != name || me.profile.avatar_small != small || me.profile.color != color;
            me.profile.display_name = name;
            me.profile.bio = input.bio;
            me.profile.avatar_data_url = input.avatar_data_url;
            me.profile.avatar_small = small;
            me.profile.color = color;
            let profile = me.profile.clone();
            let key = *me.identity.storage_key().expose_secret();
            inner.db.save_profile(&key, &serde_json::to_vec(&profile).expect("plain struct"))?;
            // A change goes to every server I'm still in, as a new profile
            // post (the latest wins): at once while the burst lasts, then once
            // per PROFILE_POST_EVERY_MS (coalesced; the pending one survives a
            // restart). The bio and the large picture stay on this device.
            if changed {
                inner.db.set(KV_PROFILE_PENDING, b"1")?;
                inner.flush_profile(ports)?;
                // Profile save (#378, acceptance 7): my row in every server
                // I'm a member of, so each place that shows me updates now.
                // The profile is saved already: a server that fails here is
                // logged, not an error.
                let key = inner.me.as_ref().expect("checked above").key();
                for server in inner.db.servers()? {
                    let row = (|| -> CoreResult<Option<Event>> {
                        if inner.db.closed_at(server)?.is_some() {
                            return Ok(None);
                        }
                        inner.load(server)?;
                        let view = inner.view(server)?;
                        if view.state.closed.is_some() || !view.state.is_member(key) {
                            return Ok(None);
                        }
                        Ok(Some(Event::MembersChanged {
                            server_id: model::hex_id(server.as_bytes()),
                            members: inner.members_json(&view)?,
                        }))
                    })();
                    match row {
                        Ok(event) => events.extend(event),
                        Err(e) => eprintln!("mvs-core: members.changed after a profile save: {:?}", e.code),
                    }
                }
            }
            let identity = inner.identity_json(inner.me.as_ref().expect("checked above"))?;
            events.push(Event::IdentityChanged(identity.clone()));
            Ok(identity)
        })
    }

    // ---- servers ----------------------------------------------------------

    pub fn list_servers(&self) -> CoreResult<Vec<ServerSummary>> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        for id in inner.db.servers()? {
            inner.load(id)?;
            // G-21 and G-24: the server rail's unread dot and mention badge.
            let summary = inner.counted_summary(&*self.ports.cipher, id)?;
            out.push(summary);
        }
        Ok(out)
    }

    pub fn list_channels(&self, server_id: &str) -> CoreResult<Vec<Channel>> {
        let mut inner = self.lock();
        let server = inner.load_mine(parse_server(server_id)?)?;
        let me = inner.me.as_ref().map(Me::key);
        let mut list = inner.view(server)?.channels(me);
        inner.fill_unread(&*self.ports.cipher, server, &mut list)?;
        Ok(list)
    }

    pub fn list_members(&self, server_id: &str) -> CoreResult<Vec<Member>> {
        let mut inner = self.lock();
        let server = inner.load_mine(parse_server(server_id)?)?;
        inner.members_json(&inner.view(server)?)
    }

    pub fn create_server(
        &self,
        name: &str,
        age_restriction: AgeRestriction,
    ) -> CoreResult<ServerSummary> {
        self.run(|inner, ports, events| {
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
            inner.vault.require_recovery_check(&me.identity).map_err(vault_error)?;
            let name = name.trim();
            if name.is_empty()
                || name.chars().count() > model::MAX_NAME_CHARS
                || !authority::display_text_ok(name)
            {
                return Err(ErrorCode::BadRequest.into());
            }
            let mut nonce = [0u8; records::GENESIS_NONCE_LEN];
            OsRng.fill_bytes(&mut nonce);
            let body = GenesisBody { v: 1, name: name.to_owned(), age_restriction };
            // The genesis and #general (UX-04). #general keeps the derived ID,
            // so peers and sync agree on its log without reading the record.
            let server = ServerId::derive(&me.key(), &nonce);
            let [genesis, general] = authority::sign_new_server(
                me.identity.signing_key(),
                nonce,
                ports.clock.now_ms(),
                &serde_json::to_vec(&body).expect("plain struct"),
                model::default_channel(server),
                model::general_name(me.profile.locale),
            )
            .map_err(|_| ErrorCode::BadRequest)?;
            debug_assert_eq!(genesis.server(), server);
            // The owner is a member from the genesis: the first invite (for
            // the link) and the profile post follow.

            let sign = |seq, deps, action: &Action| {
                authority::sign_control(
                    me.identity.signing_key(),
                    server,
                    seq,
                    deps,
                    ports.clock.now_ms(),
                    action,
                )
                .map_err(|_| CoreError::from(ErrorCode::BadRequest))
            };
            let invite = sign(2, vec![general.id()], &model::FIRST_INVITE)?;
            let profile =
                sign(3, vec![invite.id()], &model::profile_action_with(&me.profile.display_name, me.profile.avatar_small.as_deref(), me.profile.color.as_deref()))?;
            inner.logs.insert(server, Log::new(server, []));
            // GAP-4: a fresh sync secret, sealed, and sync opened with it
            // before anything is published.
            let mut secret = Zeroizing::new([0u8; 32]);
            OsRng.fill_bytes(secret.as_mut());
            inner.save_secret(server, &secret)?;
            ports.network.open_server(server, &secret, &inner.known(server)?);
            for record in [genesis, general, invite, profile] {
                ports.network.publish(&record);
                inner.store(server, record)?;
            }
            if let Some(claim) = inner.age_claim(ports, server)? {
                ports.network.publish(&claim);
                inner.store(server, claim)?;
            }
            inner.db.add_server(server, ports.clock.now_ms())?;
            let summary = inner.summary(server)?;
            events.push(Event::ServerAdded(summary.clone()));
            Ok(summary)
        })
    }

    /// Resolves with the first status; the outcome follows as `join.status`.
    pub fn join_server(&self, link: &str) -> CoreResult<JoinStatus> {
        let link = link.trim().to_owned();
        if crate::invite_link::parse(&link).is_err() {
            return Ok(JoinStatus::Invalid { link });
        }
        let searching = JoinStatus::Searching { link: link.clone() };
        self.ports.events.emit(&Event::JoinStatus(searching.clone()));
        let short = matches!(crate::invite_link::parse(&link), Ok(crate::invite_link::InviteLink::V1 { .. }));
        tracing::info!(target: "mvs::join", short_link = short, "join: started");
        self.log_links("join: links at start");
        let status = self.try_join(&link)?;
        tracing::info!(target: "mvs::join", outcome = join_status_name(&status), "join: first attempt done");
        if matches!(status, JoinStatus::NobodyOnline { .. }) {
            // The inviter may not be reachable yet: keep trying (`retry_joins`).
            let now = Instant::now();
            let retry = PendingJoin {
                next: now + JOIN_RETRY_FIRST,
                wait: JOIN_RETRY_FIRST,
                until: now + JOIN_RETRY_FOR,
            };
            self.pending_joins.lock().expect("not poisoned").insert(link, retry);
        }
        self.ports.events.emit(&Event::JoinStatus(status));
        Ok(searching)
    }

    /// One attempt, for either link format (`crate::invite_link`).
    fn try_join(&self, link: &str) -> CoreResult<JoinStatus> {
        use crate::invite_link::InviteLink;
        match crate::invite_link::parse(link) {
            Ok(InviteLink::V0 { server, invite, secret }) => {
                // A server closed while we were in it: never opened again.
                if self.lock().db.closed_at(server)?.is_some() {
                    return Ok(JoinStatus::Closed { link: link.to_owned() });
                }
                let fetched = self.open_and_fetch(server, &secret);
                tracing::info!(target: "mvs::join", records = fetched.len(), "join: fetched the server's control log");
                self.run(|inner, ports, events| {
                    inner.join(ports, server, invite, &secret, link, fetched, events)
                })
            }
            Ok(InviteLink::V1 { key, server_prefix }) => self.try_join_short(link, &key, &server_prefix),
            Err(_) => Ok(JoinStatus::Invalid { link: link.to_owned() }),
        }
    }

    /// Opens `server` with its secret and fetches what reachable peers hold.
    fn open_and_fetch(&self, server: ServerId, secret: &[u8; 32]) -> Vec<Record> {
        // GAP-4: only the secret lets us ask for the server's logs.
        let general = BTreeSet::from([model::default_channel(server)]);
        self.ports.network.open_server(server, secret, &general);
        // Fetch without the lock, so UI commands don't wait on the network.
        self.ports.network.fetch(server).into_iter().filter(|r| r.server() == server).collect()
    }

    /// T8-02: a short link carries only k and a server-ID prefix. Ask peers
    /// for the envelope under `h`, and try each answer (C3, untrusted):
    /// it must be named `h`, open under k for this prefix, name its own
    /// invite (`names`), and, once the server's control log is in, be
    /// signed by that invite's author (C1). The genesis check against the
    /// full server ID is the join's own. The first answer that joins wins;
    /// a bad one only moves on to the next.
    fn try_join_short(&self, link: &str, key: &[u8; 16], prefix: &[u8; 16]) -> CoreResult<JoinStatus> {
        use crate::crypto::invite::{handle, open, InvitePublication};
        let h = handle(key);
        let mut status = JoinStatus::NobodyOnline { link: link.to_owned() };
        let answers = self.ports.network.fetch_invite(h);
        tracing::info!(target: "mvs::join", answers = answers.len(), "join: asked peers for the invite");
        for answer in answers {
            let Some(publication) = InvitePublication::decode(&answer) else {
                tracing::info!(target: "mvs::join", "join: an answer didn't decode");
                continue;
            };
            if *publication.handle() != h {
                tracing::info!(target: "mvs::join", "join: an answer named another invite");
                continue;
            }
            let Some(opened) = open(key, prefix, publication.envelope()) else {
                tracing::info!(target: "mvs::join", "join: an answer didn't open with this link");
                continue;
            };
            if !publication.names(key, &opened) {
                tracing::info!(target: "mvs::join", "join: an answer didn't name its invite");
                continue;
            }
            let server = opened.server;
            // A server closed while we were in it: never opened again.
            if self.lock().db.closed_at(server)?.is_some() {
                return Ok(JoinStatus::Closed { link: link.to_owned() });
            }
            let fetched = self.open_and_fetch(server, &opened.secret);
            tracing::info!(target: "mvs::join", records = fetched.len(), "join: fetched the server's control log");
            let author = ServerView::build(server, &Log::new(server, fetched.clone()))
                .and_then(|view| view.state.invites.get(&opened.invite).map(|invite| invite.author));
            if !fetched.is_empty() && !author.is_some_and(|author| publication.verify(&author)) {
                tracing::info!(target: "mvs::join", invite_known = author.is_some(), "join: the answer's signature didn't check");
            }
            let joined = if fetched.is_empty() {
                JoinStatus::NobodyOnline { link: link.to_owned() }
            } else if !author.is_some_and(|author| publication.verify(&author)) {
                JoinStatus::Invalid { link: link.to_owned() }
            } else {
                self.run(|inner, ports, events| {
                    inner.join(ports, server, opened.invite, &opened.secret, link, fetched, events)
                })?
            };
            match joined {
                JoinStatus::Invalid { .. } | JoinStatus::NobodyOnline { .. } => {
                    // Opened for this answer only (tech lead): don't leave a
                    // candidate a bad answer named subscribed. A real one is
                    // opened again by the next attempt.
                    self.close_candidate(server)?;
                    if !matches!(status, JoinStatus::Invalid { .. }) {
                        status = joined;
                    }
                }
                _ => return Ok(joined),
            }
        }
        Ok(status)
    }

    /// Closes a server opened only to try a join, unless I'm in it.
    fn close_candidate(&self, server: ServerId) -> CoreResult<()> {
        if !self.lock().db.has_server(server)? {
            self.ports.network.close_server(server);
        }
        Ok(())
    }

    /// Joins that found nobody online, tried again with backoff until they
    /// get an answer, are cancelled, or `JOIN_RETRY_FOR` runs out. "Nobody
    /// online" again isn't re-announced: the UI still shows the first one.
    fn retry_joins(&self) {
        let now = Instant::now();
        let due: Vec<String> = {
            let mut pending = self.pending_joins.lock().expect("not poisoned");
            pending.retain(|_, p| now < p.until);
            pending.iter().filter(|(_, p)| now >= p.next).map(|(link, _)| link.clone()).collect()
        };
        for link in due {
            self.log_links("join: retrying");
            let status = match self.try_join(&link) {
                Ok(status) => status,
                Err(e) => {
                    eprintln!("mvs-core: retrying a join failed: {:?}", e.code);
                    continue;
                }
            };
            tracing::info!(target: "mvs::join", outcome = join_status_name(&status), "join: retry done");
            let mut pending = self.pending_joins.lock().expect("not poisoned");
            if matches!(status, JoinStatus::NobodyOnline { .. }) {
                if let Some(p) = pending.get_mut(&link) {
                    p.wait = (p.wait * 2).min(JOIN_RETRY_MAX);
                    p.next = Instant::now() + p.wait;
                }
                continue;
            }
            // Cancelled meanwhile: say nothing.
            if pending.remove(&link).is_some() {
                drop(pending);
                self.ports.events.emit(&Event::JoinStatus(status));
            }
        }
    }

    /// The join log's view of the network: how many peers we're connected to
    /// (through the relay or directly). Counts only, never who.
    fn log_links(&self, step: &str) {
        match self.ports.network.link_counts() {
            Some((peers, direct)) => tracing::info!(target: "mvs::join", peers, direct, "{step}"),
            None => tracing::info!(target: "mvs::join", "{step}"),
        }
    }

    /// Stops retrying a join that found nobody online (`retry_joins`).
    pub fn cancel_join(&self, link: &str) -> CoreResult<()> {
        self.pending_joins.lock().expect("not poisoned").remove(link.trim());
        Ok(())
    }

    /// Rust addition (`grantRole`).
    pub fn grant_role(&self, server_id: &str, user_id: &str, role: Role) -> CoreResult<()> {
        let target = parse_user(user_id)?;
        let action = Action::Grant { target, role: role.to_authority() };
        self.control_action(server_id, action)
    }

    /// Rust addition (`revokeRole`): back to plain member.
    pub fn revoke_role(&self, server_id: &str, user_id: &str) -> CoreResult<()> {
        self.control_action(server_id, Action::revoke(parse_user(user_id)?))
    }

    /// Allowed for moderators and up, against anyone ranked lower
    /// (`authority`'s rule; the mock only lets the owner kick).
    pub fn kick_member(&self, server_id: &str, user_id: &str) -> CoreResult<()> {
        self.control_action(server_id, Action::kick(parse_user(user_id)?))
    }

    // ---- server lifecycle (#229, #251) -----------------------------------
    //
    // Every command checks the rollout gate (`update-needed`) before it
    // signs: an older member would refuse the record and stall on every
    // control record after it. Each syncs first, so the gate (and a
    // close's causal past) is as current as the network allows.

    /// `renameServer`: the owner or an admin. The name is trimmed, then must
    /// pass the strict server-name rule (`bad-request`).
    pub fn rename_server(&self, server_id: &str, name: &str) -> CoreResult<ServerSummary> {
        let name = name.trim();
        if !authority::server_name_ok(name) {
            return Err(ErrorCode::BadRequest.into());
        }
        let server = parse_server(server_id)?;
        let _ = self.sync_now();
        self.run(|inner, ports, events| {
            inner.load_mine(server)?;
            inner.lifecycle_role(server, authority::Role::Admin)?;
            inner.cap_gate(server, model::SERVER_LIFECYCLE_CAP)?;
            inner.publish_control(ports, server, &Action::ServerEdit { name: name.to_owned() })?;
            let summary = inner.counted_summary(&*ports.cipher, server)?;
            events.push(Event::ServerUpdated(summary.clone()));
            Ok(summary)
        })
    }

    /// G-51 `setServerIcon(serverId, dataUrl | null)`: a still PNG or WebP
    /// of at most 8 KiB and 128 px a side (`avatar::icon_from_data_url`),
    /// or `null` to clear. The owner or an admin; behind `server-meta-v1`;
    /// at most one change per [`ICON_EVERY_MS`] per server from this device
    /// (`rate-limited`), since every icon stays in the control log. The
    /// same icon again signs nothing.
    pub fn set_server_icon(&self, server_id: &str, data_url: Option<&str>) -> CoreResult<ServerSummary> {
        let icon = match data_url {
            None => None,
            Some(url) => Some(crate::avatar::icon_from_data_url(url).ok_or(ErrorCode::BadRequest)?),
        };
        let server = parse_server(server_id)?;
        self.run(|inner, ports, events| {
            inner.load_mine(server)?;
            inner.lifecycle_role(server, authority::Role::Admin)?;
            if inner.view(server)?.state.server_icon == icon {
                return inner.counted_summary(&*ports.cipher, server);
            }
            inner.cap_gate(server, model::SERVER_META_CAP)?;
            let now = ports.clock.now_ms();
            let key = format!("{KV_ICON_SET_PREFIX}{}", model::hex_id(server.as_bytes()));
            // Only setting an image is limited: an admin must be able to
            // remove an offensive or mistaken icon at once, and a clear is
            // 2 bytes (Tech Lead on #555).
            let setting = icon.is_some();
            let last = inner.db.get(&key)?.and_then(|v| v.try_into().ok()).map(u64::from_le_bytes);
            if setting && last.is_some_and(|last| now.saturating_sub(last) < ICON_EVERY_MS) {
                return Err(ErrorCode::RateLimited.into());
            }
            inner.publish_control(ports, server, &Action::ServerIcon { icon })?;
            if setting {
                inner.db.set(&key, &now.to_le_bytes())?;
            }
            let summary = inner.counted_summary(&*ports.cipher, server)?;
            events.push(Event::ServerUpdated(summary.clone()));
            Ok(summary)
        })
    }

    /// G-51 `setServerDescription(serverId, text)`: trimmed; empty clears
    /// it; otherwise `authority::server_description_ok` (`\n` only, at most
    /// 5 lines, 500 code points) or `bad-request`. The owner or an admin;
    /// behind `server-meta-v1`. The same text again signs nothing. Shown as
    /// plain text, never Markdown or links.
    pub fn set_server_description(&self, server_id: &str, text: &str) -> CoreResult<ServerSummary> {
        let text = text.trim();
        if !text.is_empty() && !authority::server_description_ok(text) {
            return Err(ErrorCode::BadRequest.into());
        }
        let server = parse_server(server_id)?;
        self.run(|inner, ports, events| {
            inner.load_mine(server)?;
            inner.lifecycle_role(server, authority::Role::Admin)?;
            if inner.view(server)?.state.server_description.as_deref().unwrap_or("") == text {
                return inner.counted_summary(&*ports.cipher, server);
            }
            inner.cap_gate(server, model::SERVER_META_CAP)?;
            inner.publish_control(ports, server, &Action::ServerDescription { text: text.to_owned() })?;
            let summary = inner.counted_summary(&*ports.cipher, server)?;
            events.push(Event::ServerUpdated(summary.clone()));
            Ok(summary)
        })
    }

    /// `leaveServer`: any member but the owner (`not-allowed`; the owner
    /// deletes instead). The `Leave` goes out, so the others re-key; then
    /// the server leaves this device (`server.removed`, `left`). A leaver
    /// isn't banned: a new invite lets them back, as a plain member.
    pub fn leave_server(&self, server_id: &str) -> CoreResult<()> {
        let server = parse_server(server_id)?;
        let _ = self.sync_now();
        self.run(|inner, ports, events| {
            inner.load_mine(server)?;
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
            if inner.view(server)?.state.role(me) == authority::Role::Owner {
                return Err(ErrorCode::NotAllowed.into());
            }
            // Never blocked by the rollout gate (both leads, #261): the
            // signed `Leave` waits in a durable outbox and goes out once the
            // gate opens (`flush_leaves`), retried until a member has it.
            let leave =
                inner.publish_control(ports, server, &Action::Leave { cut: Cut::default() })?;
            inner.db.set_leave(server, &leave)?;
            if inner.cap_gate(server, model::SERVER_LIFECYCLE_CAP).is_ok() {
                ports.network.publish(&leave);
            }
            // Gone from the UI at once; only the sync secret and the control
            // subscription stay, to deliver the `Leave`.
            inner.purge_server(ports, server, RemovedReason::Left, &[], true, events)
        })?;
        self.flush_leaves();
        Ok(())
    }

    /// The leave outbox, once per sync round: each `Leave` not yet
    /// delivered is checked against what reachable peers hold (without the
    /// lock), then dropped, kept, or (re)published (`Inner::flush_leave`).
    fn flush_leaves(&self) {
        let pending = {
            let inner = self.lock();
            let Ok(leaves) = inner.db.leaves() else { return };
            leaves
                .into_iter()
                .filter_map(|(server, leave)| {
                    let secret = inner.secret(server).ok()??;
                    Some((server, leave, secret))
                })
                .collect::<Vec<_>>()
        };
        for (server, leave, secret) in pending {
            self.ports.network.open_server(server, &secret, &BTreeSet::new());
            let fetched: Vec<Record> = self
                .ports
                .network
                .fetch(server)
                .into_iter()
                .filter(|r| r.server() == server && r.scope() == Scope::Control)
                .collect();
            let _ = self.run(|inner, ports, _| inner.flush_leave(ports, server, &leave, fetched));
        }
    }

    /// `getUpdateNeeded`: the members whose latest profile post lacks `cap`
    /// (or who have none), so the UI can say who blocks it
    /// (`update-needed`). No cap: `server-lifecycle-v1` (a rename or a
    /// delete); `"reactions-v1"`: reactions (G-26). Any other name is
    /// `bad-request`. Empty: the gate is open.
    pub fn get_update_needed(&self, server_id: &str, cap: Option<&str>) -> CoreResult<Vec<Id>> {
        let cap = match cap {
            None => model::SERVER_LIFECYCLE_CAP,
            Some(cap) => *model::CAPS.iter().find(|c| **c == cap).ok_or(ErrorCode::BadRequest)?,
        };
        let server = parse_server(server_id)?;
        self.run(|inner, _, _| {
            inner.load_mine(server)?;
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
            let view = inner.view(server)?;
            Ok(view.lacking(cap, me).iter().map(|m| model::hex_id(m.as_bytes())).collect())
        })
    }

    /// `closeServer`: the owner deletes the server for good. Syncs first,
    /// so recent records are in the close's past (only those stay); then
    /// the close goes out and the server is closed here (`server.closed`,
    /// see `close_locally`), as it is for every member when they read it.
    pub fn close_server(&self, server_id: &str) -> CoreResult<()> {
        let server = parse_server(server_id)?;
        let _ = self.sync_now();
        self.run(|inner, ports, events| {
            inner.load_mine(server)?;
            inner.lifecycle_role(server, authority::Role::Owner)?;
            inner.cap_gate(server, model::SERVER_LIFECYCLE_CAP)?;
            inner.publish_control(ports, server, &Action::ServerClose)?;
            inner.close_locally(ports, server, events)
        })
    }

    /// B11: the owner creates a channel. `name-taken` if another channel of
    /// the server has the name; `bad-request` for a name authority refuses.
    pub fn create_channel(&self, server_id: &str, name: &str, adult: bool) -> CoreResult<Channel> {
        let name = model::channel_name(name).ok_or(ErrorCode::BadRequest)?;
        let server = parse_server(server_id)?;
        self.check_name_free(server, &name, None)?;
        self.check_may_mark_adult(server, adult)?;
        let mut id = [0u8; 32];
        OsRng.fill_bytes(&mut id);
        let channel = ChannelId::from_bytes(id);
        self.control_action(server_id, Action::ChannelCreate { channel, adult, name })?;
        let json = self.channel_json(server, channel)?;
        self.ports.events.emit(&Event::ChannelAdded(json.clone()));
        Ok(json)
    }

    /// B11: the owner renames a channel or changes its 18+ flag.
    pub fn update_channel(
        &self,
        channel_id: &str,
        name: Option<&str>,
        adult: Option<bool>,
    ) -> CoreResult<Channel> {
        let (server, channel, current) = self.live_channel(channel_id)?;
        let name = match name {
            Some(raw) => model::channel_name(raw).ok_or(ErrorCode::BadRequest)?,
            None => current.name.clone(),
        };
        self.check_name_free(server, &name, Some(channel))?;
        let adult = adult.unwrap_or(current.adult);
        self.check_may_mark_adult(server, adult)?;
        let server_id = model::hex_id(server.as_bytes());
        self.control_action(&server_id, Action::ChannelEdit { channel, adult, name })?;
        let json = self.channel_json(server, channel)?;
        self.ports.events.emit(&Event::ChannelUpdated(json.clone()));
        Ok(json)
    }

    /// G-14 `setChannelTopic(channelId, topic)`: the owner or an admin sets
    /// a channel's topic; an empty one (after trimming) clears it.
    /// `bad-request` unless it is one line of at most 256 code points that
    /// passes the strict name rule; `not-found` for an unknown or deleted
    /// channel; `not-allowed` below admin; `update-needed` until every member
    /// reads topics. The same topic again signs nothing. Never unread, a
    /// mention or a notification: only `channel.updated`.
    pub fn set_channel_topic(&self, channel_id: &str, topic: &str) -> CoreResult<Channel> {
        let topic = authority::channel_topic(topic).ok_or(ErrorCode::BadRequest)?;
        let topic = topic.as_str();
        let (server, channel, _) = self.live_channel(channel_id)?;
        let unchanged = {
            let mut inner = self.lock();
            inner.load_mine(server)?;
            inner.lifecycle_role(server, authority::Role::Admin)?;
            let current = inner.view(server)?.state.topics.get(&channel).cloned();
            if current.as_deref().unwrap_or("") != topic {
                inner.cap_gate(server, model::TOPIC_CAP)?;
            }
            current.as_deref().unwrap_or("") == topic
        };
        if !unchanged {
            let server_id = model::hex_id(server.as_bytes());
            let action = Action::ChannelTopic { channel, topic: topic.to_owned() };
            self.control_action(&server_id, action)?;
        }
        let json = self.channel_json(server, channel)?;
        if !unchanged {
            self.ports.events.emit(&Event::ChannelUpdated(json.clone()));
        }
        Ok(json)
    }

    /// G-11 `moveChannel(serverId, channelId, before?, after?)`: owner and
    /// admin only (`not-allowed`). Puts the channel right before `before`,
    /// or right after `after`, or last with neither; both must agree (the
    /// two neighbours of one gap), else `bad-request`, as for a neighbour
    /// that isn't a live channel of the server. One signed channel-order
    /// post: a key between the new neighbours', or, when a neighbour has no
    /// key yet or the key would pass 32 characters, keys for every channel
    /// in the new order (a rebalance). Returns the channels in order, and
    /// emits `channel.updated` for each one whose position changed.
    pub fn move_channel(
        &self,
        server_id: &str,
        channel_id: &str,
        before: Option<&str>,
        after: Option<&str>,
    ) -> CoreResult<Vec<Channel>> {
        let server = parse_server(server_id)?;
        let parse = |id: &str| model::parse_hex32(id).map(ChannelId::from_bytes);
        let channel = parse(channel_id).ok_or(ErrorCode::NotFound)?;
        let (moved, positions) = {
            let mut inner = self.lock();
            inner.load_mine(server)?;
            let me = inner.me.as_ref().map(Me::key).ok_or(ErrorCode::NotFound)?;
            let view = inner.view(server)?;
            if view.state.role(me) < authority::Role::Admin {
                return Err(ErrorCode::NotAllowed.into());
            }
            if !view.state.channels.contains_key(&channel) {
                return Err(ErrorCode::NotFound.into());
            }
            let positions = view.channel_positions();
            let mut order: Vec<ChannelId> = view.ordered_channels();
            order.retain(|c| *c != channel);
            let neighbour = |id: Option<&str>| -> CoreResult<Option<ChannelId>> {
                id.map(|id| {
                    parse(id)
                        .filter(|c| order.contains(c))
                        .ok_or_else(|| CoreError::from(ErrorCode::BadRequest))
                })
                .transpose()
            };
            let (before, after) = (neighbour(before)?, neighbour(after)?);
            let at = match (before, after) {
                (Some(b), Some(a)) => {
                    let b_at = order.iter().position(|c| *c == b).expect("checked");
                    if b_at == 0 || order[b_at - 1] != a {
                        return Err(ErrorCode::BadRequest.into());
                    }
                    b_at
                }
                (Some(b), None) => order.iter().position(|c| *c == b).expect("checked"),
                (None, Some(a)) => order.iter().position(|c| *c == a).expect("checked") + 1,
                (None, None) => order.len(),
            };
            order.insert(at, channel);
            let prev = at.checked_sub(1).map(|i| order[i]);
            let next = order.get(at + 1).copied();
            let key_of = |c: Option<ChannelId>| -> Option<Option<&String>> {
                match c {
                    None => Some(None),
                    Some(c) => positions.get(&c).map(Some),
                }
            };
            let single = match (key_of(prev), key_of(next)) {
                (Some(lo), Some(hi)) if lo.is_none_or(|lo| hi.is_none_or(|hi| lo < hi)) => {
                    let key = model::key_between(lo.map(String::as_str), hi.map(String::as_str));
                    (key.len() <= model::POSITION_MAX).then_some(key)
                }
                _ => None,
            };
            let moved: BTreeMap<ChannelId, String> = match single {
                Some(key) => BTreeMap::from([(channel, key)]),
                None => order.iter().copied().zip(model::spread_keys(order.len())).collect(),
            };
            (moved, positions)
        };
        self.control_action(server_id, model::channel_order_action(&moved))?;
        let list = self.list_channels(server_id)?;
        for json in &list {
            let id = parse(&json.id).expect("own hex");
            if moved.get(&id).is_some_and(|key| positions.get(&id) != Some(key)) {
                self.ports.events.emit(&Event::ChannelUpdated(json.clone()));
            }
        }
        Ok(list)
    }

    /// B11: the owner deletes a channel; never #general (`not-allowed`).
    /// TODO(sync): close its log in sync; until then it is only no longer
    /// opened (the next `open_server` leaves it out).
    pub fn delete_channel(&self, channel_id: &str) -> CoreResult<()> {
        let (server, channel, current) = self.live_channel(channel_id)?;
        if current.general {
            return Err(ErrorCode::NotAllowed.into());
        }
        let server_id = model::hex_id(server.as_bytes());
        self.control_action(&server_id, Action::ChannelDelete { channel })?;
        self.ports.events.emit(&Event::ChannelRemoved {
            server_id,
            channel_id: model::hex_id(channel.as_bytes()),
            name: current.name,
            reason: Some(ChannelRemovedReason::Deleted),
        });
        Ok(())
    }

    fn live_channel(
        &self,
        channel_id: &str,
    ) -> CoreResult<(ServerId, ChannelId, authority::Channel)> {
        let mut inner = self.lock();
        let (server, channel) = inner.find_channel(channel_id)?;
        let view = inner.view(server)?;
        let current = view.state.channels.get(&channel).cloned().ok_or(ErrorCode::NotFound)?;
        Ok((server, channel, current))
    }

    /// An 18+ channel only from someone whose own age claim says 18+: else
    /// they couldn't see the channel they made (B7). `not-allowed` before
    /// anything is signed or sent.
    fn check_may_mark_adult(&self, server: ServerId, adult: bool) -> CoreResult<()> {
        if !adult {
            return Ok(());
        }
        let mut inner = self.lock();
        let server = inner.load_mine(server)?;
        let me = inner.me.as_ref().map(Me::key).ok_or(ErrorCode::NotFound)?;
        if !inner.view(server)?.state.adults.contains(&me) {
            return Err(ErrorCode::NotAllowed.into());
        }
        Ok(())
    }

    fn check_name_free(
        &self,
        server: ServerId,
        name: &str,
        except: Option<ChannelId>,
    ) -> CoreResult<()> {
        let mut inner = self.lock();
        let server = inner.load_mine(server)?;
        let view = inner.view(server)?;
        let taken = view.state.channels.iter().any(|(id, c)| Some(*id) != except && c.name == name);
        if taken {
            return Err(ErrorCode::NameTaken.into());
        }
        Ok(())
    }

    fn channel_json(&self, server: ServerId, channel: ChannelId) -> CoreResult<Channel> {
        let mut inner = self.lock();
        inner.open_sync(&self.ports, server)?;
        let me = inner.me.as_ref().map(Me::key);
        let id = model::hex_id(channel.as_bytes());
        let found = inner.view(server)?.channels(me).into_iter().find(|c| c.id == id);
        let mut json = [found.ok_or(ErrorCode::Internal)?];
        inner.fill_unread(&*self.ports.cipher, server, &mut json)?;
        let [json] = json;
        Ok(json)
    }

    /// G-21 `markRead(channelId)`: everything in the channel now counts as
    /// read (the marker moves to its last message), and `channel.updated`
    /// carries the reset `unreadCount` and no `firstUnreadIndex`, then
    /// `server.updated` with the server's recounted dot and badge. Local only.
    pub fn mark_read(&self, channel_id: &str) -> CoreResult<()> {
        let (server, channel) = {
            let mut inner = self.lock();
            let (server, channel) = inner.find_channel(channel_id)?;
            let shown = inner.shown(&*self.ports.cipher, server, channel)?;
            let last = shown.iter().map(|s| (s.record.ts(), *s.record.id().as_bytes())).max();
            let marker = last.unwrap_or((self.ports.clock.now_ms(), [0; 32]));
            let key = format!("{KV_READ_PREFIX}{}", model::hex_id(channel.as_bytes()));
            let value = serde_json::to_vec(&(marker.0, hex::encode(marker.1))).expect("plain tuple");
            inner.db.set(&key, &value)?;
            (server, channel)
        };
        let json = self.channel_json(server, channel)?;
        self.ports.events.emit(&Event::ChannelUpdated(json));
        // The server rail too: its dot and badge come from all its channels.
        let summary = self.lock().counted_summary(&*self.ports.cipher, server)?;
        self.ports.events.emit(&Event::ServerUpdated(summary));
        Ok(())
    }

    /// Rust addition (`undoKick`, B4 kick-undo): the owner lets a kicked
    /// account back. It isn't made a member: it may join again through an
    /// invite. `not-allowed` for anyone but the owner, or someone not kicked.
    pub fn undo_kick(&self, server_id: &str, user_id: &str) -> CoreResult<()> {
        self.control_action(server_id, Action::Unban { target: parse_user(user_id)? })
    }

    /// Rust addition (`listRemovedMembers`): the owner's list of removed
    /// accounts, with when each was kicked. `not-allowed` for anyone else.
    pub fn list_removed_members(&self, server_id: &str) -> CoreResult<Vec<RemovedMember>> {
        let mut inner = self.lock();
        let server = inner.load_mine(parse_server(server_id)?)?;
        let me = inner.me.as_ref().map(Me::key);
        let view = inner.view(server)?;
        if me != Some(view.owner) {
            return Err(ErrorCode::NotAllowed.into());
        }
        let names = view.display_names();
        let kicked_at: HashMap<RecordId, u64> =
            view.records.iter().map(|r| (r.id(), r.ts())).collect();
        Ok(view
            .state
            .removed
            .iter()
            .filter(|(key, _)| view.state.kicked.contains(key))
            .map(|(key, kick)| RemovedMember {
                id: model::hex_id(key.as_bytes()),
                short_code: model::short_code(key),
                display_name: names.get(key).cloned().unwrap_or_default(),
                removed_at: kicked_at.get(kick).copied().unwrap_or_default(),
            })
            .collect())
    }

    // TODO(records B4):
    // - Kick, Leave and Revoke go out with an empty cut today (`Action::kick`,
    //   `Action::revoke`). B4-4: fill it with up to 64 channel heads, syncing
    //   them first, starting with the channels where the target has records.
    // - When an invite expires, send `RevokeInvite` automatically if we are
    //   its inviter or a moderator and up.
    fn control_action(&self, server_id: &str, action: Action) -> CoreResult<()> {
        self.control_record(server_id, action).map(|_| ())
    }

    /// `control_action`, returning the accepted record's ID.
    fn control_record(&self, server_id: &str, action: Action) -> CoreResult<RecordId> {
        let server = parse_server(server_id)?;
        self.run(|inner, ports, events| {
            inner.load_mine(server)?;
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
            if matches!(&action, Action::Kick { target, .. } if *target == me.key()) {
                return Err(ErrorCode::NotAllowed.into());
            }
            let record = inner.publish_control(ports, server, &action)?;
            if matches!(action, Action::Invite { .. } | Action::RevokeInvite { .. }) {
                // The server's link may name another invite now.
                events.push(Event::ServerUpdated(inner.counted_summary(&*ports.cipher, server)?));
                return Ok(record.id());
            }
            let after = inner.view(server)?;
            events.push(Event::MembersChanged {
                server_id: server_id.to_owned(),
                members: inner.members_json(&after)?,
            });
            // M2: removed members must not read what comes next.
            if matches!(action, Action::Kick { .. } | Action::Revoke { .. }) {
                // The kick is stored and sent: a failed re-key must not undo that.
                if inner.rekey(ports, server, events).is_err() {
                    events.push(Event::Notice {
                        kind: NoticeKind::RekeyWaiting,
                        server_id: server_id.to_owned(),
                    });
                }
            }
            Ok(record.id())
        })
    }

    // ---- voice ------------------------------------------------------------

    /// Voice: sync's voice transport (piece A). Without one, `joinCall`
    /// answers `not-implemented`.
    pub fn set_voice(&self, net: Arc<dyn VoiceNet>) {
        self.lock().calls.set_net(net);
    }

    /// In a call: `applyUpdate` refuses.
    pub fn in_call(&self) -> bool {
        self.lock().calls.in_call()
    }

    /// `joinCall(roomId)`: a live voice room of one of my servers; leaves
    /// any other call first. A text channel answers `not-allowed`, an
    /// unknown or gone room `not-found`.
    pub fn join_call(&self, room_id: &str) -> CoreResult<CallState> {
        let room =
            model::parse_hex32(room_id).map(ChannelId::from_bytes).ok_or(ErrorCode::NotFound)?;
        self.voice(|calls, ctx, inner| {
            let server = match calls.room_server(room) {
                Some(server) if inner.db.has_server(server)? => server,
                _ => {
                    inner.channel_server(room)?;
                    return Err(ErrorCode::NotAllowed.into());
                }
            };
            calls.join(ctx, inner, server, room)
        })
    }

    /// `createVoiceRoom(serverId)`: a new room with me as its master, and
    /// me in it (leaving any other call first). `room-cap` at 10 live rooms.
    pub fn create_voice_room(&self, server_id: &str) -> CoreResult<CallState> {
        let server = parse_server(server_id)?;
        self.voice(|calls, ctx, inner| {
            if !inner.db.has_server(server)? {
                return Err(ErrorCode::NotFound.into());
            }
            calls.create(ctx, inner, server)
        })
    }

    /// `listVoiceRooms(serverId)`: the server's live rooms, oldest first.
    /// `not-found` for a server I don't have, `not-allowed` if I'm not a
    /// member (or kicked).
    pub fn list_voice_rooms(&self, server_id: &str) -> CoreResult<Vec<VoiceRoom>> {
        let server = parse_server(server_id)?;
        self.voice(|calls, ctx, inner| {
            if !inner.db.has_server(server)? {
                return Err(ErrorCode::NotFound.into());
            }
            let me = PublicKey::from_bytes(ctx.key.verifying_key().to_bytes());
            if !voice::Members::may_call(inner, me, server) {
                return Err(ErrorCode::NotAllowed.into());
            }
            Ok(calls.list(ctx, inner, server))
        })
    }

    /// `editVoiceRoom(roomId, name?, limit?)`: by the room's master (applied
    /// now) or the server owner (sent to the master). `name: ""` restores
    /// the default.
    pub fn edit_voice_room(&self, room_id: &str, name: Option<String>, limit: Option<u8>) -> CoreResult<()> {
        let room =
            model::parse_hex32(room_id).map(ChannelId::from_bytes).ok_or(ErrorCode::NotFound)?;
        self.voice(|calls, ctx, inner| calls.edit(ctx, inner, room, name, limit))
    }

    /// `leaveCall`: idempotent.
    pub fn leave_call(&self) -> CoreResult<()> {
        if !self.in_call() {
            return Ok(());
        }
        self.voice(|calls, ctx, inner| {
            calls.leave(ctx, inner);
            Ok(())
        })
    }

    /// `setMuted`: `not-allowed` outside a call.
    pub fn set_muted(&self, muted: bool) -> CoreResult<()> {
        self.voice(|calls, ctx, inner| calls.set_muted(ctx, inner, muted))
    }

    /// G-84b `setDeafened`: shown to the others in my call (with mute).
    pub fn set_deafened(&self, deafened: bool) -> CoreResult<()> {
        self.voice(|calls, ctx, inner| calls.set_deafened(ctx, inner, deafened))
    }

    /// `sendSignal`: to a participant of my call.
    pub fn send_signal(&self, to: &str, kind: SignalKind, payload: String) -> CoreResult<()> {
        let to = parse_user(to)?;
        self.voice(|calls, ctx, _| calls.send_signal(ctx, to, kind, payload))
    }

    // ---- typing (G-29) ----------------------------------------------------

    /// G-29: sync's typing transport. Without one, nothing is sent.
    pub fn set_typing_net(&self, net: Arc<dyn TypingNet>) {
        self.lock().typing.set_net(net);
    }

    /// `setTyping(channelId, on)`: `true` while typing (sent at once, then
    /// at most every 3 s), `false` on send or clear (`off` once; `off` also
    /// goes 4 s after the last `true`). Nothing is sent with the setting
    /// off. `not-found`: no channel I can see; `not-allowed`: I can't post
    /// there now.
    pub fn set_typing(&self, channel_id: &str, on: bool) -> CoreResult<()> {
        self.run(|inner, ports, _| {
            let (server, channel) = inner.find_channel(channel_id)?;
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
            if !inner.may_type(me, server, channel) {
                return Err(ErrorCode::NotAllowed.into());
            }
            if !inner.typing_indicator() {
                return Ok(());
            }
            let now = ports.clock.now_ms();
            let send =
                if on { inner.typing.typing(server, channel, now) } else { inner.typing.stopped(channel) };
            inner.send_typing(now, send.into_iter().collect());
            Ok(())
        })
    }

    /// A blob from sync's typing transport; `from` is the identity sync
    /// bound the sending peer to. Anything that doesn't check out (see
    /// `typing`) is dropped quietly.
    pub fn typing_received(&self, from: Option<PublicKey>, blob: &[u8]) {
        let _ = self.run(|inner, ports, events| {
            let now = ports.clock.now_ms();
            let Some(opened) = typing::open(blob, now) else { return Ok(()) };
            let me = inner.me.as_ref().map(Me::key);
            // My own other computers aren't shown as typing.
            if from != Some(opened.from) || me == Some(opened.from) {
                return Ok(());
            }
            if !inner.may_type(opened.from, opened.server, opened.channel)
                || !inner.visible(opened.server)?.contains(&opened.channel)
                || !inner.typing.fresh(opened.nonce, now)
            {
                return Ok(());
            }
            inner.typing.heard(opened.from, opened.channel, opened.on, now);
            inner.typing_events(events);
            Ok(())
        });
    }

    /// G-29 timers: `off` for my idle channels, and typers past 6 s
    /// dropped. Called about every second.
    pub fn typing_tick(&self) {
        let _ = self.run(|inner, ports, events| {
            let now = ports.clock.now_ms();
            let sends = inner.typing.tick(now);
            inner.send_typing(now, sends);
            inner.typing_events(events);
            Ok(())
        });
    }

    /// `getSettings`: what the core keeps on this device.
    pub fn get_settings(&self) -> CoreResult<CoreSettings> {
        Ok(CoreSettings { typing_indicator: self.lock().typing_indicator() })
    }

    /// `setTypingIndicator(on)`: "Show others when I'm typing" (local).
    /// Turning it off sends `off` wherever I was typing.
    pub fn set_typing_indicator(&self, on: bool) -> CoreResult<()> {
        self.run(|inner, ports, _| {
            inner.db.set(KV_TYPING_INDICATOR, if on { b"1" } else { b"0" })?;
            if !on {
                let sends = inner.typing.stop_all();
                inner.send_typing(ports.clock.now_ms(), sends);
            }
            Ok(())
        })
    }

    /// A blob from sync's voice transport; `from` is the identity sync bound
    /// the sending peer to. Anything that doesn't check out is dropped.
    pub fn voice_received(&self, from: Option<PublicKey>, blob: &[u8]) {
        let _ = self.voice(|calls, ctx, inner| {
            calls.received(ctx, inner, from, blob);
            Ok(())
        });
    }

    /// Hellos and timeouts; the sync loop calls it every round.
    pub fn voice_tick(&self) {
        let _ = self.voice(|calls, ctx, inner| {
            calls.tick(ctx, inner);
            Ok(())
        });
    }

    fn voice<T>(
        &self,
        f: impl FnOnce(&mut voice::Calls, &mut voice::Ctx, &mut Inner) -> CoreResult<T>,
    ) -> CoreResult<T> {
        self.run(|inner, ports, events| {
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
            let key = me.identity.signing_key().clone();
            // Out of `inner` while it answers who may call.
            let mut calls = std::mem::take(&mut inner.calls);
            let mut ctx = voice::Ctx { key: &key, now: ports.clock.now_ms(), events };
            let result = f(&mut calls, &mut ctx, inner);
            inner.calls = calls;
            result
        })
    }

    // ---- invites ------------------------------------------------------------

    /// Rust addition (`createInvite`, #208): a new invite, moderator and up.
    /// `expires_ms`: the last time a join through it is accepted, in the
    /// future; none for never. `max_uses`: none or 0 for unlimited.
    pub fn create_invite(
        &self,
        server_id: &str,
        expires_ms: Option<u64>,
        max_uses: Option<u32>,
    ) -> CoreResult<CreatedInvite> {
        if expires_ms.is_some_and(|at| at <= self.ports.clock.now_ms()) {
            return Err(ErrorCode::BadRequest.into());
        }
        let action =
            Action::Invite { expires_ms: expires_ms.unwrap_or(0), max_uses: max_uses.unwrap_or(0) };
        let invite = self.control_record(server_id, action)?;
        let server = parse_server(server_id)?;
        let mut inner = self.lock();
        let secret = inner.secret(server)?.ok_or(ErrorCode::Internal)?;
        let short_link = inner.publish_invite(&self.ports, server, invite, &secret)?;
        Ok(CreatedInvite {
            id: model::hex_id(invite.as_bytes()),
            link: model::invite_link(server, invite, &secret),
            short_link: short_link.as_str().to_owned(),
            expires_at: expires_ms,
            max_uses: max_uses.filter(|n| *n > 0),
        })
    }

    /// Rust addition (`listInvites`, #208): every invite of the server,
    /// oldest first, revoked ones included. Moderator and up.
    pub fn list_invites(&self, server_id: &str) -> CoreResult<Vec<InviteInfo>> {
        let mut inner = self.lock();
        let server = inner.load_mine(parse_server(server_id)?)?;
        let me = inner.me.as_ref().map(Me::key).ok_or(ErrorCode::NotFound)?;
        let view = inner.view(server)?;
        if view.state.role(me) < authority::Role::Moderator {
            return Err(ErrorCode::NotAllowed.into());
        }
        let storage = inner.me.as_ref().map(|me| *me.identity.storage_key().expose_secret());
        let now = self.ports.clock.now_ms();
        let mut out = Vec::new();
        for r in view.records.iter().filter(|r| r.kind() == Kind::Invite) {
            let Some(invite) = view.state.invites.get(&r.id()) else { continue };
            // A short link only while live (S1), and only where its key is.
            let short_link = match (storage, view.live_invite_author(r.id(), now)) {
                (Some(storage), Some(_)) => inner
                    .db
                    .load_invite_key(&storage, server, r.id())?
                    .map(|k| crate::invite_link::encode_v1(&k, &server).as_str().to_owned())
                    .unwrap_or_default(),
                _ => String::new(),
            };
            out.push(InviteInfo {
                id: model::hex_id(r.id().as_bytes()),
                created_by: model::hex_id(invite.author.as_bytes()),
                expires_at: (invite.expires_ms > 0).then_some(invite.expires_ms),
                max_uses: invite.max_uses,
                uses: invite.uses,
                revoked: invite.revoked,
                short_link,
            });
        }
        Ok(out)
    }

    /// Rust addition (`revokeInvite`, #208): its author, or someone ranked
    /// above its author. `not-found` for an unknown or already revoked
    /// invite.
    pub fn revoke_invite(&self, server_id: &str, invite_id: &str) -> CoreResult<()> {
        let invite =
            model::parse_hex32(invite_id).map(RecordId::from_bytes).ok_or(ErrorCode::NotFound)?;
        {
            let mut inner = self.lock();
            let server = inner.load_mine(parse_server(server_id)?)?;
            let view = inner.view(server)?;
            if view.state.invites.get(&invite).is_none_or(|i| i.revoked) {
                return Err(ErrorCode::NotFound.into());
            }
        }
        self.control_action(server_id, Action::RevokeInvite { invite })?;
        // S1: its short link stops being served at once.
        let mut inner = self.lock();
        inner.refresh_invites(&self.ports, parse_server(server_id)?)
    }

    // ---- messages ---------------------------------------------------------
    //
    // TODO(chat): replies, edit, delete, retry; channels other than the
    // default one; auth_deps that always include our latest control heads
    // (today: up to MAX_AUTH_DEPS of the current heads).

    /// Seals `body` for the channel's members and sends it. The first
    /// message of a channel, or the first after a removal, needs a key
    /// rotation: a moderator or above makes one on the way. A plain member
    /// without the key yet (just joined: the moderator's re-key is on its
    /// way) gets the message back at once as `sendState: pending`, with a
    /// provisional `pending-…` ID. The sync loop sends it when the key comes
    /// (`message.updated` carrying `replaces`), or after
    /// [`KEY_PENDING_FOR`] marks it `failed` (`message.updated`, and
    /// `notice: rekey-waiting`). Never a wait on the request thread.
    pub fn send_message(
        &self,
        channel_id: &str,
        body: &str,
        reply_to: Option<&str>,
    ) -> CoreResult<Message> {
        if reply_to.is_some() {
            return Err(ErrorCode::NotImplemented.into());
        }
        if body.trim().is_empty() || !authority::message_text_ok(body) {
            return Err(ErrorCode::BadRequest.into());
        }
        let message = self.run(|inner, ports, events| {
            let (server, channel) = inner.find_channel(channel_id)?;
            // G-29: a send ends my typing there (`off` once, if `on` went out).
            let stop = inner.typing.stopped(channel);
            inner.send_typing(ports.clock.now_ms(), stop.into_iter().collect());
            if inner.waits_for_join_key(ports, server, channel)? {
                let message = inner.hold_for_key(ports, server, channel, body)?;
                events.push(Event::MessageAdded(message.clone()));
                return Ok(message);
            }
            let sealed = match inner.seal_with(ports, server, channel, body.as_bytes(), false) {
                Ok(sealed) => sealed,
                Err(e) if e.code == ErrorCode::NotAllowed && inner.awaiting_key(server)? => {
                    let message = inner.hold_for_key(ports, server, channel, body)?;
                    events.push(Event::MessageAdded(message.clone()));
                    return Ok(message);
                }
                Err(e) => return Err(e),
            };
            let record =
                inner.sign_in_channel(ports, server, channel, None, Kind::Message, sealed)?;
            inner.store(server, record.clone())?;
            ports.network.publish(&record);
            let message = inner.message(&*ports.cipher, server, channel, record.id())?;
            events.push(Event::MessageAdded(message.clone()));
            Ok(message)
        })?;
        if message.send_state == Some(SendState::Pending) && message.id.starts_with(KEY_PENDING_PREFIX) {
            // A round of the background sync now: it brings the re-key in.
            self.ports.network.wake();
        }
        Ok(message)
    }

    /// The author only (authority's rule). The new text is sealed like a
    /// message; the edit names its target in its body and deps.
    pub fn edit_message(&self, message_id: &str, body: &str) -> CoreResult<()> {
        if body.trim().is_empty() || !authority::message_text_ok(body) {
            return Err(ErrorCode::BadRequest.into());
        }
        self.run(|inner, ports, events| {
            let (server, channel, target, _) = inner.find_message(message_id)?;
            let sealed = inner.seal(ports, server, channel, body.as_bytes())?;
            let body = [target.as_bytes().as_slice(), &sealed].concat();
            inner.tombstone_or_edit(ports, events, server, channel, target, Kind::MessageEdit, body)
        })
    }

    /// Drops a message held for its key (`pending-…`, pending or failed)
    /// before it was sent: its text is wiped from memory now, and nothing
    /// was ever sent. For "send again" (discard, then a new `sendMessage`)
    /// or dismissing a failed one. `not-found` for any other ID, or one
    /// already sent or discarded.
    pub fn discard_message(&self, message_id: &str) -> CoreResult<()> {
        let mut inner = self.lock();
        let at = inner.key_pending.iter().position(|p| p.id == message_id).ok_or(ErrorCode::NotFound)?;
        inner.key_pending.remove(at);
        Ok(())
    }

    /// The author, or a moderator or above who outranks them. The message
    /// keeps its place as a tombstone (`deleted: true`, no text).
    pub fn delete_message(&self, message_id: &str) -> CoreResult<()> {
        self.run(|inner, ports, events| {
            let (server, channel, target, _) = inner.find_message(message_id)?;
            let body = target.as_bytes().to_vec();
            inner.tombstone_or_edit(
                ports,
                events,
                server,
                channel,
                target,
                Kind::MessageDelete,
                body,
            )
        })
    }

    /// G-26: turns my `emoji` on or off under a message, as a sealed
    /// `Reaction` record (`crate::reaction` has the rules every core folds
    /// by). Nothing is signed when it is already so.
    /// - `bad-request`: not an emoji `reaction::normalize` accepts, or an
    ///   11th emoji of mine on this message;
    /// - `not-found`: no such message I can see, or it is deleted;
    /// - `not-allowed`: I may not write in that channel now;
    /// - `update-needed`: another member's version can't read reactions
    ///   (`getUpdateNeeded(serverId, "reactions-v1")` says who);
    /// - `rate-limited`: 30 reactions of mine in this channel within a
    ///   minute.
    pub fn react(&self, message_id: &str, emoji: &str, on: bool) -> CoreResult<()> {
        let emoji = reaction::normalize(emoji).ok_or(ErrorCode::BadRequest)?;
        self.run(|inner, ports, events| {
            let (server, channel, target, _) = inner.find_message(message_id)?;
            // 18+ channels only with an accepted 18+ claim (B7).
            if !inner.visible(server)?.contains(&channel) {
                return Err(ErrorCode::NotFound.into());
            }
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
            let view = inner.view(server)?;
            if !view.state.is_member(me) || view.is_kicked(&me) || view.state.closed.is_some() {
                return Err(ErrorCode::NotAllowed.into());
            }
            inner.cap_gate(server, model::REACTIONS_CAP)?;
            let cipher = &*ports.cipher;
            let shown = inner.shown(cipher, server, channel)?;
            let live: HashSet<RecordId> =
                shown.iter().filter(|s| !s.deleted).map(|s| s.record.id()).collect();
            if !live.contains(&target) {
                return Err(ErrorCode::NotFound.into());
            }
            let log = inner.logs.get(&server).ok_or(ErrorCode::Internal)?;
            let now = ports.clock.now_ms();
            let folded = chat::reactions(cipher, server, channel, log, &live, now);
            let mine = folded.on.get(&target);
            if mine.is_some_and(|m| m.is_on(&emoji, me)) == on {
                return Ok(());
            }
            if on && mine.is_some_and(|m| m.count_of(me) >= reaction::PER_AUTHOR) {
                return Err(ErrorCode::BadRequest.into());
            }
            // Counted the way every core will count the record I'd sign.
            if folded.gate.near(me) >= reaction::RATE_LIMIT {
                return Err(ErrorCode::RateLimited.into());
            }
            let plaintext =
                reaction::Reaction::encode(target, &emoji, on).ok_or(ErrorCode::BadRequest)?;
            let sealed = inner.seal(ports, server, channel, &plaintext)?;
            // Signed at its effective time, never before its deps: a clock
            // that runs behind the others' must not make every core ignore
            // it as backdated. (Sealing may have added a key rotation.)
            let log = inner.logs.get(&server).ok_or(ErrorCode::Internal)?;
            let deps = chat::channel_deps(log, channel);
            let ts = folded.gate.sign_at(&deps);
            let seq = chat::channel_seq(log, channel, &me);
            let auth = auth_deps(&inner.view(server)?);
            let record =
                inner.sign_channel(server, channel, seq, deps, auth, ts, Kind::Reaction, sealed)?;
            let log = inner.logs.get(&server).ok_or(ErrorCode::Internal)?;
            if !chat::would_accept(log, &record) {
                return Err(ErrorCode::NotAllowed.into());
            }
            inner.store(server, record.clone())?;
            ports.network.publish(&record);
            let message = inner.message(cipher, server, channel, target)?;
            events.push(Event::MessageUpdated(message));
            Ok(())
        })
    }

    /// Sends one of my messages again: the same stored record, never
    /// re-signed (another record would be another message).
    pub fn retry_message(&self, message_id: &str) -> CoreResult<()> {
        let mut inner = self.lock();
        // A pruned message (B6-p) has no record left to send.
        let (_, _, _, record) = inner.find_message(message_id)?;
        let record = record.ok_or(ErrorCode::NotAllowed)?;
        let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        if record.author() != me {
            return Err(ErrorCode::NotAllowed.into());
        }
        drop(inner);
        self.ports.network.publish(&record);
        Ok(())
    }
    pub fn get_message_count(&self, channel_id: &str) -> CoreResult<usize> {
        let mut inner = self.lock();
        let (server, channel) = inner.find_channel(channel_id)?;
        // Messages held for their key are listed after the stored ones.
        let held = inner.key_pending.iter().filter(|p| p.channel == channel).count();
        Ok(inner.message_count(&*self.ports.cipher, server, channel)? + held)
    }

    /// Messages `start..end` (0-based, end exclusive) of the channel.
    pub fn get_messages(
        &self,
        channel_id: &str,
        start: usize,
        end: usize,
    ) -> CoreResult<MessageRange> {
        let mut inner = self.lock();
        let (server, channel) = inner.find_channel(channel_id)?;
        let me = inner.me.as_ref().map(Me::key);
        let shown = inner.shown(&*self.ports.cipher, server, channel)?;
        let members = inner.view(server)?.state.members.clone();
        // Messages held for their key come after the stored ones.
        let held: Vec<&KeyPending> = inner.key_pending.iter().filter(|p| p.channel == channel).collect();
        let end = end.min(shown.len() + held.len());
        let start = start.min(end);
        let messages = (start..end)
            .map(|index| match shown.get(index) {
                Some(s) => message_json(s, index, channel, me, &Status { net: &*inner.net, db: &inner.db }, &members),
                None => held[index - shown.len()].message(index),
            })
            .collect();
        Ok(MessageRange { channel_id: channel_id.to_owned(), start, messages })
    }

    /// The background sync the app runs (`mvs-core` starts it when a
    /// network is configured): what `syncNow` does, every [`SYNC_EVERY`]
    /// and at once on each hint (sync stored something), until `stop` is
    /// set. A failed round is logged and retried on the next one. Holds the
    /// core lock only to store, never while fetching.
    pub fn run_sync_loop(&self, hints: &Receiver<()>, stop: &AtomicBool) {
        while !stop.load(Ordering::SeqCst) {
            if let Err(e) = self.sync_now() {
                eprintln!("mvs-core: sync round failed: {:?}", e.code);
            }
            self.voice_tick();
            // A waiting join re-key fires exactly when its token is due.
            let wait = self.next_rekey_in().map_or(SYNC_EVERY, |due| due.min(SYNC_EVERY));
            match hints.recv_timeout(wait) {
                // Several hints at once are one round.
                Ok(()) => while hints.try_recv().is_ok() {},
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => std::thread::sleep(SYNC_EVERY),
            }
        }
    }

    /// How long until the next join re-key token is due on a server whose
    /// joiners wait for one (GAP-8); `None` when nobody waits. The sync loop
    /// wakes then, so the shared re-key fires on time. Never below
    /// [`REKEY_WAKE_FLOOR`], so a re-key that keeps not happening can't spin
    /// the loop into back-to-back syncs.
    pub fn next_rekey_in(&self) -> Option<Duration> {
        let now = self.ports.clock.now_ms();
        let inner = self.lock();
        inner
            .join_waiting
            .iter()
            .filter_map(|server| inner.join_buckets.get(server))
            .map(|bucket| Duration::from_millis(bucket.due().saturating_sub(now)))
            .min()
            .map(|due| due.max(REKEY_WAKE_FLOOR))
    }

    /// Rust addition (`syncNow`): pulls every server's records from the
    /// network and reports what changed. TODO(sync): driven by the sync
    /// crate's push and pull instead of a command.
    pub fn sync_now(&self) -> CoreResult<()> {
        self.announce_device_notices();
        // Device link, the new device: its link moves on even before sign-in.
        self.poll_device_link();
        let result = self.sync_round();
        // Member relays: a role read from the log, a leave, a birth date
        // whose 30 days ended.
        let mut events = Vec::new();
        self.lock().check_member_relay(&self.ports, &mut events);
        self.emit(events);
        result
    }

    fn sync_round(&self) -> CoreResult<()> {
        self.retry_joins();
        self.flush_leaves();
        // A restore still waiting on its backup or on servers nobody could
        // be reached for: retried with backoff.
        self.retry_backup_restore();
        // Restore servers (#291 phase A): my server list, backed up when it
        // changed, at login, or every 24 h; the network calls run outside
        // the core lock.
        self.backup_round();
        let servers = {
            let mut inner = self.lock();
            if inner.me.is_none() {
                return Ok(());
            }
            // A closed server is no longer synced.
            let mut servers = inner.db.servers()?;
            servers.retain(|s| inner.db.closed_at(*s).ok().flatten().is_none());
            // GAP-4: (re)open each server with its secret and channels first.
            for server in &servers {
                inner.load(*server)?;
                inner.open_sync(&self.ports, *server)?;
            }
            // T8-02: publications members pushed (C1), then serve only what
            // is still live (S1).
            for (server, bytes) in self.ports.network.take_invite_publications() {
                inner.accept_pushed_invite(&self.ports, server, &bytes)?;
            }
            for server in &servers {
                inner.refresh_invites(&self.ports, *server)?;
            }
            servers
        };
        // Fetch without the lock, so UI commands don't wait on the network.
        let fetched: Vec<(ServerId, Vec<Record>)> =
            servers.into_iter().map(|s| (s, self.ports.network.fetch(s))).collect();
        self.run(|inner, ports, events| {
            let Some(me) = inner.me.as_ref() else { return Ok(()) };
            let me = me.key();
            // Closed servers past their 30 days: purged but for their
            // genesis and close.
            inner.expire_closed(ports, events)?;
            // Decision 18: a raise whose 30 days are up takes effect.
            inner.apply_due_birth_date(ports, events)?;
            // #354: a coalesced profile change, once its 10 minutes are up.
            inner.flush_profile(ports)?;
            for (server, records) in fetched {
                if !inner.db.has_server(server)? {
                    continue;
                }
                inner.load(server)?;
                inner.seed_announced(&*ports.cipher, server)?;
                let name_before = inner.view(server)?.state.server_name.clone();
                // G-51: the icon and description change the summary too.
                let meta_before = {
                    let view = inner.view(server)?;
                    (view.state.server_icon.clone(), view.state.server_description.clone())
                };
                let topics_before = inner.view(server)?.state.topics.clone();
                let mut changed = false;
                for record in records {
                    if record.server() == server {
                        changed |= inner.store(server, record)?;
                    }
                }
                // Server lifecycle: the owner deleted it; it leaves this device.
                if inner.view(server)?.state.closed.is_some() {
                    inner.close_locally(ports, server, events)?;
                    continue;
                }
                let meta_changed = {
                    let view = inner.view(server)?;
                    view.state.server_name != name_before
                        || (view.state.server_icon.clone(), view.state.server_description.clone()) != meta_before
                };
                if meta_changed {
                    events.push(Event::ServerUpdated(inner.counted_summary(&*ports.cipher, server)?));
                }
                // G-14: a topic set or cleared elsewhere. Only
                // `channel.updated`: never unread, a mention or a notice.
                inner.topic_events(&*ports.cipher, server, &topics_before, Some(me), events)?;
                // Release N: say this version reads lifecycle records. Never
                // aborts the other servers; the next round retries.
                let _ = inner.post_caps(ports, server);
                // B7-k K2: owners and admins learn when older members would
                // key an 18+ channel for minors too.
                let _ = inner.adult_keys_notice(server, me, events);
                let after = inner.view(server)?;
                if after.is_kicked(&me) {
                    inner.join_waiting.remove(&server);
                    // Purges its invite publications and keys too.
                    inner.db.remove_server(server)?;
                    ports.network.drop_server_invites(server);
                    events.push(Event::ServerRemoved {
                        server_id: model::hex_id(server.as_bytes()),
                        reason: None,
                        required: None,
                    });
                } else if changed {
                    events.push(Event::MembersChanged {
                        server_id: model::hex_id(server.as_bytes()),
                        members: inner.members_json(&after)?,
                    });
                    // M2: a kick or revoke we read, that nobody re-keyed for.
                    // Never aborts the other servers; the next sync retries.
                    if inner.rekey(ports, server, events).is_err() {
                        events.push(Event::Notice {
                            kind: NoticeKind::RekeyWaiting,
                            server_id: model::hex_id(server.as_bytes()),
                        });
                    }
                    inner.announce(&*ports.cipher, server, events)?;
                    inner.prune(ports, server)?;
                } else if inner.may_rotate(server)? {
                    // A join re-key the token bucket deferred: retried each round.
                    let _ = inner.rekey(ports, server, events);
                } else {
                    // No longer a rotator (demoted): nothing of ours waits.
                    inner.join_waiting.remove(&server);
                }
                // M2: someone came online or went offline (members only).
                if inner.db.has_server(server)? && inner.presence_changed(server, ports.clock.now_ms())? && !changed {
                    let view = inner.view(server)?;
                    events.push(Event::MembersChanged {
                        server_id: model::hex_id(server.as_bytes()),
                        members: inner.members_json(&view)?,
                    });
                }
            }
            // Messages held for their key: sent now if it came.
            inner.send_key_pending(ports, events)
        })
    }

    /// `blockUser`: a toggle, kept as it was for older shells. G-47's
    /// [`Core::set_blocked`] is the idempotent form.
    pub fn block_user(&self, user_id: &str) -> CoreResult<()> {
        let user = parse_user(user_id)?;
        self.run(|inner, _, events| {
            let blocked = !inner.db.is_blocked(&user)?;
            inner.set_blocked(user, blocked, events)
        })
    }

    // ---- birth date (G-77, B7 §2) -------------------------------------------

    /// `previewBirthDateCorrection(date)`: what [`Core::correct_birth_date`]
    /// would do. Changes nothing. `bad-request` for a date that isn't a real
    /// `YYYY-MM-DD` from 1900 to today.
    pub fn preview_birth_date_correction(&self, date: &str) -> CoreResult<AgeCorrectionPreview> {
        let now = self.ports.clock.now_ms();
        self.lock().age_correction(date, now)
    }

    /// `correctBirthDate(date)`, by date against my current birth date:
    /// - **same** (the identical date): a waiting correction is dropped;
    /// - **lower** (a later date): at once. The new claim goes to every
    ///   server I'm in; an 18+ server I'm no longer old enough for is left
    ///   (`server.removed`, `reason: 'age'`, `required`); elsewhere its 18+
    ///   channels go (`channel.removed`, `reason: 'age'`). A waiting restore
    ///   cap stays. Refused (`owns-restricted-server`, `servers`) while I
    ///   own a server whose restriction is above the new age (PO);
    /// - **raise** (an earlier date): pending for 30 days
    ///   (`Identity.pendingBirthDate`); a new correction replaces it;
    /// - **under 16:** `too-young`, nothing changed.
    ///
    /// `identity.changed` follows any change. Same and lower never make the
    /// date "the one my claims come from" (a restored date stays untrusted,
    /// so a date a day short of 18 still waits 30 days after turning 18); a
    /// raise does once it settles, having waited its own 30 days.
    pub fn correct_birth_date(&self, date: &str) -> CoreResult<AgeCorrectionPreview> {
        let preview = self.run(|inner, ports, events| {
            let now = ports.clock.now_ms();
            let preview = inner.age_correction(date, now)?;
            match preview.kind {
                AgeCorrectionKind::TooYoung => return Err(ErrorCode::TooYoung.into()),
                AgeCorrectionKind::OwnsRestrictedServer => {
                    return Err(CoreError {
                        code: ErrorCode::OwnsRestrictedServer,
                        positions: None,
                        servers: Some(preview.blocked_by.iter().map(|s| s.name.clone()).collect()),
                    });
                }
                kind => {
                    let effective_at = preview.effective_at.unwrap_or(0);
                    inner.update_profile_with(|p| p.correct(kind, date, effective_at, now))?;
                    if kind == AgeCorrectionKind::Lower {
                        inner.apply_lowered_age(ports, now, events)?;
                    }
                }
            }
            let identity = inner.identity_json(inner.me.as_ref().ok_or(ErrorCode::NotFound)?)?;
            events.push(Event::IdentityChanged(identity));
            Ok(preview)
        })?;
        self.flush_leaves();
        Ok(preview)
    }

    /// `cancelBirthDateCorrection()`: drops a waiting correction. A raise
    /// found after a restore (not a correction) can't be cancelled: there's
    /// no earlier date to go back to (`not-allowed`). Nothing waiting: `ok`.
    pub fn cancel_birth_date_correction(&self) -> CoreResult<()> {
        self.run(|inner, _, events| {
            let me = inner.me.as_ref().ok_or(ErrorCode::NotFound)?;
            let pending = me.profile.pending_birth_date.as_ref().map(|p| (p.correction, p.capped, p.effective_at));
            match pending {
                None => return Ok(()),
                Some((false, _, _)) => return Err(ErrorCode::NotAllowed.into()),
                Some((true, true, effective_at)) => {
                    // The restore-form wait goes on, for the date it had.
                    inner.update_profile_with(|p| {
                        let date = p.birth_date.clone();
                        p.pending_birth_date =
                            Some(PendingBirth { date, effective_at, correction: false, capped: false });
                    })?;
                }
                Some(_) => inner.update_profile_with(|p| p.pending_birth_date = None)?,
            }
            let identity = inner.identity_json(inner.me.as_ref().ok_or(ErrorCode::NotFound)?)?;
            events.push(Event::IdentityChanged(identity));
            Ok(())
        })
    }

    /// G-47 `setBlocked(userId, blocked)`: idempotent; setting what's
    /// already set changes nothing and sends no event. Blocking myself is
    /// `bad-request`.
    pub fn set_blocked(&self, user_id: &str, blocked: bool) -> CoreResult<()> {
        let user = parse_user(user_id)?;
        self.run(|inner, _, events| inner.set_blocked(user, blocked, events))
    }

    /// G-47 `listBlocked()`: everyone I blocked, also those I share no
    /// server with now, ordered by key.
    pub fn list_blocked(&self) -> CoreResult<Vec<BlockedUser>> {
        self.lock().blocked_list()
    }

    // ---- app --------------------------------------------------------------

    pub fn get_storage_usage(&self) -> CoreResult<StorageUsage> {
        let inner = self.lock();
        let used = inner.db.size_bytes()?;
        let limit = inner
            .db
            .get(KV_STORAGE_LIMIT)?
            .and_then(|v| v.try_into().ok())
            .map(u64::from_le_bytes)
            .unwrap_or(DEFAULT_STORAGE_LIMIT);
        Ok(StorageUsage {
            used_bytes: used,
            limit_bytes: limit,
            messages_bytes: used,
            files_bytes: 0,
        })
    }

    pub fn set_storage_limit(&self, bytes: u64) -> CoreResult<()> {
        self.lock().db.set(KV_STORAGE_LIMIT, &bytes.to_le_bytes())
    }

    pub fn clear_cache(&self) -> CoreResult<()> {
        Ok(())
    }

    /// For bug reports: counts and versions only, never words, keys, names
    /// or the birth date.
    pub fn export_diagnostics(&self) -> CoreResult<String> {
        let info = self.get_app_info()?;
        let inner = self.lock();
        let report = serde_json::json!({
            "app": info,
            "exportedAtMs": self.ports.clock.now_ms(),
            "hasIdentity": inner.me.is_some(),
            "servers": inner.db.servers()?.len(),
            "storageBytes": inner.db.size_bytes()?,
        });
        Ok(serde_json::to_string_pretty(&report).expect("json value"))
    }

    pub fn get_app_info(&self) -> CoreResult<AppInfo> {
        let channel = match self.lock().db.get(KV_UPDATE_CHANNEL)?.as_deref() {
            Some(b"beta") => UpdateChannel::Beta,
            _ => UpdateChannel::Stable,
        };
        let relay_only = relay_only_in(&self.lock().db)?;
        Ok(AppInfo { version: self.app_version.clone(), update_channel: channel, relay_only })
    }

    /// `setRelayOnly(on)` (GAP-6r): stored, then applied to the network. On
    /// ends my call first (its media would go direct) and refuses calls
    /// until it's off. Each of my servers gets a `voice.rooms` with the new
    /// `relayOnly` at the next tick. Needs no identity.
    pub fn set_relay_only(&self, on: bool) -> CoreResult<()> {
        if on {
            self.lock().calls.set_relay_only(true);
            self.leave_call()?;
        }
        self.run(|inner, ports, _| {
            inner.db.set(KV_RELAY_ONLY, &[u8::from(on)])?;
            inner.calls.set_relay_only(on);
            for server in inner.db.servers()? {
                inner.calls.mark_dirty(server);
            }
            ports.network.set_relay_only(on);
            Ok(())
        })
    }

    /// Member relays (#368, slice 1): the setting and what it comes to now.
    pub fn get_member_relay(&self) -> CoreResult<MemberRelay> {
        let now = self.ports.clock.now_ms();
        self.lock().member_relay_now(now)
    }

    /// `auto`, `on` or `off`; a forced-off reason still wins.
    pub fn set_member_relay(&self, setting: MemberRelaySetting) -> CoreResult<MemberRelay> {
        self.run(|inner, ports, _| {
            let value: &[u8] = match setting {
                MemberRelaySetting::Auto => b"auto",
                MemberRelaySetting::On => b"on",
                MemberRelaySetting::Off => b"off",
            };
            inner.db.set(KV_MEMBER_RELAY, value)?;
            inner.member_relay_now(ports.clock.now_ms())
        })
    }

    /// The daily cap in MB, [`MEMBER_RELAY_CAP_MB`], else `bad-request`.
    pub fn set_member_relay_cap(&self, mb: u32) -> CoreResult<MemberRelay> {
        if !MEMBER_RELAY_CAP_MB.contains(&mb) {
            return Err(ErrorCode::BadRequest.into());
        }
        self.run(|inner, ports, _| {
            inner.db.set(KV_MEMBER_RELAY_CAP, &mb.to_le_bytes())?;
            inner.member_relay_now(ports.clock.now_ms())
        })
    }

    /// Slice 3a: the desktop shell's metered-connection flag (shell only,
    /// never the page). Kept in memory; forces member relaying off with
    /// reason `metered` while set.
    pub fn set_metered(&self, metered: bool) -> CoreResult<()> {
        self.run(|inner, _, _| {
            inner.metered = metered;
            Ok(())
        })
    }

    /// The one-time disclosure was shown and acknowledged.
    pub fn mark_member_relay_disclosure_seen(&self) -> CoreResult<()> {
        self.run(|inner, _, _| inner.db.set(KV_MEMBER_RELAY_SEEN, &[1]))
    }

    // ---- device link (`device-link-slice.md`) ----------------------------

    /// New device: a one-time key, a code and a QR, served for 5 minutes.
    /// Replaces any earlier link. `not-allowed` once signed in; `offline`
    /// without a relay reservation yet.
    pub fn start_device_link(&self) -> CoreResult<DeviceLinkStart> {
        self.run(|inner, ports, events| {
            if inner.me.is_some() {
                return Err(ErrorCode::NotAllowed.into());
            }
            ports.network.device_link_close();
            inner.device_link = None;
            let key = OneTimeKey::generate();
            let code = devicelink::new_code();
            let rv = devicelink::rendezvous(&code).expect("a fresh code is valid");
            let addr = ports.network.device_link_open(rv, key.public).ok_or(ErrorCode::Offline)?;
            let qr = devicelink::qr(&key.public, &addr);
            if qr.len() > devicelink::MAX_QR {
                ports.network.device_link_close();
                return Err(ErrorCode::Internal.into());
            }
            let expires_at = ports.clock.now_ms() + devicelink::LINK_TTL_MS;
            inner.device_link = Some(NewLink { key, expires_at, old_pub: None, confirmed: false, held: None });
            events.push(link_state(DeviceLinkPhase::Waiting, None, None));
            Ok(DeviceLinkStart { qr, code, expires_at })
        })
    }

    /// New device: ends the link (`failed`, `cancelled`). Nothing to cancel
    /// is fine.
    pub fn cancel_device_link(&self) -> CoreResult<()> {
        self.run(|inner, ports, events| {
            if inner.device_link.take().is_some() {
                ports.network.device_link_close();
                events.push(link_state(DeviceLinkPhase::Failed, None, Some(DeviceLinkReason::Cancelled)));
            }
            Ok(())
        })
    }

    /// New device, each sync round (and on the network's wake-up): the
    /// approving device's Hello shows the digits (`confirm`); its sealed
    /// account is opened and held until my user confirms the digits
    /// (`confirmDeviceLink`), then restored (`done`, then
    /// `identity.changed`); a link past its 5 minutes ends (`expired`).
    pub fn poll_device_link(&self) {
        let mut events = Vec::new();
        let payload = {
            let mut inner = self.lock();
            let Some(link) = inner.device_link.as_mut() else { return };
            let mut end = None;
            for inbound in self.ports.network.device_link_take() {
                match inbound {
                    DeviceLinkInbound::Hello { e_old_pub } if link.old_pub.is_none() => {
                        link.old_pub = Some(e_old_pub);
                        let sas = devicelink::sas(&link.key.public, &e_old_pub);
                        events.push(link_state(DeviceLinkPhase::Confirm, Some(sas), None));
                    }
                    DeviceLinkInbound::Sealed { ciphertext } => {
                        let opened = link.old_pub.and_then(|old| {
                            let key = link.key.transfer_key(&old, &link.key.public, &old)?;
                            devicelink::open(&key, &ciphertext)
                        });
                        match opened {
                            Some(p) => link.held = Some(p),
                            None => end = Some((DeviceLinkPhase::Failed, DeviceLinkReason::Refused)),
                        }
                        // The network takes one transfer per link.
                        self.ports.network.device_link_close();
                        break;
                    }
                    DeviceLinkInbound::Hello { .. } => {}
                }
            }
            let ready = link.confirmed && link.held.is_some();
            if !ready && end.is_none() && self.ports.clock.now_ms() >= link.expires_at {
                end = Some((DeviceLinkPhase::Expired, DeviceLinkReason::Timeout));
            }
            if let Some((phase, reason)) = end {
                // One use: the keys and anything held are wiped.
                inner.device_link = None;
                self.ports.network.device_link_close();
                events.push(link_state(phase, None, Some(reason)));
                None
            } else if ready {
                inner.device_link.take().and_then(|mut link| link.held.take())
            } else {
                None
            }
        };
        self.emit(events);
        if let Some(payload) = payload {
            self.apply_link(payload);
        }
    }

    /// New device: my user compared the digits with the approving device's.
    /// `true` lets the account be applied (now, if it has arrived, else when
    /// it does); `false` ends the link (`failed`, `refused`) and wipes
    /// anything held. Nothing is applied before `true`: whoever got to the
    /// link first may not be my device (Security Lead on #394).
    /// `not-found` with no link; `bad-request` before the digits are shown.
    pub fn confirm_device_link(&self, matches: bool) -> CoreResult<()> {
        let payload = {
            let mut inner = self.lock();
            let link = inner.device_link.as_mut().ok_or(ErrorCode::NotFound)?;
            if link.old_pub.is_none() {
                return Err(ErrorCode::BadRequest.into());
            }
            if !matches {
                inner.device_link = None;
                self.ports.network.device_link_close();
                drop(inner);
                self.emit(vec![link_state(DeviceLinkPhase::Failed, None, Some(DeviceLinkReason::Refused))]);
                return Ok(());
            }
            link.confirmed = true;
            match link.held.is_some() {
                true => inner.device_link.take().and_then(|mut link| link.held.take()),
                false => None,
            }
        };
        if let Some(payload) = payload {
            self.apply_link(payload);
        }
        Ok(())
    }

    /// New device: the account, through `restoreIdentity`'s path. The same
    /// identity and person: the age isn't asked again, and the birth date
    /// stays as trusted as it was (#306).
    fn apply_link(&self, payload: devicelink::Payload) {
        let profile = Profile {
            display_name: payload.profile.display_name.clone(),
            avatar_small: payload.profile.avatar_small.clone().filter(|a| avatar::valid_avatar(a)),
            color: payload.profile.color.clone().filter(|c| avatar::valid_color(c)),
            birth_date: payload.birth_date.clone(),
            birth_date_trusted: payload.birth_date_trusted,
            country: payload.country.clone(),
            ..Profile::default()
        };
        let done = match self.restore_with_profile(&payload.seed, profile) {
            Ok(identity) => vec![link_state(DeviceLinkPhase::Done, None, None), Event::IdentityChanged(identity)],
            Err(e) => {
                eprintln!("mvs-core: a device link's account wasn't restored: {:?}", e.code);
                let reason = match e.code {
                    ErrorCode::KeyringUnavailable => DeviceLinkReason::Keyring,
                    _ => DeviceLinkReason::Restore,
                };
                vec![link_state(DeviceLinkPhase::Failed, None, Some(reason))]
            }
        };
        self.emit(done);
    }

    /// Signed-in device: reaches the link in `qr_or_code` and returns the
    /// digits to compare. `bad-request` for neither a QR nor a code;
    /// `not-found` for no such link (or expired, or another device's
    /// session); `locked-out` when another device's Hello holds the link;
    /// `rate-limited` after 3 attempts at one link; `offline`.
    pub fn begin_device_approval(&self, qr_or_code: &str) -> CoreResult<DeviceApproval> {
        let target = Target::parse(qr_or_code).ok_or(ErrorCode::BadRequest)?;
        let id = target.link_id();
        let now = self.ports.clock.now_ms();
        let old_pub = {
            let mut inner = self.lock();
            if inner.me.is_none() {
                return Err(ErrorCode::NotAllowed.into());
            }
            inner.approving = None;
            // Expired approvals go (Tech Lead on #393).
            inner.approvals.retain(|_, a| now < a.expires_at);
            let approval = inner.approvals.entry(id).or_insert_with(|| Approval {
                key: OneTimeKey::generate(),
                attempts: 0,
                link: None,
                expires_at: now + devicelink::LINK_TTL_MS,
            });
            if approval.attempts >= devicelink::MAX_ATTEMPTS {
                return Err(ErrorCode::RateLimited.into());
            }
            approval.attempts += 1;
            approval.key.public
        };
        // The network, outside the lock (a lookup can take seconds).
        let net = &self.ports.network;
        let addr = match &target {
            Target::Qr { addr, .. } => addr.clone(),
            Target::Code { rendezvous } => net.device_link_find(*rendezvous).map_err(link_error)?,
        };
        let new_pub = net.device_link_hello(&addr, old_pub).map_err(link_error)?;
        if matches!(&target, Target::Qr { new_pub: qr_pub, .. } if *qr_pub != new_pub) {
            return Err(ErrorCode::NotFound.into());
        }
        let mut inner = self.lock();
        let approval = inner.approvals.get_mut(&id).ok_or(ErrorCode::NotFound)?;
        approval.link = Some((addr, new_pub));
        approval.expires_at = now + devicelink::LINK_TTL_MS;
        let expires_at = approval.expires_at;
        inner.approving = Some(id);
        Ok(DeviceApproval { sas: devicelink::sas(&new_pub, &old_pub), expires_at })
    }

    /// Signed-in device: the user compared the digits. `true` sends my
    /// account, sealed, and shows "a new device was added"; `false` ends
    /// this attempt. `bad-request` with no approval in progress; `not-found`
    /// once it expired.
    pub fn confirm_device_approval(&self, approve: bool) -> CoreResult<()> {
        let now = self.ports.clock.now_ms();
        let (addr, sealed) = {
            let mut inner = self.lock();
            let id = inner.approving.take().ok_or(ErrorCode::BadRequest)?;
            let approval = inner.approvals.get(&id).ok_or(ErrorCode::BadRequest)?;
            let Some((addr, new_pub)) = approval.link.clone() else {
                return Err(ErrorCode::BadRequest.into());
            };
            if now >= approval.expires_at {
                inner.approvals.remove(&id);
                return Err(ErrorCode::NotFound.into());
            }
            if !approve {
                return Ok(());
            }
            let old_pub = approval.key.public;
            let key = approval.key.transfer_key(&new_pub, &new_pub, &old_pub).ok_or(ErrorCode::NotFound)?;
            let payload = inner.link_payload()?;
            let sealed = devicelink::seal(&key, &payload);
            // One use: this link's key is wiped.
            inner.approvals.remove(&id);
            (addr, sealed)
        };
        self.ports.network.device_link_send(&addr, &sealed).map_err(link_error)?;
        // TODO(device link): the notice to my other devices goes on the
        // backup-store notice path once holders keep one (dev-sync).
        // Kept until acknowledged, and announced now.
        {
            let inner = self.lock();
            let mut notices = device_notices(&inner.db)?;
            notices.push(now);
            // The newest MAX_DEVICE_NOTICES only (Tech Lead on #415).
            let extra = notices.len().saturating_sub(MAX_DEVICE_NOTICES);
            notices.drain(..extra);
            inner.db.set(KV_DEVICE_NOTICES, &serde_json::to_vec(&notices).expect("plain list"))?;
        }
        self.emit(vec![Event::DeviceAdded { at: now, label: notice_label(None) }]);
        Ok(())
    }

    /// Device link: the user saw the "a new device was added" notice with
    /// this `at`; it isn't announced again. An unknown `at` is fine.
    pub fn ack_device_notice(&self, at: u64) -> CoreResult<()> {
        let inner = self.lock();
        let mut notices = device_notices(&inner.db)?;
        notices.retain(|n| *n != at);
        inner.db.set(KV_DEVICE_NOTICES, &serde_json::to_vec(&notices).expect("plain list"))
    }

    /// Device link: once per start (the first sync round, when the UI is
    /// up), every notice not yet acknowledged.
    fn announce_device_notices(&self) {
        if self.notices_announced.swap(true, Ordering::SeqCst) {
            return;
        }
        let notices = device_notices(&self.lock().db).unwrap_or_default();
        self.emit(notices.into_iter().map(|at| Event::DeviceAdded { at, label: notice_label(None) }).collect());
    }

    pub fn set_update_channel(&self, channel: UpdateChannel) -> CoreResult<()> {
        let value: &[u8] = match channel {
            UpdateChannel::Stable => b"stable",
            UpdateChannel::Beta => b"beta",
        };
        self.lock().db.set(KV_UPDATE_CHANNEL, value)?;
        // A new channel is checked now, not in 6 hours.
        if let Some(updates) = &self.updates {
            updates.wake();
        }
        Ok(())
    }

    /// Turns in-app update on (B8-5): `mvs-core --update-root`. Without
    /// it the update commands answer `not-implemented` and no check runs.
    pub fn with_updates(mut self, updates: Updates) -> Core {
        self.updates = Some(Arc::new(updates));
        self
    }

    fn updates(&self) -> CoreResult<&Updates> {
        self.updates.as_deref().ok_or_else(|| ErrorCode::NotImplemented.into())
    }

    fn ui_channel(&self) -> CoreResult<UpdateChannel> {
        Ok(self.get_app_info()?.update_channel)
    }

    fn now_secs(&self) -> u64 {
        self.ports.clock.now_ms() / 1000
    }

    fn emit_update(&self, events: Vec<UpdateEvent>) {
        self.emit(events.into_iter().map(update_event).collect());
    }

    /// `checkForUpdate` (main/core only, A2).
    pub fn check_for_update(&self) -> CoreResult<serde_json::Value> {
        self.updates()?.check(self.ui_channel()?, self.now_secs())
    }

    /// `downloadUpdate` (main/core only): emits `update.ready` once staged.
    pub fn download_update(&self) -> CoreResult<serde_json::Value> {
        let outcome = self.updates()?.download(self.ui_channel()?, self.now_secs())?;
        self.emit_update(outcome.events);
        Ok(outcome.ok)
    }

    /// `applyUpdate` (main/core only): `not-allowed` during a call.
    pub fn apply_update(&self) -> CoreResult<serde_json::Value> {
        self.updates()?.apply(self.ui_channel()?, self.in_call())
    }

    /// `markHealthy` (main only): commits a trial version; `update.installed`
    /// carries the notes in the profile's language.
    pub fn mark_healthy(&self) -> CoreResult<serde_json::Value> {
        let updates = self.updates()?;
        let lang = match self.lock().me.as_ref().and_then(|me| me.profile.locale) {
            Some(Locale::En) => "en",
            _ => "he",
        };
        let outcome = updates.mark_healthy(self.ui_channel()?, lang)?;
        self.emit_update(outcome.events);
        Ok(outcome.ok)
    }

    /// The background check: once the UI is up (or after a fallback wait),
    /// then every hour ± 5 min, and at once after a channel switch. Downloads
    /// whatever is available; the apply waits for the user (or next start).
    /// Returns when `Updates::stop` is called; without updates, at once.
    pub fn run_update_loop(&self) {
        let Some(updates) = &self.updates else { return };
        if !updates.wait(crate::update::FIRST_CHECK_AFTER) {
            return;
        }
        loop {
            if let Ok(channel) = self.ui_channel() {
                self.emit_update(updates.background_round(channel, self.now_secs()));
                // Slice 3b: the owner's signed global switch, fetched with the
                // check. Kept in kv; only this path writes it.
                let off = updates.member_relay_off(channel);
                let mut events = Vec::new();
                {
                    let mut inner = self.lock();
                    let value: &[u8] = if off { b"1" } else { b"0" };
                    if inner.db.get(KV_MEMBER_RELAY_GLOBAL_OFF).ok().flatten().as_deref() != Some(value) {
                        if let Err(e) = inner.db.set(KV_MEMBER_RELAY_GLOBAL_OFF, value) {
                            eprintln!("mvs-core: the global member relay flag wasn't stored: {:?}", e.code);
                        }
                    }
                    inner.check_member_relay(&self.ports, &mut events);
                }
                self.emit(events);
            }
            if !updates.wait(crate::update::next_interval()) {
                return;
            }
        }
    }

    /// Ends `run_update_loop` (stdin closed).
    pub fn stop_updates(&self) {
        if let Some(updates) = &self.updates {
            updates.stop();
        }
    }
}

fn update_event(e: UpdateEvent) -> Event {
    match e {
        UpdateEvent::Ready { version, waiting_for_call } => {
            Event::UpdateReady(UpdateInfo { version: version.to_string(), waiting_for_call })
        }
        UpdateEvent::Installed { version, notes } => {
            Event::UpdateInstalled { version: version.to_string(), notes }
        }
        UpdateEvent::RolledBack { failed, running } => {
            Event::UpdateRolledBack { failed: failed.to_string(), running: running.to_string() }
        }
    }
}

impl voice::Members for Inner {
    /// A server of mine whose genesis is accepted (its ID checked against
    /// it), a member, not kicked. No 18+ gate: rooms aren't channel records.
    /// (The room's ID derives from the server: `voice` checks that.)
    fn may_call(&mut self, who: PublicKey, server: ServerId) -> bool {
        let mine = self.db.servers().is_ok_and(|servers| servers.contains(&server));
        if !mine || self.load(server).is_err() || self.view(server).is_err() {
            return false;
        }
        let state = self.logs[&server].resolver.state();
        state.members.contains(&who) && !state.kicked.contains(&who)
    }

    fn is_owner(&mut self, who: PublicKey, server: ServerId) -> bool {
        self.load(server).is_ok() && self.view(server).is_ok_and(|view| view.owner == who)
    }

    fn audience(&mut self, server: ServerId) -> Vec<PublicKey> {
        if self.load(server).is_err() {
            return Vec::new();
        }
        let me = self.me.as_ref().map(Me::key);
        let online = self.net.online(server);
        let state = self.logs[&server].resolver.state();
        state
            .members
            .iter()
            .filter(|key| Some(**key) != me && !state.kicked.contains(key))
            .filter(|key| online.as_ref().is_none_or(|online| online.contains(key)))
            .copied()
            .collect()
    }
}

impl Inner {
    /// Whether the online members of `server` changed since last reported
    /// (and remembers the new set). Members only: authority's, not kicked.
    fn presence_changed(&mut self, server: ServerId, now: u64) -> CoreResult<bool> {
        let view = self.view(server)?;
        let mut reach = self.net.presence(server).unwrap_or_default();
        let member = |key: &PublicKey| view.state.members.contains(key) && !view.is_kicked(key);
        reach.online.retain(member);
        reach.direct.retain(|key| reach.online.contains(key));
        for key in &reach.online {
            self.member_seen.insert(*key, now);
        }
        Ok(self.presence_seen.insert(server, reach.clone()) != Some(reach))
    }

    /// Whether we are a moderator or above in a loaded server.
    fn may_rotate(&self, server: ServerId) -> CoreResult<bool> {
        let Some(me) = self.me.as_ref().map(Me::key) else { return Ok(false) };
        Ok(self.view(server)?.state.role(me) >= authority::Role::Moderator)
    }

    /// The known channels this identity may read and write: 18+ channels
    /// only with an accepted 18+ claim (B7).
    fn visible(&self, server: ServerId) -> CoreResult<BTreeSet<ChannelId>> {
        let me = self.me.as_ref().map(Me::key);
        let state = self.logs.get(&server).ok_or(ErrorCode::Internal)?.resolver.state();
        let adult = me.is_some_and(|me| state.adults.contains(&me));
        let mut visible = self.known(server)?;
        visible.retain(|c| adult || !state.channels.get(c).is_some_and(|c| c.adult));
        Ok(visible)
    }

    /// Our age claim for `server` (B7): 18+ or not, from the sealed birth
    /// date, which never leaves this device. A restored identity has no
    /// birth date yet and claims "not 18+".
    /// The age claim to post in `server` now, if any (decision 18, B13 §3,
    /// B7 §9), from my latest accepted claim there:
    /// - a raise ("not adult" there, adult by my birth date) that hasn't
    ///   taken effect yet posts nothing and starts its 30 days
    ///   (`pendingBirthDate`); until then I count as under 18;
    /// - a lowering, or a first claim, is posted at once;
    /// - the same as my current claim: nothing.
    ///
    /// So a restore (a birth date entered again) can't skip the 30 days, while
    /// turning 18 with the date my claims came from (`birth_date_trusted`:
    /// set at sign-up here) is just a birthday, with no wait.
    fn age_claim(&mut self, ports: &Ports, server: ServerId) -> CoreResult<Option<Record>> {
        let now = ports.clock.now_ms();
        self.settle_birth_date(now)?;
        let mut trust = false;
        let (prior, adult, raise, pending) = {
            let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
            let key = me.key();
            let view = self.view(server)?;
            let claimed =
                view.records.iter().any(|r| r.kind() == Kind::AgeClaim && r.author() == key);
            let prior = claimed.then(|| view.state.adults.contains(&key));
            let profile = &me.profile;
            let by_date = model::age_on(&profile.birth_date, now).is_some_and(|age| age >= 18);
            let pending = profile.raise_pending(now);
            // A raise is a *changed* date (a restore entered it again): with
            // the date my claims came from, turning 18 is just a birthday.
            let raise = prior == Some(false) && by_date && !pending && !profile.birth_date_trusted;
            // Only an *adult* agreement (a server already holds "adult" and
            // the date says adult) makes a restored date the one my claims
            // come from. A "not adult" agreement proves nothing: a date a day
            // short of 18 would agree, then skip the wait the next day
            // (Security Lead). Nor does a server with no claim.
            let agrees =
                !profile.birth_date_trusted && !pending && prior == Some(true) && by_date;
            if agrees {
                trust = true;
            }
            (prior, profile.effective_age(now).is_some_and(|age| age >= 18), raise, pending)
        };
        if trust {
            self.update_profile_with(|p| p.birth_date_trusted = true)?;
        }
        if raise {
            let date = self.me.as_ref().expect("checked above").profile.birth_date.clone();
            self.update_profile_with(|p| {
                p.pending_birth_date =
                    Some(PendingBirth { date, effective_at: now + AGE_RAISE_DELAY_MS, correction: false, capped: false });
            })?;
            return Ok(None);
        }
        // Nothing new to say; and while a raise waits, a server that already
        // holds "adult" keeps it (no lowering from the wait itself).
        if prior == Some(adult) || (prior == Some(true) && pending) {
            return Ok(None);
        }
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let key = me.key();
        let view = self.view(server)?;
        let record = authority::sign_control(
            me.identity.signing_key(),
            server,
            view.next_seq(&key),
            view.deps(None),
            now,
            &Action::AgeClaim { adult },
        )
        .map_err(|_| CoreError::from(ErrorCode::BadRequest))?;
        Ok(Some(record))
    }

    /// Changes my stored profile and saves it (sealed).
    fn update_profile_with(&mut self, change: impl FnOnce(&mut Profile)) -> CoreResult<()> {
        let me = self.me.as_mut().ok_or(ErrorCode::NotFound)?;
        change(&mut me.profile);
        let key = *me.identity.storage_key().expose_secret();
        let json = serde_json::to_vec(&me.profile).expect("plain struct");
        self.db.save_profile(&key, &json)
    }

    /// A pending raise whose 30 days are up takes effect (and is saved).
    /// True if it did.
    fn settle_birth_date(&mut self, now: u64) -> CoreResult<bool> {
        let due = self.me.as_ref().is_some_and(|me| {
            me.profile.pending_birth_date.as_ref().is_some_and(|p| now >= p.effective_at)
        });
        if due {
            self.update_profile_with(|p| {
                p.settle(now);
            })?;
        }
        Ok(due)
    }

    /// My servers for the backup: server ID (hex) to sync secret (hex), not
    /// closed.
    fn backup_set(&self) -> CoreResult<BTreeMap<String, String>> {
        let mut current = BTreeMap::new();
        for server in self.db.servers()? {
            if self.db.closed_at(server)?.is_some() {
                continue;
            }
            if let Some(secret) = self.secret(server)? {
                current.insert(model::hex_id(server.as_bytes()), hex::encode(*secret));
            }
        }
        Ok(current)
    }

    fn backup_fingerprint(current: &BTreeMap<String, String>) -> Vec<u8> {
        let json = serde_json::to_vec(current).expect("plain map");
        blake3::derive_key("mvs/backup-written/v1", &json).to_vec()
    }

    /// Restore servers (#291 phase A, Tech Lead on #317): a write is due
    /// only when my server set changed since the last one, on the first
    /// round after start (`login`), or [`BACKUP_REPUBLISH_MS`] after the
    /// last. Otherwise a round fetches and puts nothing.
    fn backup_due(&self, now: u64, login: bool) -> CoreResult<bool> {
        if self.me.is_none() {
            return Ok(false);
        }
        let changed = self.db.get(KV_BACKUP_WRITTEN)?.as_deref()
            != Some(Self::backup_fingerprint(&self.backup_set()?).as_slice());
        let last = self
            .db
            .get(KV_BACKUP_PUT_AT)?
            .and_then(|v| v.try_into().ok())
            .map(u64::from_le_bytes)
            .unwrap_or(0);
        Ok(login || changed || now.saturating_sub(last) >= BACKUP_REPUBLISH_MS)
    }

    /// My server list merged into the newest of `answers` (fetched outside
    /// the lock): servers I'm in are live; servers this device listed
    /// before and no longer has (left, kicked, closed, purged) get a
    /// tombstone; what my other devices wrote is kept. Sealed as the next
    /// version, to be put outside the lock. `None`: nothing to back up.
    fn backup_merge(&mut self, now: u64, answers: &[Vec<u8>]) -> CoreResult<Option<Vec<u8>>> {
        let Some(keys) = self.me.as_ref().map(|me| me.identity.backup_keys()) else {
            return Ok(None);
        };
        let mut known: BTreeMap<String, u64> = self
            .db
            .get(KV_BACKUP_KNOWN)?
            .and_then(|json| serde_json::from_slice(&json).ok())
            .unwrap_or_default();
        let current = self.backup_set()?;
        let remote = backup::newest(&keys, answers);
        if remote.is_none() && current.is_empty() && known.is_empty() {
            // Nothing to back up, and that's settled until my server set
            // changes or the republish is due. Without this, a new account
            // (or a restore whose backup isn't found yet) fetched on every
            // round: a real mailbox allows 60 fetches an hour (G-91).
            self.db.set(KV_BACKUP_WRITTEN, &Self::backup_fingerprint(&current))?;
            self.db.set(KV_BACKUP_PUT_AT, &now.to_le_bytes())?;
            return Ok(None);
        }
        let remote = remote.unwrap_or_default();
        let mut plain = remote.clone();
        for (id, secret) in &current {
            let joined_at = *known.entry(id.clone()).or_insert(now);
            let mut ours = backup::Plain::default();
            ours.servers.insert(id.clone(), backup::Entry { secret: secret.clone(), joined_at, gone_at: None });
            plain.merge(&ours);
        }
        for id in known.keys().filter(|id| !current.contains_key(*id)) {
            if let Some(entry) = plain.servers.get_mut(id) {
                if entry.live() {
                    entry.gone_at = Some(now.max(entry.joined_at + 1));
                }
            }
        }
        known.retain(|id, _| current.contains_key(id));
        plain.version = remote.version + 1;
        let blob = backup::seal(&keys, &plain).map_err(|_| ErrorCode::Internal)?;
        self.db.set(KV_BACKUP_KNOWN, &serde_json::to_vec(&known).expect("plain map"))?;
        self.db.set(KV_BACKUP_WRITTEN, &Self::backup_fingerprint(&current))?;
        self.db.set(KV_BACKUP_PUT_AT, &now.to_le_bytes())?;
        Ok(Some(blob))
    }

    /// G-91 phase B: my current backup buddies (identity keys).
    fn buddies(&self) -> CoreResult<Buddies> {
        Ok(self.db.get(KV_BACKUP_BUDDIES)?.and_then(|json| serde_json::from_slice(&json).ok()).unwrap_or_default())
    }

    /// G-91 phase B: every co-member as a buddy candidate, through each
    /// server I'm in (closed ones left out), with the last-seen times
    /// merged into the stored ones (and stored).
    fn buddy_candidates(&mut self, now: u64) -> CoreResult<Vec<recovery::Candidate>> {
        let me = self.me.as_ref().map(Me::key).ok_or(ErrorCode::NotFound)?;
        let mut seen: BTreeMap<String, u64> =
            self.db.get(KV_MEMBER_SEEN)?.and_then(|json| serde_json::from_slice(&json).ok()).unwrap_or_default();
        for (key, at) in self.member_seen.drain() {
            let entry = seen.entry(hex::encode(key.as_bytes())).or_insert(at);
            *entry = (*entry).max(at);
        }
        let mut out = Vec::new();
        let mut members = BTreeSet::new();
        for server in self.db.servers()? {
            if self.db.closed_at(server)?.is_some() {
                continue;
            }
            self.load(server)?;
            let view = self.view(server)?;
            if !view.state.is_member(me) {
                continue;
            }
            let since = view.member_since();
            let my_join = since.get(&me).copied().unwrap_or(0);
            let others = view.state.members.len().saturating_sub(1) as u32;
            for key in view.state.members.iter().filter(|k| **k != me && !view.is_kicked(k)) {
                members.insert(hex::encode(key.as_bytes()));
                out.push(recovery::Candidate {
                    member: *key.as_bytes(),
                    owner: *view.owner.as_bytes(),
                    adult: view.state.adults.contains(key),
                    current: true,
                    blocked: self.db.is_blocked(key)?,
                    mine: false,
                    last_seen: seen.get(&hex::encode(key.as_bytes())).copied().unwrap_or(0),
                    others_in_server: others,
                    shared_since: since.get(key).copied().unwrap_or(now).max(my_join),
                    my_join,
                });
            }
        }
        // Only co-members are kept; someone in no shared server is forgotten.
        seen.retain(|key, _| members.contains(key));
        self.db.set(KV_MEMBER_SEEN, &serde_json::to_vec(&seen).expect("plain map"))?;
        Ok(out)
    }

    /// G-91 phase B: checks my buddies and picks again when one is gone,
    /// two share an owner (at once), or (routine, at most daily) 2 or more
    /// are stale or there's room for more. A new set makes the next backup
    /// round write, so the new buddies get the current version. Returns
    /// whether the set changed.
    fn buddy_check(&mut self, now: u64) -> CoreResult<bool> {
        let candidates = self.buddy_candidates(now)?;
        let stored = self.buddies()?;
        let status: Vec<recovery::HolderStatus> = stored
            .list
            .iter()
            .filter_map(|b| {
                let member = model::parse_hex32(&b.member)?;
                let picked_through = model::parse_hex32(&b.owner)?;
                let rows: Vec<&recovery::Candidate> = candidates.iter().filter(|c| c.member == member).collect();
                let owner = if rows.iter().any(|c| c.owner == picked_through) {
                    picked_through
                } else {
                    rows.first().map_or(picked_through, |c| c.owner)
                };
                let last_seen = rows.first().map_or(0, |c| c.last_seen);
                Some(recovery::HolderStatus { member, owner, gone: rows.is_empty(), last_seen })
            })
            .collect();
        let fresh = recovery::pick_owner_groups(&candidates, now, BACKUP_BUDDIES, false);
        let routine = now.saturating_sub(stored.picked_at) >= recovery::RESHARE_GAP_MS;
        let repick = match recovery::reshare_reason(&status, fresh.len(), stored.picked_at, now) {
            Some(_) => true,
            // The first pick, or room for more buddies than I have.
            None => (status.is_empty() || routine) && fresh.len() > status.len(),
        };
        if !repick || fresh.iter().map(|p| p.member).eq(status.iter().map(|s| s.member)) {
            return Ok(false);
        }
        let list = fresh
            .iter()
            .map(|p| Buddy { member: hex::encode(p.member), owner: hex::encode(p.owner) })
            .collect();
        self.db.set(KV_BACKUP_BUDDIES, &serde_json::to_vec(&Buddies { picked_at: now, list }).expect("plain struct"))?;
        // The next backup round writes, to the new buddies too.
        self.db.delete(KV_BACKUP_WRITTEN)?;
        Ok(true)
    }

    /// Each sync round: a raise whose 30 days are up takes effect, and its
    /// "adult" claim goes to every server I'm still in.
    fn apply_due_birth_date(&mut self, ports: &Ports, events: &mut Events) -> CoreResult<()> {
        if !self.settle_birth_date(ports.clock.now_ms())? {
            return Ok(());
        }
        let key = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        for server in self.db.servers()? {
            if self.db.closed_at(server)?.is_some() {
                continue;
            }
            self.load(server)?;
            if !self.view(server)?.state.is_member(key) {
                continue;
            }
            if let Some(claim) = self.age_claim(ports, server)? {
                self.store(server, claim.clone())?;
                ports.network.publish(&claim);
            }
        }
        let identity = self.identity_json(self.me.as_ref().expect("checked above"))?;
        events.push(Event::IdentityChanged(identity));
        Ok(())
    }

    /// G-77: what correcting my birth date to `date` would do at `now`, by
    /// date against my current birth date (a waiting raise counts as not
    /// yet).
    fn age_correction(&mut self, date: &str, now: u64) -> CoreResult<AgeCorrectionPreview> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        if !model::valid_birth_date(date, now) {
            return Err(ErrorCode::BadRequest.into());
        }
        let new = model::age_on(date, now).ok_or(ErrorCode::BadRequest)?;
        let preview = |kind, effective_at| AgeCorrectionPreview {
            kind,
            effective_at,
            loses: Vec::new(),
            blocked_by: Vec::new(),
        };
        if new < 16 {
            return Ok(preview(AgeCorrectionKind::TooYoung, None));
        }
        // By date, not by whole years: an earlier date that leaves my age the
        // same today still makes me older sooner, so it's a raise and waits
        // (Tech Lead and Security Lead on #512). Valid dates compare as
        // strings.
        let key = me.key();
        let waiting = me.profile.pending_birth_date.as_ref().filter(|p| p.correction && now < p.effective_at);
        Ok(match date.cmp(me.profile.birth_date.as_str()) {
            std::cmp::Ordering::Equal => preview(AgeCorrectionKind::Same, None),
            // The same raise again keeps its clock.
            std::cmp::Ordering::Less if waiting.is_some_and(|p| p.date == date) => {
                preview(AgeCorrectionKind::Raise, waiting.map(|p| p.effective_at))
            }
            std::cmp::Ordering::Less => preview(AgeCorrectionKind::Raise, Some(now + AGE_RAISE_DELAY_MS)),
            std::cmp::Ordering::Greater => {
                let (loses, blocked_by) = self.age_losses(key, new)?;
                // PO: never below the restriction of a server I own.
                if blocked_by.is_empty() {
                    AgeCorrectionPreview { loses, ..preview(AgeCorrectionKind::Lower, None) }
                } else {
                    AgeCorrectionPreview { blocked_by, ..preview(AgeCorrectionKind::OwnsRestrictedServer, None) }
                }
            }
        })
    }

    /// G-77: what an age of `age` takes away: 18+ servers I'm a member of
    /// but don't own (whole), else the 18+ channels I see now. Second: the
    /// servers I own whose restriction is above `age` (they refuse it).
    fn age_losses(&mut self, key: PublicKey, age: u32) -> CoreResult<(Vec<AgeLoss>, Vec<AgeLoss>)> {
        let (mut out, mut owned) = (Vec::new(), Vec::new());
        for server in self.db.servers()? {
            if self.db.closed_at(server)?.is_some() {
                continue;
            }
            self.load(server)?;
            let view = self.view(server)?;
            if !view.state.is_member(key) {
                continue;
            }
            let server_id = model::hex_id(server.as_bytes());
            let name = view.state.server_name.clone().unwrap_or_else(|| view.genesis.name.clone());
            let owner = view.state.role(key) == authority::Role::Owner;
            if view.genesis.age_restriction.min_age() > age {
                let loss = AgeLoss { server_id, name, channel: None };
                if owner { owned.push(loss) } else { out.push(loss) }
            } else if age < 18 && view.state.adults.contains(&key) {
                let mut channels: Vec<String> =
                    view.state.channels.values().filter(|c| c.adult).map(|c| c.name.clone()).collect();
                channels.sort();
                for channel in channels {
                    out.push(AgeLoss { server_id: server_id.clone(), name: name.clone(), channel: Some(channel) });
                }
            }
        }
        Ok((out, owned))
    }

    /// G-77: after a lowering. The new claim goes to every server I'm in.
    /// An 18+ server I'm no longer old enough for, and don't own, is left:
    /// its `Leave` goes through the leave outbox, and it leaves this device
    /// (`server.removed`, `age`). Elsewhere, the 18+ channels I saw go
    /// (`channel.removed`, `age`).
    fn apply_lowered_age(&mut self, ports: &Ports, now: u64, events: &mut Events) -> CoreResult<()> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let (key, age) = (me.key(), me.profile.effective_age(now).unwrap_or(0));
        for server in self.db.servers()? {
            if self.db.closed_at(server)?.is_some() {
                continue;
            }
            self.load(server)?;
            let view = self.view(server)?;
            if !view.state.is_member(key) {
                continue;
            }
            let was_adult = view.state.adults.contains(&key);
            let leave = view.genesis.age_restriction.min_age() > age && view.state.role(key) != authority::Role::Owner;
            let adult_channels: Vec<(String, String)> = view
                .state
                .channels
                .iter()
                .filter(|(_, c)| c.adult)
                .map(|(id, c)| (model::hex_id(id.as_bytes()), c.name.clone()))
                .collect();
            if let Some(claim) = self.age_claim(ports, server)? {
                self.store(server, claim.clone())?;
                ports.network.publish(&claim);
            }
            if leave {
                let record = self.publish_control(ports, server, &Action::Leave { cut: Cut::default() })?;
                self.db.set_leave(server, &record)?;
                if self.cap_gate(server, model::SERVER_LIFECYCLE_CAP).is_ok() {
                    ports.network.publish(&record);
                }
                self.purge_server(ports, server, RemovedReason::Age, &[], true, events)?;
            } else if was_adult && age < 18 {
                let server_id = model::hex_id(server.as_bytes());
                for (channel_id, name) in adult_channels {
                    events.push(Event::ChannelRemoved {
                        server_id: server_id.clone(),
                        channel_id,
                        name,
                        reason: Some(ChannelRemovedReason::Age),
                    });
                }
            }
        }
        Ok(())
    }

    /// B6-p: every full record an accepted delete or edit replaced is pruned
    /// to its stub, in memory, in the store and in sync's store. Nothing of
    /// its body (the ciphertext) is kept; nothing of its text was ever
    /// stored.
    fn prune(&mut self, ports: &Ports, server: ServerId) -> CoreResult<()> {
        for channel in self.known(server)? {
            let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
            for id in chat::prunable(log, channel) {
                let log = self.logs.get_mut(&server).ok_or(ErrorCode::Internal)?;
                if let Some(stub) = log.prune(id) {
                    self.db.prune_record(&stub)?;
                    ports.network.prune(id);
                }
            }
        }
        Ok(())
    }

    /// This server's sync secret, from the sealed store.
    fn secret(&self, server: ServerId) -> CoreResult<Option<Zeroizing<[u8; 32]>>> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let key = *me.identity.storage_key().expose_secret();
        self.db.load_server_secret(&key, server)
    }

    fn save_secret(&self, server: ServerId, secret: &[u8; 32]) -> CoreResult<()> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let key = *me.identity.storage_key().expose_secret();
        self.db.save_server_secret(&key, server, secret)
    }

    /// T8-02: a short link for my new invite. A fresh k (kept sealed, S4),
    /// the envelope sealed under it, the publication signed by me (the
    /// invite's author, C1), stored and served and pushed to members.
    fn publish_invite(
        &mut self,
        ports: &Ports,
        server: ServerId,
        invite: RecordId,
        secret: &[u8; 32],
    ) -> CoreResult<Zeroizing<String>> {
        use crate::crypto::invite::{handle, seal, InvitePublication};
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let mut k = Zeroizing::new([0u8; crate::invite_link::KEY_LEN]);
        OsRng.fill_bytes(k.as_mut());
        let h = handle(&k);
        let envelope = seal(&k, &server, &invite, secret);
        let publication = InvitePublication::sign(me.identity.signing_key(), invite, h, envelope)
            .ok_or(ErrorCode::Internal)?;
        let storage = *me.identity.storage_key().expose_secret();
        self.db.save_invite_key(&storage, server, invite, &k)?;
        let bytes = publication.encode();
        self.db.put_invite_publication(server, invite, &bytes)?;
        ports.network.serve_invite(server, h, &bytes, true);
        Ok(crate::invite_link::encode_v1(&k, &server))
    }

    /// T8-02 (S1): serve the publications of `server`'s live invites, and
    /// drop and forget those whose invite died (revoked, expired, used up,
    /// author kicked). Run on every authority change: each sync round, and
    /// right after a revoke. Serving again is harmless (first wins).
    fn refresh_invites(&mut self, ports: &Ports, server: ServerId) -> CoreResult<()> {
        use crate::crypto::invite::InvitePublication;
        let now = ports.clock.now_ms();
        let held = self.db.invite_publications(server)?;
        // A closed server stays listed for 30 days, but none of its invites
        // is live: nobody can join it.
        let closed = self.db.closed_at(server)?.is_some();
        let view = self.view(server)?;
        let mut dead = Vec::new();
        for (invite, bytes) in held {
            let Some(publication) = InvitePublication::decode(&bytes) else {
                dead.push((invite, None));
                continue;
            };
            if !closed && view.live_invite_author(invite, now).is_some() {
                ports.network.serve_invite(server, *publication.handle(), &bytes, false);
            } else {
                dead.push((invite, Some(*publication.handle())));
            }
        }
        for (invite, handle) in dead {
            if let Some(handle) = handle {
                ports.network.drop_invite(handle);
            }
            self.db.delete_invite(server, invite)?;
        }
        Ok(())
    }

    /// T8-02 (C1): a publication a member pushed, kept and served only if
    /// it is for a live invite of a server I'm in and signed by that
    /// invite's author. Served without pushing it on (no loops); members
    /// that bind later get it from sync.
    fn accept_pushed_invite(&mut self, ports: &Ports, server: ServerId, bytes: &[u8]) -> CoreResult<()> {
        use crate::crypto::invite::InvitePublication;
        if !self.db.has_server(server)? || self.db.closed_at(server)?.is_some() {
            return Ok(());
        }
        let Some(publication) = InvitePublication::decode(bytes) else { return Ok(()) };
        let view = self.view(server)?;
        let Some(author) = view.live_invite_author(publication.invite(), ports.clock.now_ms()) else {
            return Ok(());
        };
        if !publication.verify(&author) {
            return Ok(());
        }
        if self.db.put_invite_publication(server, publication.invite(), bytes)? {
            ports.network.serve_invite(server, *publication.handle(), bytes, false);
        }
        Ok(())
    }

    fn summary(&self, server: ServerId) -> CoreResult<ServerSummary> {
        let me = self.me.as_ref().map(Me::key);
        let secret = self.secret(server)?;
        Ok(self.view(server)?.summary(me, secret.as_deref()))
    }

    /// The stored identity, opened, and every server opened for sync before
    /// any command can publish to it (GAP-4; the sync loop also reopens them
    /// each round).
    fn open_stored(&mut self, ports: &Ports) -> CoreResult<()> {
        let phrase = self.vault.open().map_err(vault_error)?;
        self.me = Some(self.load_me(phrase)?);
        unlock_cipher(ports, self.me.as_ref());
        for server in self.db.servers()? {
            self.load(server)?;
            self.open_sync(ports, server)?;
        }
        Ok(())
    }

    /// QA on 0.4.5: the keychain was unavailable at startup (a Secret
    /// Service that started after the core). Asks it again: still failing,
    /// `keyring-unavailable`; working now, the flag clears and a stored
    /// identity is opened as at startup.
    fn recheck_keyring(&mut self, ports: &Ports) -> CoreResult<()> {
        if !self.keyring_unavailable {
            return Ok(());
        }
        let state = self.vault.state().map_err(vault_error)?;
        self.keyring_unavailable = false;
        if state == VaultState::Ready {
            self.open_stored(ports)?;
        }
        Ok(())
    }

    /// Member relays (#368, slice 1): the setting, and what it comes to now.
    /// Forced off, whatever the setting, by the first reason that applies:
    /// the global flag (the signed `flags.json`, slice 3b), then a minor, then
    /// relay-only, then a metered network (the shell's `setMetered`).
    fn member_relay_now(&mut self, now: u64) -> CoreResult<MemberRelay> {
        let setting = match self.db.get(KV_MEMBER_RELAY)?.as_deref() {
            Some(b"on") => MemberRelaySetting::On,
            Some(b"off") => MemberRelaySetting::Off,
            _ => MemberRelaySetting::Auto,
        };
        let disclosure_seen = self.db.get(KV_MEMBER_RELAY_SEEN)?.is_some();
        let daily_cap_mb = self
            .db
            .get(KV_MEMBER_RELAY_CAP)?
            .and_then(|v| v.try_into().ok())
            .map(u32::from_le_bytes)
            .filter(|mb| MEMBER_RELAY_CAP_MB.contains(mb))
            .unwrap_or(MEMBER_RELAY_CAP_DEFAULT_MB);
        let role = self.relay_role()?;
        // The age claim's rule: an adult only by a trusted birth date (a
        // restored date isn't, until it agrees or its 30 days are up).
        let adult = self.me.as_ref().is_some_and(|me| {
            me.profile.birth_date_trusted && me.profile.effective_age(now).is_some_and(|age| age >= 18)
        });
        let global_off = self.db.get(KV_MEMBER_RELAY_GLOBAL_OFF)?.as_deref() == Some(b"1");
        let reason = if global_off {
            Some(MemberRelayReason::GlobalOff)
        } else if self.me.is_some() && !adult {
            Some(MemberRelayReason::Minor)
        } else if relay_only_in(&self.db)? {
            Some(MemberRelayReason::RelayOnly)
        } else if self.metered {
            Some(MemberRelayReason::Metered)
        } else {
            None
        };
        let wanted = match setting {
            MemberRelaySetting::On => true,
            MemberRelaySetting::Off => false,
            MemberRelaySetting::Auto => role,
        };
        Ok(MemberRelay {
            setting,
            // PO on #387: never relaying before the one-time disclosure was
            // acknowledged, whatever the setting (fails closed: slice 2's
            // relay reads only `effective`).
            effective: self.me.is_some() && reason.is_none() && wanted && disclosure_seen,
            reason,
            role,
            disclosure_seen,
            daily_cap_mb,
        })
    }

    /// Owner or admin in at least one server I'm still a member of (not
    /// closed, kicked or left), by the log as read so far.
    fn relay_role(&mut self) -> CoreResult<bool> {
        let Some(key) = self.me.as_ref().map(Me::key) else { return Ok(false) };
        for server in self.db.servers()? {
            if self.db.closed_at(server)?.is_some() || self.load(server).is_err() {
                continue;
            }
            let Ok(view) = self.view(server) else { continue };
            let state = &view.state;
            // Kicked is checked on its own too (Security Lead on #389), not
            // only through membership.
            let current = state.is_member(key) && !state.kicked.contains(&key);
            if state.closed.is_none() && current && state.role(key) >= authority::Role::Admin {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `memberRelay.changed` when the value differs from the last one
    /// announced (a role read from the log, a join or leave, relay-only, the
    /// birth date, the setting). Called after every command and sync round.
    fn check_member_relay(&mut self, ports: &Ports, events: &mut Events) {
        match self.member_relay_now(ports.clock.now_ms()) {
            Ok(now) if self.member_relay.as_ref() != Some(&now) => {
                if self.member_relay.is_some() {
                    events.push(Event::MemberRelayChanged(now.clone()));
                }
                // Slice 2: the network relays for members only while this
                // says so (the first check, at start, sets it too).
                ports.network.set_member_relay(now.effective, now.daily_cap_mb, now.role);
                self.member_relay = Some(now);
            }
            Ok(_) => {}
            Err(e) => eprintln!("mvs-core: the member relay state wasn't read: {:?}", e.code),
        }
    }

    /// Syncs a loaded server members-only (GAP-4) with its secret and the
    /// channels authority knows. Harmless to repeat; a server without a
    /// stored secret (from before GAP-4) isn't synced.
    fn open_sync(&self, ports: &Ports, server: ServerId) -> CoreResult<()> {
        if let Some(secret) = self.secret(server)? {
            ports.network.open_server(server, &secret, &self.known(server)?);
        }
        Ok(())
    }

    /// The channels authority knows for a loaded server.
    fn known(&self, server: ServerId) -> CoreResult<BTreeSet<ChannelId>> {
        let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
        Ok(chat::known_channels(server, log.resolver.state()))
    }

    /// G-29: `who` may read and post in `channel` of `server` now: one of
    /// my servers, not closed; a member, not kicked; a channel authority
    /// knows; 18+ only with an accepted 18+ claim.
    fn may_type(&mut self, who: PublicKey, server: ServerId, channel: ChannelId) -> bool {
        if !self.db.has_server(server).unwrap_or(false) || self.load(server).is_err() {
            return false;
        }
        let Ok(known) = self.known(server) else { return false };
        let state = self.logs[&server].resolver.state();
        state.closed.is_none()
            && state.members.contains(&who)
            && !state.kicked.contains(&who)
            && known.contains(&channel)
            && (!state.channels.get(&channel).is_some_and(|c| c.adult) || state.adults.contains(&who))
    }

    /// G-29: sends each of `sends` to the online members who may read its
    /// channel (me excluded). Best effort; nothing without a transport or
    /// an identity.
    fn send_typing(&mut self, now: u64, sends: Vec<typing::Outgoing>) {
        use voice::Members as _;
        let Some(net) = self.typing.net() else { return };
        let Some(key) = self.me.as_ref().map(|me| me.identity.signing_key().clone()) else { return };
        for send in sends {
            let blob = typing::seal(&key, send.server, send.channel, send.on, now);
            for to in self.audience(send.server) {
                if self.may_type(to, send.server, send.channel) {
                    net.send(to, blob.clone());
                }
            }
        }
    }

    /// G-29: a `typing` event for each channel whose typers changed.
    fn typing_events(&mut self, events: &mut Events) {
        for (channel, who) in self.typing.changed() {
            events.push(Event::Typing {
                channel_id: model::hex_id(channel.as_bytes()),
                user_ids: who.iter().map(|k| model::hex_id(k.as_bytes())).collect(),
            });
        }
    }

    /// G-29: "Show others when I'm typing" (local, default on).
    fn typing_indicator(&self) -> bool {
        self.db.get(KV_TYPING_INDICATOR).ok().flatten().as_deref() != Some(b"0".as_slice())
    }

    /// The first time a server is synced: what is already there counts as
    /// announced (the UI reads history with `getMessages`).
    fn seed_announced(&mut self, cipher: &dyn GroupCipher, server: ServerId) -> CoreResult<()> {
        if self.announced.contains_key(&server) {
            return Ok(());
        }
        let me = self.me.as_ref().map(Me::key);
        let mut seen = HashMap::new();
        for channel in self.known(server)? {
            for s in self.shown(cipher, server, channel)? {
                seen.insert(
                    s.record.id(),
                    announced(&s, me, &Status { net: &*self.net, db: &self.db }),
                );
            }
        }
        self.announced.insert(server, seen);
        Ok(())
    }

    /// `message.added` for messages not announced yet, `message.updated` for
    /// those whose edit or deletion changed since.
    fn announce(
        &mut self,
        cipher: &dyn GroupCipher,
        server: ServerId,
        events: &mut Events,
    ) -> CoreResult<()> {
        let me = self.me.as_ref().map(Me::key);
        let members = self.view(server)?.state.members.clone();
        // Channels with a new message from someone else: their unread
        // counts changed (owner bug, v0.4.1: without these events the UI's
        // dots drifted from the read marker and stuck).
        let mut fresh = Vec::new();
        for channel in self.known(server)? {
            let shown = self.shown(cipher, server, channel)?;
            let seen = self.announced.entry(server).or_default();
            for (index, s) in shown.iter().enumerate() {
                let state = announced(s, me, &Status { net: &*self.net, db: &self.db });
                let new = !seen.contains_key(&s.record.id());
                if new && Some(s.record.author()) != me {
                    // G-29: their message arrived; they're done typing.
                    self.typing.gone(s.record.author(), channel);
                }
                let event = match seen.insert(s.record.id(), state.clone()) {
                    None if Some(s.record.author()) != me && !fresh.contains(&channel) => {
                        fresh.push(channel);
                        Event::MessageAdded(message_json(
                            s,
                            index,
                            channel,
                            me,
                            &Status { net: &*self.net, db: &self.db },
                            &members,
                        ))
                    }
                    None => Event::MessageAdded(message_json(
                        s,
                        index,
                        channel,
                        me,
                        &Status { net: &*self.net, db: &self.db },
                        &members,
                    )),
                    Some(old) if old != state => Event::MessageUpdated(message_json(
                        s,
                        index,
                        channel,
                        me,
                        &Status { net: &*self.net, db: &self.db },
                        &members,
                    )),
                    Some(_) => continue,
                };
                events.push(event);
            }
        }
        if !fresh.is_empty() {
            let mut channels: Vec<Channel> = self.view(server)?.channels(me);
            channels.retain(|c| {
                model::parse_hex32(&c.id).is_some_and(|id| fresh.contains(&ChannelId::from_bytes(id)))
            });
            self.fill_unread(cipher, server, &mut channels)?;
            events.extend(channels.into_iter().map(Event::ChannelUpdated));
            events.push(Event::ServerUpdated(self.counted_summary(cipher, server)?));
        }
        self.typing_events(events);
        Ok(())
    }

    /// The server's summary with its unread dot and mention badge (G-21,
    /// G-24): what `listServers` returns and `server.updated` carries after
    /// new messages or `markRead`.
    fn counted_summary(&mut self, cipher: &dyn GroupCipher, server: ServerId) -> CoreResult<ServerSummary> {
        let mut summary = self.summary(server)?;
        let me = self.me.as_ref().map(Me::key);
        let mut channels = self.view(server)?.channels(me);
        self.fill_unread(cipher, server, &mut channels)?;
        summary.unread = channels.iter().any(|c| c.unread);
        summary.mentions = channels.iter().map(|c| c.mentions).fold(0, u32::saturating_add);
        Ok(summary)
    }

    /// Seals `text` for `channel`'s members. If no key is usable yet, a
    /// moderator or above rotates first; anyone else gets `not-allowed`.
    /// Whether a refused seal in `server` only means the key hasn't reached
    /// me yet: I'm a current member of an open server who can't rotate
    /// (`seal`'s `not-allowed` for anyone else is final).
    /// Holds a message until its channel key reaches me (`send_message`),
    /// shown after the channel's stored messages.
    fn hold_for_key(
        &mut self,
        ports: &Ports,
        server: ServerId,
        channel: ChannelId,
        body: &str,
    ) -> CoreResult<Message> {
        let author = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        // Bounded (tech lead): past the cap, the plain refusal.
        if self.key_pending.iter().filter(|p| p.channel == channel && !p.failed).count() >= MAX_KEY_PENDING {
            return Err(ErrorCode::NotAllowed.into());
        }
        let mut tag = [0u8; 8];
        OsRng.fill_bytes(&mut tag);
        let held = KeyPending {
            id: format!("{KEY_PENDING_PREFIX}{}", hex::encode(tag)),
            server,
            channel,
            author,
            body: Zeroizing::new(body.to_owned()),
            created_at: ports.clock.now_ms(),
            failed: false,
        };
        let index = self.message_count(&*ports.cipher, server, channel)?
            + self.key_pending.iter().filter(|p| p.channel == channel).count();
        let message = held.message(index);
        self.key_pending.push(held);
        Ok(message)
    }

    /// The sync loop's part (`sync_now`): each held message whose key has
    /// come is sealed and sent (`message.updated` with `replaces`, then
    /// listed like any other); one still without it after
    /// [`KEY_PENDING_FOR`], or that can no longer be sent (kicked, left,
    /// closed), turns `failed` (`message.updated`, `notice: rekey-waiting`)
    /// and stays listed until a restart.
    fn send_key_pending(&mut self, ports: &Ports, events: &mut Events) -> CoreResult<()> {
        let now = ports.clock.now_ms();
        let mut i = 0;
        while i < self.key_pending.len() {
            if self.key_pending[i].failed {
                i += 1;
                continue;
            }
            let (server, channel) = (self.key_pending[i].server, self.key_pending[i].channel);
            let body = self.key_pending[i].body.clone();
            let waiting = self.db.has_server(server)? && {
                self.load(server)?;
                // Still within a join re-key's wait: neither sent nor failed.
                if self.waits_for_join_key(ports, server, channel)? {
                    i += 1;
                    continue;
                }
                match self.seal_with(ports, server, channel, body.as_bytes(), false) {
                    Ok(sealed) => {
                        let held = self.key_pending.remove(i);
                        let record =
                            self.sign_in_channel(ports, server, channel, None, Kind::Message, sealed)?;
                        self.store(server, record.clone())?;
                        ports.network.publish(&record);
                        let mut message = self.message(&*ports.cipher, server, channel, record.id())?;
                        message.replaces = Some(held.id);
                        events.push(Event::MessageUpdated(message));
                        continue;
                    }
                    Err(e) => e.code == ErrorCode::NotAllowed && self.awaiting_key(server)?,
                }
            };
            let held = &self.key_pending[i];
            let expired = now.saturating_sub(held.created_at) >= KEY_PENDING_FOR.as_millis() as u64;
            if !waiting || expired {
                self.key_pending[i].failed = true;
                let index = self.message_count(&*ports.cipher, server, channel)?
                    + self.key_pending[..i].iter().filter(|p| p.channel == channel).count();
                events.push(Event::MessageUpdated(self.key_pending[i].message(index)));
                events.push(Event::Notice {
                    kind: NoticeKind::RekeyWaiting,
                    server_id: model::hex_id(server.as_bytes()),
                });
            }
            i += 1;
        }
        // Failed ones are bounded too (sec-lead): beyond MAX_KEY_PENDING in
        // a channel, the oldest are dropped, their text with them.
        let channels: BTreeSet<ChannelId> = self.key_pending.iter().map(|p| p.channel).collect();
        for channel in channels {
            let failed = self.key_pending.iter().filter(|p| p.channel == channel && p.failed).count();
            let mut extra = failed.saturating_sub(MAX_KEY_PENDING);
            self.key_pending.retain(|p| {
                let drop = extra > 0 && p.channel == channel && p.failed;
                extra -= usize::from(drop);
                !drop
            });
        }
        Ok(())
    }

    /// Whether a new message in `channel` should wait for a join re-key:
    /// some current members can't read its key yet, for less than
    /// [`JOIN_KEY_WAIT`] so far. Sealed now, the message would never reach
    /// them (lost-message P1). A moderator's sync round makes that re-key
    /// (GAP-8 bucket); everyone else's arrives with it.
    fn waits_for_join_key(&mut self, ports: &Ports, server: ServerId, channel: ChannelId) -> CoreResult<bool> {
        let members = self.view(server)?.state.members.clone();
        let cipher = &*ports.cipher;
        cipher.membership_changed(server, &members);
        chat::sync_cipher(cipher, server, self.logs.get(&server).ok_or(ErrorCode::Internal)?);
        let missing: BTreeSet<PublicKey> = cipher.missing_readers(server, channel).into_iter().collect();
        if missing.is_empty() {
            self.join_key_wait.remove(&(server, channel));
            return Ok(false);
        }
        let now = ports.clock.now_ms();
        let wait = self.join_key_wait.entry((server, channel)).or_insert_with(|| (missing.clone(), now));
        // Someone missing who wasn't before (a later joiner): its own wait,
        // from now. The same set (or fewer) keeps counting from its start.
        if !missing.is_subset(&wait.0) {
            *wait = (missing.clone(), now);
        }
        if now.saturating_sub(wait.1) < JOIN_KEY_WAIT.as_millis() as u64 {
            return Ok(true);
        }
        let missing = missing.len();
        tracing::info!(target: "mvs::keys", missing, "join key wait over: sending under the current key");
        Ok(false)
    }

    fn awaiting_key(&self, server: ServerId) -> CoreResult<bool> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        let view = self.view(server)?;
        Ok(view.state.is_member(me)
            && !view.is_kicked(&me)
            && view.state.closed.is_none()
            && view.state.role(me) < authority::Role::Moderator)
    }

    fn seal(
        &mut self,
        ports: &Ports,
        server: ServerId,
        channel: ChannelId,
        plaintext: &[u8],
    ) -> CoreResult<Vec<u8>> {
        self.seal_with(ports, server, channel, plaintext, true)
    }

    /// [`Self::seal`]; `sync: false` when [`Self::waits_for_join_key`] has
    /// just given the cipher the members and rotations (dev-identity on
    /// #517: not twice per send).
    fn seal_with(
        &mut self,
        ports: &Ports,
        server: ServerId,
        channel: ChannelId,
        plaintext: &[u8],
        sync: bool,
    ) -> CoreResult<Vec<u8>> {
        let cipher = &*ports.cipher;
        let key = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        let view = self.view(server)?;
        let members = view.state.members.clone();
        let readers = channel_readers(&view, channel);
        let may_rotate = view.state.role(key) >= authority::Role::Moderator;
        let auth_deps = auth_deps(&view);
        if sync {
            cipher.membership_changed(server, &members);
            chat::sync_cipher(cipher, server, self.logs.get(&server).ok_or(ErrorCode::Internal)?);
        }
        match cipher.encrypt(server, channel, plaintext) {
            Err(CipherError::NoKey | CipherError::RotationRequired) if may_rotate => {
                // Fail closed: no rotation, no message (`not-allowed`).
                // B7-k: an 18+ channel's key goes to its adult readers only.
                self.rotate_channel(ports, server, channel, &readers, &auth_deps)
                    .map_err(|_| CoreError::from(ErrorCode::NotAllowed))?;
                cipher.encrypt(server, channel, plaintext).map_err(cipher_error)
            }
            other => other.map_err(cipher_error),
        }
    }

    /// A new record of mine in `channel`, on its heads (plus `target` for an
    /// edit or delete) and our latest control heads.
    fn sign_in_channel(
        &self,
        ports: &Ports,
        server: ServerId,
        channel: ChannelId,
        target: Option<RecordId>,
        kind: Kind,
        body: Vec<u8>,
    ) -> CoreResult<Record> {
        let key = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
        let seq = chat::channel_seq(log, channel, &key);
        let deps = match target {
            Some(target) => chat::deps_with(log, channel, target),
            None => chat::channel_deps(log, channel),
        };
        let auth_deps = auth_deps(&self.view(server)?);
        self.sign_channel(server, channel, seq, deps, auth_deps, ports.clock.now_ms(), kind, body)
    }

    /// Signs an edit or delete of `target`; `not-allowed` unless authority
    /// would accept it (dry run), so a refused one is never stored or sent.
    #[allow(clippy::too_many_arguments)]
    fn tombstone_or_edit(
        &mut self,
        ports: &Ports,
        events: &mut Events,
        server: ServerId,
        channel: ChannelId,
        target: RecordId,
        kind: Kind,
        body: Vec<u8>,
    ) -> CoreResult<()> {
        let record = self.sign_in_channel(ports, server, channel, Some(target), kind, body)?;
        let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
        if !chat::would_accept(log, &record) {
            return Err(ErrorCode::NotAllowed.into());
        }
        self.store(server, record.clone())?;
        ports.network.publish(&record);
        let message = self.message(&*ports.cipher, server, channel, target)?;
        self.prune(ports, server)?;
        events.push(Event::MessageUpdated(message));
        Ok(())
    }

    /// The `Message` record `message_id` in one of my servers' known
    /// channels; `not-found` otherwise.
    /// Also a message pruned to its stub (B6-p): then no full record.
    fn find_message(
        &mut self,
        message_id: &str,
    ) -> CoreResult<(ServerId, ChannelId, RecordId, Option<Record>)> {
        let id =
            model::parse_hex32(message_id).map(RecordId::from_bytes).ok_or(ErrorCode::NotFound)?;
        for server in self.db.servers()? {
            self.load(server)?;
            let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
            let known = chat::known_channels(server, log.resolver.state());
            let in_known = |kind: Kind, scope: Scope| {
                kind == Kind::Message && matches!(scope, Scope::Channel(c) if known.contains(&c))
            };
            if let Some(r) =
                log.channel.iter().find(|r| r.id() == id && in_known(r.kind(), r.scope()))
            {
                let Scope::Channel(channel) = r.scope() else { unreachable!("matched") };
                return Ok((server, channel, id, Some(r.clone())));
            }
            if let Some(s) = log.stubs.get(&id).filter(|s| in_known(s.kind(), s.scope())) {
                let Scope::Channel(channel) = s.scope() else { unreachable!("matched") };
                return Ok((server, channel, id, None));
            }
        }
        Err(ErrorCode::NotFound.into())
    }

    /// One shown message as JSON, with its index; `internal` if it isn't
    /// shown (it should be: we just wrote it or it was found).
    fn message(
        &mut self,
        cipher: &dyn GroupCipher,
        server: ServerId,
        channel: ChannelId,
        id: RecordId,
    ) -> CoreResult<Message> {
        self.seed_announced(cipher, server)?;
        let me = self.me.as_ref().map(Me::key);
        let shown = self.shown(cipher, server, channel)?;
        let (index, s) = shown
            .iter()
            .enumerate()
            .find(|(_, s)| s.record.id() == id)
            .ok_or(ErrorCode::Internal)?;
        // Announced by the command itself; sync won't repeat it.
        let state = announced(s, me, &Status { net: &*self.net, db: &self.db });
        self.announced.entry(server).or_default().insert(s.record.id(), state);
        let members = self.view(server)?.state.members.clone();
        Ok(message_json(s, index, channel, me, &Status { net: &*self.net, db: &self.db }, &members))
    }

    /// A fresh key for `channel`, for `members` (we must be a moderator or
    /// above). Every part is signed once, stored with the others in one
    /// transaction, and only then published: a failure publishes nothing
    /// (#91). A later attempt makes a new rotation, never re-signs a part.
    fn rotate_channel(
        &mut self,
        ports: &Ports,
        server: ServerId,
        channel: ChannelId,
        members: &BTreeSet<PublicKey>,
        auth_deps: &[RecordId],
    ) -> CoreResult<()> {
        let cipher = &*ports.cipher;
        let parts = cipher.rotate(server, channel, members).map_err(cipher_error)?;
        let key = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
        let seq = chat::channel_seq(log, channel, &key);
        let deps = chat::channel_deps(log, channel);
        let mut signed = Vec::new();
        for (i, part) in parts.into_iter().enumerate() {
            signed.push(self.sign_channel(
                server,
                channel,
                seq + i as u64,
                deps.clone(),
                auth_deps.to_vec(),
                ports.clock.now_ms(),
                Kind::KeyRotation,
                part,
            )?);
        }
        self.db.put_records(&signed)?;
        let log = self.logs.get_mut(&server).ok_or(ErrorCode::Internal)?;
        for record in &signed {
            log.add(record.clone());
        }
        for record in &signed {
            ports.network.publish(record);
        }
        chat::sync_cipher(cipher, server, log);
        self.keyed_for.insert((server, channel), members.clone());
        Ok(())
    }

    /// After members were removed (a kick or revoke, ours or read): every
    /// known channel whose key removed members still hold gets a fresh one
    /// if we may rotate (`notice: encryption-renewed`); otherwise the UI
    /// learns it waits for a moderator (`notice: rekey-waiting`). After
    /// joins: re-keyed for the new members as the server's token bucket
    /// allows (`crate::rekey`).
    fn rekey(&mut self, ports: &Ports, server: ServerId, events: &mut Events) -> CoreResult<()> {
        // Waiting only if this round says so: an early return or error (no
        // longer a member, may no longer rotate) never leaves it waiting.
        self.join_waiting.remove(&server);
        let Some(me) = self.me.as_ref().map(Me::key) else { return Ok(()) };
        let view = self.view(server)?;
        if !view.state.is_member(me) {
            return Ok(());
        }
        let members = view.state.members.clone();
        let may_rotate = view.state.role(me) >= authority::Role::Moderator;
        let auth_deps = auth_deps(&view);
        let cipher = &*ports.cipher;
        cipher.membership_changed(server, &members);
        let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
        chat::sync_cipher(cipher, server, log);
        let server_id = model::hex_id(server.as_bytes());
        // B7-k: each channel's readers; an 18+ channel's are its adults.
        let channels = self.known(server)?;
        let view = self.view(server)?;
        let readers: HashMap<ChannelId, BTreeSet<PublicKey>> =
            channels.iter().map(|c| (*c, channel_readers(&view, *c))).collect();
        // Channels a join left stale: re-keyed together, for one token.
        let mut joined = Vec::new();
        for channel in channels {
            let members = &readers[&channel];
            // A probe: an empty plaintext, never sent.
            let probe = cipher.encrypt(server, channel, b"");
            if probe != Err(CipherError::RotationRequired) {
                // v0.2.0 smoke: no key yet, or members joined since we keyed it
                // (unknown after a restart: once). A moderator or above keys the
                // channel for everyone now, so a joiner can write and read
                // without waiting for a moderator to send first. A failure only
                // leaves things as they were: the next round tries again.
                let stale = self.keyed_for.get(&(server, channel)) != Some(members);
                let no_key = probe == Err(CipherError::NoKey);
                if may_rotate && (no_key || (probe.is_ok() && stale)) && members.len() > 1 {
                    joined.push(channel);
                } else if !may_rotate && no_key {
                    // A joiner without a key yet: waiting for a moderator, not ready.
                    let kind = NoticeKind::RekeyWaiting;
                    events.push(Event::Notice { kind, server_id: server_id.clone() });
                }
                continue;
            }
            // A kick, leave or revoke: never waits, spends no token.
            // Fail closed: a rotation that didn't happen is never announced as
            // one, and the channel stays blocked by `RotationRequired` until the
            // next sync or send retries.
            let renewed = may_rotate
                && self.rotate_channel(ports, server, channel, members, &auth_deps).is_ok();
            let kind =
                if renewed { NoticeKind::EncryptionRenewed } else { NoticeKind::RekeyWaiting };
            events.push(Event::Notice { kind, server_id: server_id.clone() });
        }
        if joined.is_empty() {
            return Ok(());
        }
        // GAP-8 (`rekey`): a token re-keys now; without one, everyone who
        // joined meanwhile shares the re-key fired when the next is due.
        let now = ports.clock.now_ms();
        let bucket = self.join_buckets.entry(server).or_insert_with(|| JoinBucket::new(now));
        if !bucket.take(now) {
            self.join_waiting.insert(server);
            return Ok(());
        }
        for channel in joined {
            // Fail closed, as for a kick: a failed rotation is never announced
            // as one, and the UI learns the channel waits.
            if self.rotate_channel(ports, server, channel, &readers[&channel], &auth_deps).is_err() {
                let kind = NoticeKind::RekeyWaiting;
                events.push(Event::Notice { kind, server_id: server_id.clone() });
            }
        }
        Ok(())
    }

    /// The server of my default channel `channel_id`; `not-found` for any
    /// other. Loads the server.
    /// The server a channel of mine is in, 18+ ones included (whether I may
    /// use it is the caller's check).
    fn channel_server(&mut self, channel: ChannelId) -> CoreResult<ServerId> {
        for server in self.db.servers()? {
            self.load(server)?;
            if self.known(server)?.contains(&channel) {
                return Ok(server);
            }
        }
        Err(ErrorCode::NotFound.into())
    }

    fn find_channel(&mut self, channel_id: &str) -> CoreResult<(ServerId, ChannelId)> {
        let channel =
            model::parse_hex32(channel_id).map(ChannelId::from_bytes).ok_or(ErrorCode::NotFound)?;
        for server in self.db.servers()? {
            self.load(server)?;
            if self.visible(server)?.contains(&channel) {
                return Ok((server, channel));
            }
        }
        Err(ErrorCode::NotFound.into())
    }

    #[allow(clippy::too_many_arguments)]
    fn sign_channel(
        &self,
        server: ServerId,
        channel: ChannelId,
        seq: u64,
        deps: Vec<RecordId>,
        auth_deps: Vec<RecordId>,
        ts: u64,
        kind: Kind,
        body: Vec<u8>,
    ) -> CoreResult<Record> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        Draft { server, scope: Scope::Channel(channel), seq, deps, auth_deps, ts, kind, body }
            .sign(me.identity.signing_key())
            .map_err(|_| ErrorCode::BadRequest.into())
    }

    /// The channel's shown messages, after giving the cipher what's new.
    fn shown(
        &mut self,
        cipher: &dyn GroupCipher,
        server: ServerId,
        channel: ChannelId,
    ) -> CoreResult<Vec<chat::Shown>> {
        let now = self.clock.now_ms();
        let members = self.view(server)?.state.members.clone();
        cipher.membership_changed(server, &members);
        let log = self.logs.get_mut(&server).ok_or(ErrorCode::Internal)?;
        chat::sync_cipher(cipher, server, log);
        Ok(chat::messages(cipher, server, channel, log, now))
    }

    /// G-21: my read marker in `channel`: the last message I read, as
    /// (time, ID). Never read: from when this device joined the server, so
    /// history from before isn't unread.
    fn read_marker(&self, server: ServerId, channel: ChannelId) -> CoreResult<(u64, [u8; 32])> {
        let key = format!("{KV_READ_PREFIX}{}", model::hex_id(channel.as_bytes()));
        if let Some(raw) = self.db.get(&key)? {
            if let Ok((ts, id)) = serde_json::from_slice::<(u64, String)>(&raw) {
                if let Some(id) = model::parse_hex32(&id) {
                    return Ok((ts, id));
                }
            }
        }
        Ok((self.db.joined_at(server)?.unwrap_or(0), [0; 32]))
    }

    /// G-21: `firstUnreadIndex` and `unreadCount` for each of `channels`
    /// (of `server`): the messages after my read marker, in `getMessages`
    /// order, that aren't mine. Local only: the stored records, no network
    /// and no paging.
    fn fill_unread(
        &mut self,
        cipher: &dyn GroupCipher,
        server: ServerId,
        channels: &mut [Channel],
    ) -> CoreResult<()> {
        let Some(me) = self.me.as_ref().map(Me::key) else { return Ok(()) };
        for json in channels {
            let Some(channel) = model::parse_hex32(&json.id).map(ChannelId::from_bytes) else {
                continue;
            };
            let marker = self.read_marker(server, channel)?;
            let shown = self.shown(cipher, server, channel)?;
            let after = |s: &chat::Shown| (s.record.ts(), *s.record.id().as_bytes()) > marker;
            let unread = |s: &&chat::Shown| after(s) && s.record.author() != me;
            let count = shown.iter().filter(unread).count() as u64;
            json.unread_count = Some(count);
            json.first_unread_index = shown.iter().position(|s| unread(&s)).map(|i| i as u64);
            json.unread = count > 0;
            // G-24: unread messages that mention me (the badge).
            let mentions = shown.iter().filter(unread).filter(|s| model::mention_tokens(&s.text).contains(&me));
            json.mentions = u32::try_from(mentions.count()).unwrap_or(u32::MAX);
        }
        Ok(())
    }

    fn message_count(
        &mut self,
        cipher: &dyn GroupCipher,
        server: ServerId,
        channel: ChannelId,
    ) -> CoreResult<usize> {
        Ok(self.shown(cipher, server, channel)?.len())
    }

    fn challenge(&self) -> CoreResult<Option<Challenge>> {
        match self.db.get(KV_RECOVERY_CHALLENGE)? {
            None => Ok(None),
            // Unreadable: start over rather than lock the user out.
            Some(json) => Ok(serde_json::from_slice(&json).ok()),
        }
    }

    fn save_challenge(&self, challenge: &Challenge) -> CoreResult<()> {
        self.db.set(KV_RECOVERY_CHALLENGE, &serde_json::to_vec(challenge).expect("plain struct"))
    }

    fn new_me(&self, phrase: RecoveryPhrase, profile: Profile) -> CoreResult<Me> {
        let identity = phrase.identity();
        let key = *identity.storage_key().expose_secret();
        self.db.save_profile(&key, &serde_json::to_vec(&profile).expect("plain struct"))?;
        self.me_from(phrase, identity, profile)
    }

    /// Keeps the phrase only while the recovery check is still to do.
    fn me_from(
        &self,
        phrase: RecoveryPhrase,
        identity: identity::Identity,
        profile: Profile,
    ) -> CoreResult<Me> {
        let checked = self.vault.recovery_check_done(&identity).map_err(vault_error)?;
        Ok(Me { phrase: (!checked).then_some(phrase), identity, profile })
    }

    fn load_me(&self, phrase: RecoveryPhrase) -> CoreResult<Me> {
        let identity = phrase.identity();
        let key = *identity.storage_key().expose_secret();
        let profile = match self.db.load_profile(&key)? {
            Some(json) => serde_json::from_slice(&json).map_err(|_| ErrorCode::Internal)?,
            None => Profile::default(),
        };
        self.me_from(phrase, identity, profile)
    }

    /// Device link: what the approving device sends. The words come from the
    /// keychain (they are gone from memory once the recovery check passed).
    fn link_payload(&self) -> CoreResult<devicelink::Payload> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let phrase = self.vault.open().map_err(vault_error)?;
        let p = &me.profile;
        Ok(devicelink::Payload {
            seed: Zeroizing::new(phrase.words().join(" ")),
            profile: devicelink::PayloadProfile {
                display_name: p.display_name.clone(),
                avatar_small: p.avatar_small.clone().filter(|a| !a.is_empty()),
                color: p.color.clone().filter(|c| !c.is_empty()),
            },
            birth_date: p.birth_date.clone(),
            birth_date_trusted: p.birth_date_trusted,
            country: p.country.clone(),
        })
    }

    fn identity_json(&self, me: &Me) -> CoreResult<Identity> {
        let key = me.key();
        Ok(Identity {
            id: model::hex_id(key.as_bytes()),
            short_code: model::short_code(&key),
            display_name: me.profile.display_name.clone(),
            avatar_color: model::color_for(key.as_bytes()),
            avatar_data_url: me.profile.avatar_data_url.clone(),
            color: me.profile.color.clone(),
            bio: me.profile.bio.clone(),
            country: me.profile.country.clone(),
            birth_date: me.profile.birth_date.clone(),
            pending_birth_date: me.profile.pending_birth_date.as_ref().map(|p| PendingBirthDate {
                date: p.date.clone(),
                effective_at: p.effective_at,
            }),
            recovery_checked: self.vault.recovery_check_done(&me.identity).map_err(vault_error)?,
        })
    }

    /// #354, #378: a pending profile change goes out at once while the burst
    /// lasts ([`PROFILE_POST_BURST`]), then once per [`PROFILE_POST_EVERY_MS`]
    /// (coalesced: the latest values). Called on a change and every sync
    /// round; the pending flag is stored.
    fn flush_profile(&mut self, ports: &Ports) -> CoreResult<()> {
        let pending = self.db.get(KV_PROFILE_PENDING)?.is_some();
        // Servers whose last profile post was refused (Tech Lead on #359):
        // only they are tried again, so one refusing server doesn't send
        // every other server a new post every 10 minutes.
        let retry: BTreeSet<ServerId> = self
            .db
            .get(KV_PROFILE_RETRY)?
            .and_then(|json| serde_json::from_slice::<Vec<String>>(&json).ok())
            .unwrap_or_default()
            .iter()
            .filter_map(|id| model::parse_hex32(id).map(ServerId::from_bytes))
            .collect();
        if !pending && retry.is_empty() {
            return Ok(());
        }
        // GCRA (#378): each post moves `tat` on by the interval; one may go
        // while `tat` is at most BURST − 1 intervals ahead of now.
        let now = ports.clock.now_ms();
        let tat = self
            .db
            .get(KV_PROFILE_POST_TAT)?
            .and_then(|v| v.try_into().ok())
            .map_or(0, u64::from_le_bytes);
        if tat > now.saturating_add((PROFILE_POST_BURST - 1) * PROFILE_POST_EVERY_MS) {
            return Ok(());
        }
        let (sent, failed) = self.post_profile_everywhere(ports, (!pending).then_some(&retry))?;
        // Counted once a post was made or tried (sign-up sets a name before
        // I'm in any server: nothing either way).
        if sent > 0 || !failed.is_empty() {
            let tat = tat.max(now).saturating_add(PROFILE_POST_EVERY_MS);
            self.db.set(KV_PROFILE_POST_TAT, &tat.to_le_bytes())?;
        }
        let failed: Vec<String> = failed.iter().map(|s| model::hex_id(s.as_bytes())).collect();
        self.db.set(KV_PROFILE_RETRY, &serde_json::to_vec(&failed).expect("plain list"))?;
        self.db.delete(KV_PROFILE_PENDING)
    }

    /// My profile (name, small picture, colour) as one profile post per
    /// server I'm still a member of (not closed, not kicked, not left), or
    /// only to `only`. A server that refuses it is logged. Returns how many
    /// went out and the servers that refused. A database error is returned
    /// (Tech Lead on #361), so the pending change stays for the next round.
    fn post_profile_everywhere(
        &mut self,
        ports: &Ports,
        only: Option<&BTreeSet<ServerId>>,
    ) -> CoreResult<(usize, Vec<ServerId>)> {
        let mut servers = self.db.servers()?;
        if let Some(only) = only {
            servers.retain(|s| only.contains(s));
        }
        let Some(me) = self.me.as_ref() else { return Ok((0, Vec::new())) };
        let (mut sent, mut failed) = (0, Vec::new());
        let key = me.key();
        let p = &me.profile;
        let action = model::profile_action_with(&p.display_name, p.avatar_small.as_deref(), p.color.as_deref());
        for server in servers {
            let posted = (|| -> CoreResult<bool> {
                if self.db.closed_at(server)?.is_some() {
                    return Ok(false);
                }
                self.load(server)?;
                let view = self.view(server)?;
                if view.state.closed.is_some() || !view.state.is_member(key) {
                    return Ok(false);
                }
                self.publish_control(ports, server, &action)?;
                Ok(true)
            })();
            match posted {
                Ok(true) => sent += 1,
                Ok(false) => {}
                Err(e) => {
                    failed.push(server);
                    eprintln!("mvs-core: a profile post wasn't published: {:?}", e.code);
                }
            }
        }
        Ok((sent, failed))
    }

    /// Signs `action` on our heads in loaded `server`, dry-runs it on the
    /// live resolver, then stores and publishes it. Its deps are our heads,
    /// so it joins at once; if `authority` doesn't accept it, it was never
    /// stored or sent (`not-allowed`), and the log is rebuilt from the store
    /// so it leaves no trace.
    // TODO(records B4): `Resolver::would_accept` instead.
    fn publish_control(
        &mut self,
        ports: &Ports,
        server: ServerId,
        action: &Action,
    ) -> CoreResult<Record> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let view = self.view(server)?;
        // A revoke-invite lists its invite in its deps.
        let extra = match action {
            Action::RevokeInvite { invite } => Some(*invite),
            _ => None,
        };
        let record = authority::sign_control(
            me.identity.signing_key(),
            server,
            view.next_seq(&me.key()),
            view.deps(extra),
            ports.clock.now_ms(),
            action,
        )
        .map_err(|_| ErrorCode::BadRequest)?;
        let log = self.logs.get_mut(&server).ok_or(ErrorCode::Internal)?;
        let joined = log.add(record.clone());
        if !log.accepted(&record.id()) {
            self.logs.remove(&server);
            return Err(ErrorCode::NotAllowed.into());
        }
        if matches!(action, Action::Leave { .. }) {
            // Never stored: it goes to the leave outbox (`leave_server`).
            return Ok(record);
        }
        for record in &joined {
            self.db.put_record(record)?;
        }
        ports.network.publish(&record);
        Ok(record)
    }

    /// One round of the leave outbox for `server` (#261, both leads), on
    /// what reachable peers hold (`fetched`; nothing of it is stored):
    /// - kicked first, or the server closed: the `Leave` is dropped;
    /// - a member has it (B6 `sent` or `received`; on a transport that
    ///   doesn't track that, it took it): done, the entry and the sync
    ///   secret go, and the subscription closes;
    /// - otherwise, once the gate is open, it is (re)published.
    fn flush_leave(
        &mut self,
        ports: &Ports,
        server: ServerId,
        leave: &Record,
        fetched: Vec<Record>,
    ) -> CoreResult<()> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        let finish = |db: &Db| -> CoreResult<()> {
            db.drop_leave(server)?;
            ports.network.close_server(server);
            Ok(())
        };
        let log = Log::new(server, fetched);
        let Some(view) = ServerView::build(server, &log) else { return Ok(()) };
        if view.is_kicked(&me) || view.state.closed.is_some() {
            return finish(&self.db);
        }
        let state = ports.network.send_state(leave.id());
        if matches!(state, Some(SendState::Sent | SendState::Received)) {
            return finish(&self.db);
        }
        if !gate_open(&view, me, model::SERVER_LIFECYCLE_CAP) || state == Some(SendState::Pending) {
            return Ok(());
        }
        ports.network.publish(leave);
        let took = ports.network.send_state(leave.id()).is_none()
            && ports.network.fetch(server).iter().any(|r| r.id() == leave.id());
        if took {
            return finish(&self.db);
        }
        Ok(())
    }

    /// G-14: `channel.updated` for each channel I can see whose topic is not
    /// what it was in `before`.
    fn topic_events(
        &mut self,
        cipher: &dyn GroupCipher,
        server: ServerId,
        before: &BTreeMap<ChannelId, String>,
        me: Option<PublicKey>,
        events: &mut Vec<Event>,
    ) -> CoreResult<()> {
        let view = self.view(server)?;
        let after = &view.state.topics;
        let changed: Vec<String> = before
            .keys()
            .chain(after.keys())
            .filter(|id| before.get(*id) != after.get(*id))
            .map(|id| model::hex_id(id.as_bytes()))
            .collect();
        if changed.is_empty() {
            return Ok(());
        }
        let mut channels = view.channels(me);
        channels.retain(|c| changed.contains(&c.id));
        self.fill_unread(cipher, server, &mut channels)?;
        events.extend(channels.into_iter().map(Event::ChannelUpdated));
        Ok(())
    }

    /// `not-allowed` below `role` in loaded `server` (before the gate, so a
    /// member learns they can't, not that others must update).
    fn lifecycle_role(&self, server: ServerId, role: authority::Role) -> CoreResult<()> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        if self.view(server)?.state.role(me) < role {
            return Err(ErrorCode::NotAllowed.into());
        }
        Ok(())
    }

    /// A rollout gate (server lifecycle #229, reactions G-26):
    /// `update-needed` unless every other current member's latest profile
    /// post carries `cap` (no profile post counts as needing an update).
    /// This version reads them itself. Checked before anything is signed.
    fn cap_gate(&self, server: ServerId, cap: &str) -> CoreResult<()> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?.key();
        if !gate_open(&self.view(server)?, me, cap) {
            return Err(ErrorCode::UpdateNeeded.into());
        }
        Ok(())
    }

    /// The release that adds a cap: my latest profile post in `server` lacks
    /// one of [`model::CAPS`] (posted by an older version), so post it
    /// again, once.
    /// B7-k K2 (Security Lead on #544): to an owner or admin of a server
    /// with an 18+ channel, `notice: adult-keys-outdated` once while some
    /// member's latest profile post lacks `adult-keys-v1` (such a member, if
    /// a moderator, re-keys 18+ channels for every member). Sent again only
    /// after the list has been empty.
    fn adult_keys_notice(&mut self, server: ServerId, me: PublicKey, events: &mut Events) -> CoreResult<()> {
        let view = self.view(server)?;
        let outdated = view.state.role(me) >= authority::Role::Admin
            && view.state.channels.values().any(|c| c.adult)
            && !view.lacking(model::ADULT_KEYS_CAP, me).is_empty();
        if !outdated {
            self.adult_keys_warned.remove(&server);
        } else if self.adult_keys_warned.insert(server) {
            events.push(Event::Notice {
                kind: NoticeKind::AdultKeysOutdated,
                server_id: model::hex_id(server.as_bytes()),
            });
        }
        Ok(())
    }

    fn post_caps(&mut self, ports: &Ports, server: ServerId) -> CoreResult<()> {
        let Some(me) = self.me.as_ref() else { return Ok(()) };
        let (key, name) = (me.key(), me.profile.display_name.clone());
        // #359: the picture and colour too (None stays absent).
        let (me_small, me_color) = (me.profile.avatar_small.clone(), me.profile.color.clone());
        let view = self.view(server)?;
        let member = view.state.is_member(key) && !view.state.kicked.contains(&key);
        let has_all = model::CAPS.iter().all(|cap| view.caps(cap).get(&key) == Some(&true));
        if !member || view.state.closed.is_some() || has_all {
            return Ok(());
        }
        let (small, color) = (me_small, me_color);
        let action = model::profile_action_with(&name, small.as_deref(), color.as_deref());
        self.publish_control(ports, server, &action).map(drop)
    }

    /// Server lifecycle (#229, the security lead's rule 5): after I leave,
    /// or the server is deleted, removes it from this device. My call there
    /// ends first (with a bye); then its records, sync secret, channel keys
    /// and sync subscription go, and every per-server loop forgets it.
    /// `server.removed` follows. Not erasure: other members keep copies.
    ///
    /// `keep`: for a closed server's last purge, its genesis and close.
    /// `leaving`: my `Leave` is in the outbox, so the sync secret and
    /// subscription stay until it is delivered (`flush_leave`).
    #[allow(clippy::too_many_arguments)]
    fn purge_server(
        &mut self,
        ports: &Ports,
        server: ServerId,
        reason: RemovedReason,
        keep: &[RecordId],
        leaving: bool,
        events: &mut Events,
    ) -> CoreResult<()> {
        // G-77: an age removal says which restriction I'm now under.
        let required = (reason == RemovedReason::Age)
            .then(|| self.view(server).ok().map(|v| v.genesis.age_restriction))
            .flatten();
        self.stop_using(ports, server, !leaving, events);
        self.db.purge_server(server, keep, leaving)?;
        // Held text goes with the server (lost-message P1, SL C3).
        self.key_pending.retain(|p| p.server != server);
        self.join_key_wait.retain(|(s, _), _| *s != server);
        self.logs.remove(&server);
        self.announced.remove(&server);
        events.push(Event::ServerRemoved {
            server_id: model::hex_id(server.as_bytes()),
            reason: Some(reason),
            required,
        });
        Ok(())
    }

    /// Server lifecycle: the owner closed `server` (read, or my own close).
    /// It isn't purged at once (the Tech Lead's #229 answer): any call there
    /// ends, its keys and sync subscription go, and it's no longer synced;
    /// it stays listed, read-only (`closed`), for [`CLOSED_RETENTION_MS`]
    /// after we received the close. Then the rest goes, and its genesis and
    /// close stay forever, so it reads as closed, never unknown.
    fn close_locally(
        &mut self,
        ports: &Ports,
        server: ServerId,
        events: &mut Events,
    ) -> CoreResult<()> {
        self.stop_using(ports, server, true, events);
        self.db.mark_closed(server, ports.clock.now_ms())?;
        events.push(Event::ServerClosed { server_id: model::hex_id(server.as_bytes()) });
        Ok(())
    }

    /// Closed servers whose 30 days are up: purged but for their genesis
    /// and close (`server.removed`, `closed`).
    fn expire_closed(&mut self, ports: &Ports, events: &mut Events) -> CoreResult<()> {
        let now = ports.clock.now_ms();
        for (server, at) in self.db.closed_servers()? {
            if now.saturating_sub(at) < CLOSED_RETENTION_MS {
                continue;
            }
            self.load(server)?;
            let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
            let genesis = log.records.iter().find(|r| r.kind() == Kind::Genesis).map(Record::id);
            let close = log.resolver.state().closed;
            let keep: Vec<RecordId> = genesis.into_iter().chain(close).collect();
            self.purge_server(ports, server, RemovedReason::Closed, &keep, false, events)?;
        }
        Ok(())
    }

    /// What every way out of a server shares: my call there ends (with a
    /// bye), and its keys, sync subscription (unless `close_sync` is false:
    /// a `Leave` still to deliver) and per-server state go, and its short
    /// links stop being served (T8-02; the rows go with `Db::purge_server`).
    fn stop_using(
        &mut self,
        ports: &Ports,
        server: ServerId,
        close_sync: bool,
        events: &mut Events,
    ) {
        if self.calls.in_server(server) {
            if let Some(key) = self.me.as_ref().map(|me| me.identity.signing_key().clone()) {
                let mut calls = std::mem::take(&mut self.calls);
                let mut ctx = voice::Ctx { key: &key, now: ports.clock.now_ms(), events };
                calls.leave(&mut ctx, self);
                self.calls = calls;
            }
        }
        self.calls.forget_server(server);
        ports.cipher.forget(server);
        if close_sync {
            ports.network.close_server(server);
        }
        ports.network.drop_server_invites(server);
        self.presence_seen.remove(&server);
        self.keyed_for.retain(|(s, _), _| *s != server);
        // Its join re-key tokens and any re-key waiting on them (#250).
        self.join_buckets.remove(&server);
        self.join_waiting.remove(&server);
    }

    /// Loads `server`'s log from the store unless it is already in memory.
    fn load(&mut self, server: ServerId) -> CoreResult<()> {
        if !self.logs.contains_key(&server) {
            let mut log = Log::new(server, self.db.records(server)?);
            for stub in self.db.stubs(server)? {
                log.add_stub(stub);
            }
            self.logs.insert(server, log);
        }
        Ok(())
    }

    /// Loads a server I'm in; `not-found` for any other.
    fn load_mine(&mut self, server: ServerId) -> CoreResult<ServerId> {
        if !self.db.has_server(server)? {
            return Err(ErrorCode::NotFound.into());
        }
        self.load(server)?;
        Ok(server)
    }

    /// G-47: blocks or unblocks `user`. On a change: the name as known now
    /// is kept for the list (a blocked account often shares no server
    /// later), the members of servers it's in are re-sent, and
    /// `blocks.changed` carries the new list.
    fn set_blocked(&mut self, user: PublicKey, blocked: bool, events: &mut Events) -> CoreResult<()> {
        // Never myself, from either command (Security Lead on #502).
        if self.me.as_ref().map(Me::key) == Some(user) {
            return Err(ErrorCode::BadRequest.into());
        }
        let name = if blocked { self.known_names(&[user])?.remove(&user) } else { None };
        if !self.db.set_block(&user, blocked)? {
            return Ok(());
        }
        match name {
            Some(name) => self.db.set(&blocked_name_key(&user), name.as_bytes())?,
            None => self.db.delete(&blocked_name_key(&user))?,
        }
        for server in self.db.servers()? {
            self.load(server)?;
            let view = self.view(server)?;
            if view.members().iter().any(|m| m.key == user) {
                events.push(Event::MembersChanged {
                    server_id: model::hex_id(server.as_bytes()),
                    members: self.members_json(&view)?,
                });
            }
        }
        events.push(Event::BlocksChanged { blocked: self.blocked_list()? });
        Ok(())
    }

    /// G-47: the display names `users` have in the servers I'm in.
    fn known_names(&mut self, users: &[PublicKey]) -> CoreResult<BTreeMap<PublicKey, String>> {
        let mut out = BTreeMap::new();
        if users.is_empty() {
            return Ok(out);
        }
        for server in self.db.servers()? {
            self.load(server)?;
            for (key, name) in self.view(server)?.display_names() {
                if users.contains(&key) {
                    out.insert(key, name);
                }
            }
        }
        Ok(out)
    }

    /// G-47: the block list, each with its name in a shared server, else
    /// the one kept when it was blocked.
    fn blocked_list(&mut self) -> CoreResult<Vec<BlockedUser>> {
        let users = self.db.blocked_users()?;
        let mut names = self.known_names(&users)?;
        users
            .into_iter()
            .map(|user| {
                let name = match names.remove(&user) {
                    Some(name) => Some(name),
                    None => self.db.get(&blocked_name_key(&user))?.and_then(|b| String::from_utf8(b).ok()),
                };
                Ok(BlockedUser { user_id: model::hex_id(user.as_bytes()), short_code: model::short_code(&user), name })
            })
            .collect()
    }

    /// A loaded server's view.
    fn view(&self, server: ServerId) -> CoreResult<ServerView<'_>> {
        let log = self.logs.get(&server).ok_or(ErrorCode::Internal)?;
        ServerView::build(server, log).ok_or_else(|| ErrorCode::NotFound.into())
    }

    /// Offers a record to the loaded log and stores whatever joined because
    /// of it; false if nothing joined (a duplicate, or still waiting on deps).
    fn store(&mut self, server: ServerId, record: Record) -> CoreResult<bool> {
        let log = self.logs.get_mut(&server).ok_or(ErrorCode::Internal)?;
        let joined = log.add(record);
        for record in &joined {
            self.db.put_record(record)?;
        }
        Ok(!joined.is_empty())
    }

    fn members_json(&self, view: &ServerView) -> CoreResult<Vec<Member>> {
        let me = self.me.as_ref().map(Me::key);
        // M2: online from sync's presence; only authority's members are
        // listed, so a bound non-member or a kicked key never shows.
        let reach = self.net.presence(view.id).unwrap_or_default();
        let server_id = model::hex_id(view.id.as_bytes());
        let mut out = Vec::new();
        let looks = view.looks();
        // Profile save (#378): my own row shows my saved profile at once,
        // not what my last profile post said (it may still be waiting).
        let mine = self.me.as_ref().map(|me| {
            let set = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
            let p = &me.profile;
            (p.display_name.clone(), set(&p.avatar_small), set(&p.color))
        });
        for mut member in view.members() {
            let (mut avatar, mut color) = looks.get(&member.key).cloned().unwrap_or_default();
            if let (Some((name, my_avatar, my_color)), true) = (&mine, Some(member.key) == me) {
                if !name.is_empty() {
                    member.display_name = name.clone();
                }
                (avatar, color) = (my_avatar.clone(), my_color.clone());
            }
            let blocked = self.db.is_blocked(&member.key)?;
            out.push(Member {
                id: model::hex_id(member.key.as_bytes()),
                server_id: server_id.clone(),
                display_name: member.display_name,
                short_code: model::short_code(&member.key),
                avatar_color: model::color_for(member.key.as_bytes()),
                // TODO(sync): real presence from connections.
                presence: if Some(member.key) == me || reach.online.contains(&member.key) {
                    Presence::Online
                } else {
                    Presence::Offline
                },
                connection: (Some(member.key) != me && reach.online.contains(&member.key)).then(
                    || match reach.direct.contains(&member.key) {
                        true => Connection::Direct,
                        false => Connection::Relay,
                    },
                ),
                is_owner: member.key == view.owner,
                role: member.role,
                blocked: blocked.then_some(true),
                bio: None,
                avatar_data_url: avatar,
                color,
            });
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    fn join(
        &mut self,
        ports: &Ports,
        server: ServerId,
        invite: RecordId,
        secret: &[u8; 32],
        link: &str,
        fetched: Vec<Record>,
        events: &mut Events,
    ) -> CoreResult<JoinStatus> {
        let me = self.me.as_ref().ok_or(ErrorCode::NotFound)?;
        let link = link.to_owned();
        let server_hex = model::hex_id(server.as_bytes());
        if self.db.has_server(server)? {
            return Ok(JoinStatus::Joined { link, server_id: server_hex });
        }
        if fetched.is_empty() {
            return Ok(JoinStatus::NobodyOnline { link });
        }
        let mut log = Log::new(server, fetched);
        let Some(view) = ServerView::build(server, &log) else {
            return Ok(JoinStatus::Invalid { link });
        };
        // Server lifecycle: an old invite (or a stale peer) for a server its
        // owner closed. Its genesis and close say so: closed, not unknown.
        if view.state.closed.is_some() {
            return Ok(JoinStatus::Closed { link });
        }
        let key = me.key();
        // Already a member (this device lost its copy, e.g. a restore on a
        // new computer): no new join, and nothing that would overwrite what
        // the server already holds about me.
        let member = view.state.is_member(key);
        let required = view.genesis.age_restriction;
        // As it counts now: at most 17 while a raise waits its 30 days.
        let age = me.profile.effective_age(ports.clock.now_ms());
        // A member's earlier age claim stands while this device has no birth
        // date (a restore doesn't carry it yet); a known age too low still
        // blocks.
        let age_unknown_member = member && age.is_none();
        if required.min_age() > 0
            && !age_unknown_member
            && age.is_none_or(|age| age < required.min_age())
        {
            return Ok(JoinStatus::AgeBlocked { link, required });
        }
        if view.is_kicked(&key) {
            // TODO(ui): a "you were removed from this server" phase.
            return Ok(JoinStatus::Invalid { link });
        }
        let sign = |view: &ServerView, deps, action: &Action| {
            authority::sign_control(
                me.identity.signing_key(),
                server,
                view.next_seq(&key),
                deps,
                ports.clock.now_ms(),
                action,
            )
            .map_err(|_| CoreError::from(ErrorCode::BadRequest))
        };
        let mut mine = Vec::new();
        if !member {
            // An invite we don't hold, revoked or used up: `authority`
            // refuses the join, and nothing is stored or sent.
            // TODO(ui): phases for "invite expired" and "invite used up".
            let join = sign(&view, view.deps(Some(invite)), &Action::Join { invite })?;
            log.add(join.clone());
            if !log.accepted(&join.id()) {
                return Ok(JoinStatus::Invalid { link });
            }
            mine.push(join);
        }
        let view = ServerView::build(server, &log).ok_or(ErrorCode::Internal)?;
        // A member without a name here (a restore) keeps the profile the
        // server holds: an empty one would replace my name for everyone.
        let post_profile = !(member && me.profile.display_name.trim().is_empty());
        let profile = post_profile
            .then(|| {
                let p = &me.profile;
                let action = model::profile_action_with(&p.display_name, p.avatar_small.as_deref(), p.color.as_deref());
                sign(&view, view.deps(None), &action)
            })
            .transpose()?;
        for record in log.records.iter().chain(&log.channel) {
            self.db.put_record(record)?;
        }
        self.logs.insert(server, log);
        if let Some(profile) = profile {
            mine.push(profile.clone());
            self.store(server, profile)?;
        }
        // Likewise a member without a birth date keeps its earlier claim:
        // a claim from no date would say "not adult", which counts at once.
        if !age_unknown_member {
            if let Some(claim) = self.age_claim(ports, server)? {
                mine.push(claim.clone());
                self.store(server, claim)?;
            }
        }
        for record in &mine {
            ports.network.publish(record);
        }
        self.save_secret(server, secret)?;
        self.db.add_server(server, ports.clock.now_ms())?;
        events.push(Event::ServerAdded(self.summary(server)?));
        Ok(JoinStatus::Joined { link, server_id: server_hex })
    }
}

impl ServerView<'_> {
    /// `me` picks my own invite for the link when I have one.
    /// `secret`: the server's sync secret, which the link carries (GAP-4).
    fn summary(&self, me: Option<PublicKey>, secret: Option<&[u8; 32]>) -> ServerSummary {
        let id = model::hex_id(self.id.as_bytes());
        // No usable invite left, or no secret: no link.
        let invite_link = match (self.invite(me), secret) {
            (Some(invite), Some(secret)) => model::invite_link(self.id, invite, secret),
            _ => String::new(),
        };
        // The latest accepted rename, else the genesis name.
        let name = self.state.server_name.clone().unwrap_or_else(|| self.genesis.name.clone());
        ServerSummary {
            initials: model::initials(&name),
            name,
            color: model::color_for(self.id.as_bytes()),
            age_restriction: self.genesis.age_restriction,
            owner_id: model::hex_id(self.owner.as_bytes()),
            invite_link,
            unread: false,
            mentions: 0,
            closed: self.state.closed.is_some(),
            icon_data_url: self.state.server_icon.as_ref().map(crate::avatar::icon_data_url),
            description: self.state.server_description.clone(),
            id,
        }
    }

    /// The channels authority knows, with their names as created; a server
    /// from before #113 shows its derived #general.
    /// TODO(#116): hide 18+ channels from members without an 18+ claim.
    ///
    /// The one place 18+ channels, with their names and G-14 topics, are
    /// withheld from members without an 18+ claim: `listChannels`, every
    /// `channel.updated` (`channel_json`, `topic_events`) and anything later
    /// that quotes a channel go through here. Display-only (GAP-22): the
    /// control log is plaintext to every member.
    fn channels(&self, me: Option<PublicKey>) -> Vec<Channel> {
        let server_id = model::hex_id(self.id.as_bytes());
        let positions = self.channel_positions();
        let channel = |id: ChannelId, name: &str, adult: bool, general: bool| Channel {
            id: model::hex_id(id.as_bytes()),
            server_id: server_id.clone(),
            name: name.to_owned(),
            adult,
            unread: false,
            mentions: 0,
            is_default: general,
            first_unread_index: None,
            unread_count: None,
            position: positions.get(&id).cloned(),
            topic: self.state.topics.get(&id).cloned(),
        };
        if self.state.channels.is_empty() && self.state.deleted_channels.is_empty() {
            return vec![channel(model::default_channel(self.id), model::GENERAL, false, true)];
        }
        // B7: 18+ channels only for members with an accepted 18+ claim.
        let adult = me.is_some_and(|me| self.state.adults.contains(&me));
        self.ordered_channels()
            .into_iter()
            .filter_map(|id| self.state.channels.get(&id).map(|c| (id, c)))
            .filter(|(_, c)| adult || !c.adult)
            .map(|(id, c)| channel(id, &c.name, c.adult, c.general))
            .collect()
    }

    /// G-11: every live channel in order. Placed ones first, by key (then
    /// ID, for keys two admins happened to pick alike); the rest after, in
    /// the order they were made (`creation_order`, #323).
    fn ordered_channels(&self) -> Vec<ChannelId> {
        let positions = self.channel_positions();
        let created = self.creation_order();
        let mut ids: Vec<ChannelId> = self.state.channels.keys().copied().collect();
        ids.sort_by(|a, b| match (positions.get(a), positions.get(b)) {
            (Some(x), Some(y)) => x.cmp(y).then(a.cmp(b)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => created.get(a).cmp(&created.get(b)),
        });
        ids
    }
}

/// B7-k: who a channel's key is for, as the cipher counts it: the
/// members, and for an 18+ channel only those with an accepted 18+ claim.
fn channel_readers(view: &ServerView, channel: ChannelId) -> BTreeSet<PublicKey> {
    let members = view.state.members.iter().copied();
    if view.state.channels.get(&channel).is_some_and(|c| c.adult) {
        members.filter(|m| view.state.adults.contains(m)).collect()
    } else {
        members.collect()
    }
}

/// Control heads a channel record relies on, at most `MAX_AUTH_DEPS`.
fn auth_deps(view: &ServerView) -> Vec<RecordId> {
    let heads = view.deps(None);
    heads[heads.len().saturating_sub(records::MAX_AUTH_DEPS)..].to_vec()
}

/// What `message.updated` compares: the edit, the deletion, the send state
/// and (G-26) the reactions shown.
type Announced = (Option<u64>, bool, Option<SendState>, Vec<(String, Vec<PublicKey>)>);

/// Where my messages' send states come from: the network's live state and
/// the last one stored, so a restart doesn't lose it.
struct Status<'a> {
    net: &'a dyn Network,
    db: &'a Db,
}

fn announced(s: &chat::Shown, me: Option<PublicKey>, st: &Status) -> Announced {
    (s.edited_at, s.deleted, send_state(s, me, st), s.reactions.clone())
}

/// B6, on my own messages only: `pending` until it left this device,
/// `sent` once it did (`NodeEvent::Sent`), `received` once a member's node
/// acknowledged it (`NodeEvent::Delivered`). The higher of the live state
/// and the stored one counts, and a live advance is stored, so a message
/// written offline is still `pending` after a restart. A network that
/// doesn't track this (in process) says `sent`.
fn send_state(s: &chat::Shown, me: Option<PublicKey>, st: &Status) -> Option<SendState> {
    if Some(s.record.author()) != me {
        return None;
    }
    let id = s.record.id();
    let live = st.net.send_state(id);
    let stored = st.db.send_state(id).ok().flatten();
    if live.map(rank) > stored.map(rank) {
        // Best effort: losing it only shows an older state.
        let _ = st.db.set_send_state(id, live.expect("compared above"));
    }
    Some(match (live, stored) {
        (None, None) => SendState::Sent,
        (a, b) => a.into_iter().chain(b).max_by_key(|s| rank(*s)).expect("one is set"),
    })
}

fn rank(state: SendState) -> u8 {
    match state {
        SendState::Pending | SendState::Failed => 0,
        SendState::Sent => 1,
        SendState::Received => 2,
    }
}

fn message_json(
    s: &chat::Shown,
    index: usize,
    channel: ChannelId,
    me: Option<PublicKey>,
    st: &Status,
    members: &BTreeSet<PublicKey>,
) -> Message {
    // G-24: `<@userId>` tokens; only current members are listed (the UI
    // shows a former member's token as "Former member"), and "mentions me"
    // from the token alone.
    let tokens = model::mention_tokens(&s.text);
    let listed: Vec<Id> = tokens
        .iter()
        .filter(|key| members.contains(*key))
        .map(|key| model::hex_id(key.as_bytes()))
        .collect();
    Message {
        id: model::hex_id(s.record.id().as_bytes()),
        channel_id: model::hex_id(channel.as_bytes()),
        index,
        author_id: model::hex_id(s.record.author().as_bytes()),
        body: s.text.clone(),
        created_at: s.record.ts(),
        edited_at: s.edited_at,
        deleted: s.deleted.then_some(true),
        send_state: send_state(s, me, st),
        replaces: None,
        mentions: (!listed.is_empty()).then_some(listed),
        mentions_me: me.filter(|me| tokens.contains(me)).map(|_| true),
        reactions: reactions_json(&s.reactions, me),
    }
}

/// G-26: `Message.reactions`, absent when there are none.
fn reactions_json(shown: &[(String, Vec<PublicKey>)], me: Option<PublicKey>) -> Option<Vec<ReactionCount>> {
    let list: Vec<ReactionCount> = shown
        .iter()
        .map(|(emoji, authors)| ReactionCount {
            emoji: emoji.clone(),
            count: authors.len() as u32,
            mine: me.is_some_and(|me| authors.contains(&me)),
        })
        .collect();
    (!list.is_empty()).then_some(list)
}
/// Can't write yet (no key, or a rotation only a moderator can make):
/// `not-allowed`. No group encryption: `not-implemented`.
fn cipher_error(error: CipherError) -> CoreError {
    match error {
        CipherError::NoKey | CipherError::RotationRequired => ErrorCode::NotAllowed.into(),
        CipherError::Unavailable => ErrorCode::NotImplemented.into(),
        CipherError::Rejected => ErrorCode::Internal.into(),
    }
}

/// Hands the group cipher our member secret: at identity load, create and
/// restore, and again after the app lock (`Core::unlock_keys`). The next
/// read or send gives it the channels, the accepted set and the stored
/// rotations again (`chat::sync_cipher`).
fn unlock_cipher(ports: &Ports, me: Option<&Me>) {
    if let Some(me) = me {
        ports.cipher.unlock(Arc::new(MemberSecret::new(me.identity.signing_key())));
        // GAP-4: peer bindings with the identity key.
        ports.network.unlock(me.identity.signing_key());
    }
}

/// A join status's name for the join log (no link, no IDs).
/// G-78: the app lock's settings and verifier, and its attempt counter.
const KV_APP_LOCK: &str = "app-lock";
const KV_APP_LOCK_ATTEMPTS: &str = "app-lock-attempts";

/// G-78: what a passcode or words attempt checks, run outside the core lock
/// (Argon2id takes 19 MiB and some tens of ms).
enum LockCheck {
    /// Against the stored verifier.
    Passcode(Zeroizing<String>),
    /// The 12 words against my identity (the restore check).
    Words(Zeroizing<String>),
}

impl Core {
    /// G-78 `getAppLock`: the settings, never the verifier or the salt.
    pub fn get_app_lock(&self) -> CoreResult<AppLock> {
        let now = self.ports.clock.now_ms();
        let inner = self.lock();
        let stored = app_lock_stored(&inner.db)?;
        let wait = app_lock_attempts(&inner.db)?.wait_ms(now);
        Ok(AppLock {
            // Any record counts, readable or not: an unreadable one is a lock
            // that no passcode opens (Security Lead on #476), never "off".
            enabled: app_lock_present(&inner.db)?,
            method: stored.as_ref().map_or(AppLockMethod::Passcode, |s| s.method),
            idle_minutes: stored.as_ref().map_or(applock::DEFAULT_IDLE_MINUTES, |s| s.idle_minutes),
            lock_on_sleep: stored.as_ref().is_none_or(|s| s.lock_on_sleep),
            retry_after: wait.map(applock::retry_after_secs),
        })
    }

    /// G-78 `verifyAppLock`. With no lock set there's nothing to check: `ok`.
    pub fn verify_app_lock(&self, passcode: Zeroizing<String>) -> CoreResult<AppLockAnswer> {
        let _gate = self.app_lock_gate.lock().expect("not poisoned");
        if !app_lock_present(&self.lock().db)? {
            return Ok(AppLockAnswer { result: AppLockResult::Ok, retry_after: None });
        }
        self.app_lock_attempt(LockCheck::Passcode(passcode))
    }

    /// G-78 `setAppLock`: a new passcode and settings. When a lock is set,
    /// `current` must check out first (and counts as an attempt). A bad new
    /// passcode or setting is `bad-request`, checked before anything counts.
    pub fn set_app_lock(
        &self,
        current: Option<Zeroizing<String>>,
        passcode: Zeroizing<String>,
        method: AppLockMethod,
        idle_minutes: u8,
        lock_on_sleep: bool,
    ) -> CoreResult<AppLockAnswer> {
        if !applock::new_passcode_ok(&passcode) || !applock::IDLE_MINUTES.contains(&idle_minutes) {
            return Err(ErrorCode::BadRequest.into());
        }
        let _gate = self.app_lock_gate.lock().expect("not poisoned");
        if app_lock_present(&self.lock().db)? {
            let current = current.ok_or(ErrorCode::BadRequest)?;
            let answer = self.app_lock_attempt(LockCheck::Passcode(current))?;
            if answer.result != AppLockResult::Ok {
                return Ok(answer);
            }
        }
        let mut salt = [0u8; 16];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut salt);
        let params = identity::LockParams::MIN;
        // Argon2id outside the core lock.
        let hash = identity::app_lock_verifier(&passcode, &salt, params).ok_or(ErrorCode::Internal)?;
        let stored = applock::Stored {
            v: 1,
            salt: hex::encode(salt),
            m_kib: params.m_kib,
            t: params.t,
            p: params.p,
            hash: hex::encode(*hash),
            method,
            idle_minutes,
            lock_on_sleep,
        };
        self.lock().db.set(KV_APP_LOCK, &serde_json::to_vec(&stored).expect("plain struct"))?;
        Ok(AppLockAnswer { result: AppLockResult::Ok, retry_after: None })
    }

    /// G-78 `clearAppLock`: turns the lock off after `current` checks out.
    pub fn clear_app_lock(&self, current: Zeroizing<String>) -> CoreResult<AppLockAnswer> {
        let _gate = self.app_lock_gate.lock().expect("not poisoned");
        if !app_lock_present(&self.lock().db)? {
            return Ok(AppLockAnswer { result: AppLockResult::Ok, retry_after: None });
        }
        let answer = self.app_lock_attempt(LockCheck::Passcode(current))?;
        if answer.result == AppLockResult::Ok {
            self.lock().db.delete(KV_APP_LOCK)?;
        }
        Ok(answer)
    }

    /// G-78 `clearAppLockWithWords` ("forgot the passcode"): turns the lock
    /// off when the 12 words are this identity's. Rate-limited by the same
    /// counter; unknown or another identity's words are just `wrong`.
    pub fn clear_app_lock_with_words(&self, words: Zeroizing<String>) -> CoreResult<AppLockAnswer> {
        if words.len() > applock::MAX_WORDS_LEN {
            return Err(ErrorCode::BadRequest.into());
        }
        let _gate = self.app_lock_gate.lock().expect("not poisoned");
        if self.lock().me.is_none() {
            return Err(ErrorCode::NotFound.into());
        }
        let answer = self.app_lock_attempt(LockCheck::Words(words))?;
        if answer.result == AppLockResult::Ok {
            self.lock().db.delete(KV_APP_LOCK)?;
        }
        Ok(answer)
    }

    /// One attempt against the shared counter (the gate is held): while a
    /// delay runs, `rate-limited` without checking; otherwise the check runs
    /// outside the core lock, and the counter is reset or advanced.
    fn app_lock_attempt(&self, check: LockCheck) -> CoreResult<AppLockAnswer> {
        let now = self.ports.clock.now_ms();
        let (stored, attempts, me) = {
            let inner = self.lock();
            (app_lock_stored(&inner.db)?, app_lock_attempts(&inner.db)?, inner.me.as_ref().map(Me::key))
        };
        if let Some(wait) = attempts.wait_ms(now) {
            let retry_after = Some(applock::retry_after_secs(wait));
            return Ok(AppLockAnswer { result: AppLockResult::RateLimited, retry_after });
        }
        let right = match check {
            LockCheck::Passcode(passcode) => stored.as_ref().is_some_and(|s| app_lock_matches(s, &passcode)),
            LockCheck::Words(words) => me.is_some_and(|me| {
                RecoveryPhrase::parse(&words).is_ok_and(|phrase| phrase.identity().public_key() == me)
            }),
        };
        let mut attempts = attempts;
        let answer = if right {
            attempts = applock::Attempts::default();
            AppLockAnswer { result: AppLockResult::Ok, retry_after: None }
        } else {
            attempts.fail(now);
            let retry_after = attempts.wait_ms(now).map(applock::retry_after_secs);
            AppLockAnswer { result: AppLockResult::Wrong, retry_after }
        };
        self.lock()
            .db
            .set(KV_APP_LOCK_ATTEMPTS, &serde_json::to_vec(&attempts).expect("plain struct"))?;
        Ok(answer)
    }
}

/// The stored lock, if it parses. A record that doesn't (or has another
/// `v`) is still a lock: see [`app_lock_present`].
fn app_lock_stored(db: &Db) -> CoreResult<Option<applock::Stored>> {
    Ok(db.get(KV_APP_LOCK)?.and_then(|json| serde_json::from_slice(&json).ok()))
}

/// Whether any app-lock record is stored. An unreadable one still means
/// "on": verify, set and clear then answer `wrong` (counted), and only the
/// 12 words clear it. Fail closed (Security Lead on #476).
fn app_lock_present(db: &Db) -> CoreResult<bool> {
    Ok(db.get(KV_APP_LOCK)?.is_some())
}

fn app_lock_attempts(db: &Db) -> CoreResult<applock::Attempts> {
    Ok(db.get(KV_APP_LOCK_ATTEMPTS)?.and_then(|json| serde_json::from_slice(&json).ok()).unwrap_or_default())
}

/// The passcode against the stored verifier, in constant time. A passcode
/// outside the rules, or a stored record that doesn't parse, never matches.
fn app_lock_matches(stored: &applock::Stored, passcode: &str) -> bool {
    if stored.v != 1 || !applock::attempt_ok(passcode) {
        return false;
    }
    let (Ok(salt), Some(want)) = (hex::decode(&stored.salt), model::parse_hex32(&stored.hash)) else {
        return false;
    };
    let params = identity::LockParams { m_kib: stored.m_kib, t: stored.t, p: stored.p };
    let Some(got) = identity::app_lock_verifier(passcode, &salt, params) else { return false };
    got.iter().zip(want.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// G-91 (Security Lead on #457): whether a restore's join answer settles
/// that server for good. Only a definite answer does:
/// - `Joined`: it's back;
/// - `Closed`: its owner closed it;
/// - `Invalid` with evidence ([`removal_shown`]): the log shows an accepted
///   kick or leave of me, so authority refuses the join.
///
/// Anything else waits for the next try: `NobodyOnline`, `Searching`,
/// `AgeBlocked` (it depends on whether the log shows me as a member, which
/// a partial log can miss: Security Lead on #457),
/// `Invalid` without that evidence (a partial log), and every error
/// (locked, network, internal). One bad round never loses a server.
/// G-91 (Security Lead on #457): whether the fetched log shows I left this
/// server: an accepted kick of me, or an accepted leave of mine. Only then
/// is a restore's "invalid" final; a log missing my join (or the kick)
/// proves nothing, and the server waits for a fuller answer.
fn removal_shown(server: ServerId, me: PublicKey, fetched: &[Record]) -> bool {
    let log = Log::new(server, fetched.iter().cloned());
    let Some(view) = ServerView::build(server, &log) else { return false };
    if view.state.is_member(me) {
        return false;
    }
    view.is_kicked(&me)
        || log.records.iter().any(|r| r.kind() == Kind::Leave && r.author() == me && log.accepted(&r.id()))
}

fn restore_settles(status: &CoreResult<JoinStatus>, judged: bool) -> bool {
    match status {
        Ok(JoinStatus::Joined { .. } | JoinStatus::Closed { .. }) => true,
        Ok(JoinStatus::Invalid { .. }) => judged,
        Ok(JoinStatus::NobodyOnline { .. } | JoinStatus::Searching { .. } | JoinStatus::AgeBlocked { .. }) | Err(_) => false,
    }
}

fn join_status_name(status: &JoinStatus) -> &'static str {
    match status {
        JoinStatus::Searching { .. } => "searching",
        JoinStatus::NobodyOnline { .. } => "nobody-online",
        JoinStatus::Joined { .. } => "joined",
        JoinStatus::Invalid { .. } => "invalid",
        JoinStatus::AgeBlocked { .. } => "age-blocked",
        JoinStatus::Closed { .. } => "closed",
    }
}


/// A device notice's label as shown: plain text, trimmed, at most 64
/// characters, with no control characters; anything else, or empty, is
/// left out (Security Lead on #415). Today the new device sends none; the
/// cross-device notice will pass what it carries through here.
fn notice_label(raw: Option<&str>) -> Option<String> {
    let label = raw?.trim();
    let ok = !label.is_empty() && label.chars().count() <= 64 && !label.chars().any(hidden_char);
    ok.then(|| label.to_owned())
}
/// Characters a label must not hold: controls, plus the invisible format and
/// direction marks `char::is_control` misses (zero-width, bidi embeddings,
/// overrides and isolates, word joiner, line/paragraph separators, BOM),
/// which could make a label render reversed or hide text.
fn hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
}
fn device_notices(db: &Db) -> CoreResult<Vec<u64>> {
    Ok(db.get(KV_DEVICE_NOTICES)?.and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or_default())
}

fn link_state(state: DeviceLinkPhase, sas: Option<String>, reason: Option<DeviceLinkReason>) -> Event {
    Event::DeviceLinkState(DeviceLinkState { state, sas, reason })
}

fn link_error(e: DeviceLinkError) -> CoreError {
    match e {
        DeviceLinkError::NotFound => ErrorCode::NotFound.into(),
        // Another device's Hello holds the link: someone else may be trying
        // (Security Lead on #394; dev-ui shows "start again").
        DeviceLinkError::Refused => ErrorCode::LockedOut.into(),
        DeviceLinkError::Network => ErrorCode::Offline.into(),
    }
}

#[cfg(test)]
mod relay_only_tests {
    use super::{stored_relay_only, Db, KV_RELAY_ONLY};

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mvs-relayonly-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Security lead (#272): stored_relay_only fails closed.
    #[test]
    fn the_stored_setting_fails_closed() {
        let dir = dir("unit");
        let db = dir.join("core.db");
        // A fresh data dir: no setting yet, so off.
        assert!(!stored_relay_only(&db));
        // Off and on as stored; anything else is on.
        for (value, on) in [(&[0u8][..], false), (&[1], true), (&[2], true), (b"", true)] {
            Db::open(Some(&db)).unwrap().set(KV_RELAY_ONLY, value).unwrap();
            assert_eq!(stored_relay_only(&db), on, "{value:?}");
        }
        // Can't be opened (its folder is missing) or isn't a database: on.
        assert!(stored_relay_only(&dir.join("missing").join("core.db")));
        let junk = dir.join("junk.db");
        std::fs::write(&junk, vec![0x5a; 4096]).unwrap();
        assert!(stored_relay_only(&junk));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod device_notice_tests {
    use super::{notice_label, restore_settles, Db, KV_DEVICE_NOTICES, MAX_DEVICE_NOTICES};
    use crate::types::{AgeRestriction, ErrorCode, JoinStatus};

    /// G-91 (Security Lead on #457): only a definite answer drops a server
    /// from a restore; a temporary one waits for the next try.
    #[test]
    fn only_definite_join_answers_settle_a_restored_server() {
        let link = String::new;
        let joined = JoinStatus::Joined { link: link(), server_id: "s".into() };
        let blocked = JoinStatus::AgeBlocked { link: link(), required: AgeRestriction::Eighteen };
        for status in [joined, JoinStatus::Closed { link: link() }] {
            assert!(restore_settles(&Ok(status.clone()), false), "{status:?}");
        }
        assert!(!restore_settles(&Ok(blocked), true), "age-blocked waits: a partial log can miss my membership");
        let invalid = JoinStatus::Invalid { link: link() };
        assert!(restore_settles(&Ok(invalid.clone()), true), "kicked or not a member");
        assert!(!restore_settles(&Ok(invalid), false), "a partial fetch: not yet");
        for status in [JoinStatus::NobodyOnline { link: link() }, JoinStatus::Searching { link: link() }] {
            assert!(!restore_settles(&Ok(status.clone()), true), "{status:?}");
        }
        for code in [ErrorCode::Internal, ErrorCode::NotFound, ErrorCode::NotAllowed, ErrorCode::BadRequest] {
            assert!(!restore_settles(&Err(code.into()), true), "{code:?}");
        }
    }

    /// Security Lead on #415: a label is plain text, at most 64 characters.
    #[test]
    fn labels_are_plain_short_text_or_left_out() {
        assert_eq!(notice_label(Some("  Windows laptop ")).as_deref(), Some("Windows laptop"));
        assert_eq!(notice_label(Some(&"א".repeat(64))).map(|l| l.chars().count()), Some(64));
        assert_eq!(notice_label(Some(&"x".repeat(65))), None);
        assert_eq!(notice_label(Some("bad\u{1b}[31m")), None);
        assert_eq!(notice_label(Some("two\nlines")), None);
        for bad in ["\u{202E}gpj.exe", "a\u{200B}b", "a\u{200F}", "\u{2066}x\u{2069}", "\u{FEFF}x", "x\u{061C}", "a\u{2028}b", "a\u{2060}b"] {
            assert_eq!(notice_label(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(notice_label(Some("מחשב נייד")).as_deref(), Some("מחשב נייד"));
        assert_eq!(notice_label(Some("   ")), None);
        assert_eq!(notice_label(None), None);
    }

    /// Tech Lead on #415: the stored list keeps only the newest 32.
    #[test]
    fn the_notice_list_is_capped() {
        let db = Db::open(None).unwrap();
        let notices: Vec<u64> = (0..40).collect();
        let extra = notices.len().saturating_sub(MAX_DEVICE_NOTICES);
        let kept: Vec<u64> = notices[extra..].to_vec();
        db.set(KV_DEVICE_NOTICES, &serde_json::to_vec(&kept).unwrap()).unwrap();
        let stored = super::device_notices(&db).unwrap();
        assert_eq!(stored.len(), 32);
        assert_eq!((stored[0], stored[31]), (8, 39), "the newest are kept");
    }
}

#[cfg(test)]
mod birth_date_tests {
    use super::{PendingBirth, Profile, AGE_RAISE_DELAY_MS};

    /// 2026-11-03.
    const NOW: u64 = 20_760 * 86_400_000;

    fn profile(birth: &str, pending: Option<PendingBirth>) -> Profile {
        Profile { birth_date: birth.into(), pending_birth_date: pending, ..Profile::default() }
    }

    fn pending(date: &str, correction: bool, capped: bool) -> Option<PendingBirth> {
        Some(PendingBirth { date: date.into(), effective_at: NOW + AGE_RAISE_DELAY_MS, correction, capped })
    }

    /// G-77: a correction counts from the current date until it settles,
    /// then its date replaces it; the restore form counts at most 17; a
    /// correction made over a waiting restore-form raise keeps the cap.
    #[test]
    fn corrections_count_from_the_current_date_until_they_settle() {
        let mut fix = profile("2010-01-01", pending("1990-01-01", true, false));
        assert_eq!(fix.effective_age(NOW), Some(16));
        assert!(!fix.settle(NOW + AGE_RAISE_DELAY_MS - 1));
        assert!(fix.pending_birth_date.is_some(), "not due: kept");
        assert!(fix.settle(NOW + AGE_RAISE_DELAY_MS));
        assert_eq!(fix.birth_date, "1990-01-01");
        assert!(fix.pending_birth_date.is_none() && fix.birth_date_trusted);

        let restored = profile("1990-01-01", pending("1990-01-01", false, false));
        assert_eq!(restored.effective_age(NOW), Some(17));
        let mut over = profile("1990-01-01", pending("1980-01-01", true, true));
        assert_eq!(over.effective_age(NOW), Some(17), "the restore cap stays");
        assert!(over.settle(NOW + AGE_RAISE_DELAY_MS));
        assert_eq!(over.effective_age(NOW + AGE_RAISE_DELAY_MS), Some(46));

        // An adult raising an adult age: no cap while it waits.
        let older = profile("1990-01-01", pending("1980-01-01", true, false));
        assert_eq!(older.effective_age(NOW), Some(36));
    }

    /// Tech Lead on #512: a lowering (or the same date) over a waiting
    /// restore cap keeps the cap until its own time, for the new date; a
    /// raise over it keeps it too. Without a cap, a lowering leaves nothing.
    #[test]
    fn a_restore_cap_survives_corrections() {
        use crate::types::AgeCorrectionKind::{Lower, Raise, Same};
        let until = NOW + AGE_RAISE_DELAY_MS;
        // Restored as 1990 (capped at 17); "corrected" to 17 today, 18 tomorrow.
        let mut p = profile("1990-01-01", pending("1990-01-01", false, false));
        p.correct(Lower, "2008-11-04", 0, NOW);
        assert_eq!(p.birth_date, "2008-11-04");
        let kept = p.pending_birth_date.as_ref().unwrap();
        assert_eq!((kept.effective_at, kept.correction), (until, false), "the cap stays, uncancellable");
        assert_eq!(p.effective_age(NOW + 2 * 86_400_000), Some(17), "18 by date, still capped");
        assert_eq!(p.effective_age(until), Some(18));

        let mut same = profile("1990-01-01", pending("1990-01-01", false, false));
        same.correct(Same, "1990-01-01", 0, NOW);
        assert_eq!(same.effective_age(NOW), Some(17));

        let mut raised = profile("1990-01-01", pending("1990-01-01", false, false));
        raised.correct(Raise, "1980-01-01", NOW + 2 * AGE_RAISE_DELAY_MS, NOW);
        assert!(raised.pending_birth_date.as_ref().unwrap().capped);
        assert_eq!(raised.effective_age(NOW), Some(17));

        let mut free = profile("1990-01-01", None);
        free.correct(Lower, "2000-01-01", 0, NOW);
        assert!(free.pending_birth_date.is_none());
        assert_eq!(free.effective_age(NOW), Some(26));
    }

    /// Profiles saved before G-77 read their pending as the restore form.
    #[test]
    fn an_old_pending_reads_as_the_restore_form() {
        let old: PendingBirth = serde_json::from_str(r#"{"date":"1990-01-01","effectiveAt":5}"#).unwrap();
        assert!(!old.correction && !old.capped);
    }
}
