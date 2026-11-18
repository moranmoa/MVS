//! JSON shapes, mirroring `ui/src/core/types.ts` field for field (camelCase).
//! Fields marked "Rust addition" are not in the TS types yet; the TS side
//! ignores unknown fields, so they are safe to send.

use serde::{Deserialize, Serialize};

pub type Id = String;
/// Milliseconds since the Unix epoch.
pub type Timestamp = u64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: Id,
    pub short_code: String,
    pub display_name: String,
    pub avatar_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_data_url: Option<String>,
    /// #354: my chosen colour (`#rrggbb`), shown to other members.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub country: String,
    pub birth_date: String,
    /// B7 §9: a correction that raises my age, waiting its 30 days
    /// (decision 18). Until `effectiveAt` I count as under 18.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_birth_date: Option<PendingBirthDate>,
    pub recovery_checked: bool,
}

/// `Identity.pendingBirthDate`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingBirthDate {
    /// `YYYY-MM-DD`, as `Identity.birthDate`.
    pub date: String,
    /// Milliseconds since the epoch.
    pub effective_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    He,
    En,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewIdentityInput {
    pub locale: Locale,
    pub country: String,
    pub birth_date: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_data_url: Option<String>,
    /// #354: the small picture shown to other members (`avatar::valid_avatar`).
    /// Absent: unchanged. `""`: none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_small: Option<String>,
    /// #354: `#rrggbb`. Absent: unchanged. `""`: none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgeRestriction {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "16+")]
    Sixteen,
    #[serde(rename = "18+")]
    Eighteen,
}

impl AgeRestriction {
    pub fn min_age(self) -> u32 {
        match self {
            AgeRestriction::None => 0,
            AgeRestriction::Sixteen => 16,
            AgeRestriction::Eighteen => 18,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSummary {
    pub id: Id,
    pub name: String,
    pub initials: String,
    pub color: String,
    pub age_restriction: AgeRestriction,
    pub owner_id: Id,
    pub invite_link: String,
    pub unread: bool,
    pub mentions: u32,
    /// Server lifecycle: the owner closed it. It stays listed, read-only,
    /// for 30 days after the close was received (additive).
    #[serde(default)]
    pub closed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: Id,
    pub server_id: Id,
    pub name: String,
    pub adult: bool,
    pub unread: bool,
    pub mentions: u32,
    /// #general, the first channel (#150): it can't be deleted.
    pub is_default: bool,
    /// G-11: the channel's order key (base-62, at most 32 characters), when
    /// an owner or admin placed it. The order is `listChannels`' order; the
    /// key is informational only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    /// G-14: the channel's topic, one line; absent when there is none. It
    /// is plaintext in the control log, readable by every member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// G-21: the index (as in `getMessages`) of the first message after my
    /// read marker that isn't mine; absent with nothing unread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_unread_index: Option<u64>,
    /// G-21: how many messages after my read marker aren't mine (0 too).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_count: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SendState {
    Pending,
    Sent,
    Received,
    Failed,
}

/// `Message` in types.ts. TODO: replies, edits, deletes, mentions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: Id,
    pub channel_id: Id,
    /// Position in the channel as shown, oldest first.
    pub index: usize,
    pub author_id: Id,
    pub body: String,
    pub created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<Timestamp>,
    /// A tombstone: the message keeps its place, its body is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
    /// Only on messages written on this device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_state: Option<SendState>,
    /// On the `message.updated` that sends a message held for its key: the
    /// provisional ID (`pending-…`) it replaces in the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<Id>,
    /// G-24: the user IDs this message mentions (`<@userId>` tokens in the
    /// body) who are members of the server now, in order, each once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Id>>,
    /// G-24: the body mentions me.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions_me: Option<bool>,
    /// G-26: up to 20 emoji, the most popular, listed in the order they
    /// first appeared; absent when there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<ReactionCount>>,
}

/// `getSettings`: what the core keeps on this device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSettings {
    /// G-29: "Show others when I'm typing" (default on).
    pub typing_indicator: bool,
}

/// G-26: one emoji under a message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionCount {
    pub emoji: String,
    /// How many members have it on.
    pub count: u32,
    /// I have it on.
    pub mine: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRange {
    pub channel_id: Id,
    pub start: usize,
    pub messages: Vec<Message>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Online,
    Offline,
}

/// Rust addition: a member's role, from `authority`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Moderator,
    Member,
}

impl From<authority::Role> for Role {
    fn from(role: authority::Role) -> Role {
        match role {
            authority::Role::Owner => Role::Owner,
            authority::Role::Admin => Role::Admin,
            authority::Role::Moderator => Role::Moderator,
            authority::Role::Member => Role::Member,
        }
    }
}

impl Role {
    pub(crate) fn to_authority(self) -> authority::Role {
        match self {
            Role::Owner => authority::Role::Owner,
            Role::Admin => authority::Role::Admin,
            Role::Moderator => authority::Role::Moderator,
            Role::Member => authority::Role::Member,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: Id,
    pub server_id: Id,
    pub display_name: String,
    pub short_code: String,
    pub avatar_color: String,
    pub presence: Presence,
    /// #187: how we reach this member while online: `direct` (LAN) or
    /// `relay`; `null` for us and for members who are offline.
    pub connection: Option<Connection>,
    pub is_owner: bool,
    /// Rust addition.
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// #354: their small profile picture (a checked WebP or PNG data URL,
    /// at most 64×64), from their latest profile posts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_data_url: Option<String>,
    /// #354: their chosen colour (`#rrggbb`); `avatarColor` is the derived one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Every command rejects with this shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    pub code: ErrorCode,
    /// 1-based word positions that were not recognised (restore).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positions: Option<Vec<usize>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    InvalidWords,
    NotAllowed,
    NotFound,
    RecoveryCheckRequired,
    /// OS authentication was cancelled (the app lock). TODO(app lock).
    AuthCancelled,
    /// The recovery-word challenge is burned (B19 §6).
    TooManyAttempts,
    /// Another channel of the server has this name (B11).
    NameTaken,
    /// The OS keychain (Secret Service on Linux) is missing or unusable
    /// (QA-20): the core runs, but nothing that needs the identity works.
    KeyringUnavailable,
    /// Voice: the call already has 5 participants (the mesh cap).
    CallFull,
    /// Voice: relay-only is on, so calls are off.
    RelayOnly,
    /// Voice: my own identity is already in this room from another
    /// computer (same recovery words). One computer per call until linked
    /// devices (phase 3).
    InCallElsewhere,
    /// Voice rooms: the server has 10 live rooms (by this core's view).
    RoomCap,
    /// Server lifecycle: a member still runs a version that can't read a
    /// rename, leave or delete (no `server-lifecycle-v1` cap); nothing was
    /// signed.
    UpdateNeeded,
    /// Rust addition: malformed command JSON or arguments.
    BadRequest,
    /// Rust addition: in the contract, not done by this core yet.
    NotImplemented,
    /// Rust addition: storage or keychain failure. Never carries details.
    Internal,
    /// In-app update (B8): the update host can't be reached.
    Offline,
    /// In-app update: any verification failure; details only in the log.
    InvalidUpdate,
    /// In-app update: a manifest issued in the future, or all expired.
    CheckClock,
    NothingToDownload,
    NothingStaged,
    /// Device link: too many attempts at this link. Reactions (G-26): 30
    /// of mine in one channel within a minute.
    RateLimited,
    /// Device link: another device holds this link (someone else may be
    /// trying).
    LockedOut,
    DiskFull,
}

impl CoreError {
    pub fn new(code: ErrorCode) -> CoreError {
        CoreError { code, positions: None }
    }
}

impl From<ErrorCode> for CoreError {
    fn from(code: ErrorCode) -> CoreError {
        CoreError::new(code)
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(self).unwrap_or_default())
    }
}

impl std::error::Error for CoreError {}

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum JoinStatus {
    Searching {
        link: String,
    },
    NobodyOnline {
        link: String,
    },
    #[serde(rename_all = "camelCase")]
    Joined {
        link: String,
        server_id: Id,
    },
    Invalid {
        link: String,
    },
    AgeBlocked {
        link: String,
        required: AgeRestriction,
    },
    /// Server lifecycle: the server was closed by its owner (an old invite,
    /// or one a stale peer still serves).
    Closed {
        link: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    pub messages_bytes: u64,
    pub files_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub waiting_for_call: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub update_channel: UpdateChannel,
    /// The relay-only setting (`setRelayOnly`): peers are reached only
    /// through the relay, and calls are off.
    #[serde(default)]
    pub relay_only: bool,
}

/// `getRecoveryChallenge`'s result: 1-based positions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryChallenge {
    pub positions: Vec<usize>,
}

/// `RecoveryCheckResult`: `{ ok: true }` or `{ ok: false, wrong: [...] }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryCheckResult {
    pub ok: bool,
    /// 1-based positions answered wrong; absent when `ok`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrong: Option<Vec<usize>>,
}

impl RecoveryCheckResult {
    pub fn passed() -> RecoveryCheckResult {
        RecoveryCheckResult { ok: true, wrong: None }
    }

    pub fn wrong(positions: Vec<usize>) -> RecoveryCheckResult {
        RecoveryCheckResult { ok: false, wrong: Some(positions) }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedIdentity {
    pub identity: Identity,
    pub words: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressStep {
    Keys,
    Storage,
    Encryption,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeKind {
    EncryptionRenewed,
    /// Rust addition: removed members still hold a channel key and only a
    /// moderator can renew it; the channel can't be written to until then.
    RekeyWaiting,
}

/// `CoreEvents` in api.ts, as `{ "event": name, "payload": ... }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum Event {
    #[serde(rename = "identity.progress")]
    IdentityProgress { step: ProgressStep, percent: u8 },
    #[serde(rename = "identity.changed")]
    IdentityChanged(Identity),
    #[serde(rename = "server.added")]
    ServerAdded(ServerSummary),
    #[serde(rename = "server.updated")]
    ServerUpdated(ServerSummary),
    /// I'm no longer in the server. `reason` (additive): `left` or
    /// `closed`; absent for a kick (as before).
    /// Server lifecycle: the owner closed the server (read, or my own
    /// `closeServer`). It stays listed, read-only, until its 30 days are up;
    /// then `server.removed` (`closed`).
    #[serde(rename = "server.closed", rename_all = "camelCase")]
    ServerClosed { server_id: Id },
    #[serde(rename = "server.removed", rename_all = "camelCase")]
    ServerRemoved {
        server_id: Id,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<RemovedReason>,
    },
    #[serde(rename = "channel.added")]
    ChannelAdded(Channel),
    #[serde(rename = "channel.removed", rename_all = "camelCase")]
    ChannelRemoved { server_id: Id, channel_id: Id, name: String },
    #[serde(rename = "channel.updated")]
    ChannelUpdated(Channel),
    #[serde(rename = "members.changed", rename_all = "camelCase")]
    MembersChanged { server_id: Id, members: Vec<Member> },
    #[serde(rename = "join.status")]
    JoinStatus(JoinStatus),
    /// G-47: my block list changed (`setBlocked`, `blockUser`); the whole
    /// list, as `listBlocked` returns it.
    #[serde(rename = "blocks.changed")]
    BlocksChanged { blocked: Vec<BlockedUser> },
    #[serde(rename = "message.updated")]
    MessageUpdated(Message),
    #[serde(rename = "message.added")]
    MessageAdded(Message),
    #[serde(rename = "update.ready")]
    UpdateReady(UpdateInfo),
    /// Voice: my call changed (join, leave, mute, timeout). After a leave,
    /// or a refusal by a full call, its participants are empty.
    #[serde(rename = "call.state")]
    CallState(CallState),
    /// Voice: WebRTC signalling from a participant of my call. Offers and
    /// answers come only verified (see `voice`), so the flag is always true.
    #[serde(rename = "call.signal", rename_all = "camelCase")]
    CallSignal { from: Id, kind: SignalKind, payload: String, fingerprint_verified: bool },
    /// Voice rooms: a server's live rooms changed (created, gone, join,
    /// leave, mute, timeout, kick, rename, limit), mine or not: the whole
    /// list, oldest first. At most one per server per sync round, only
    /// while I'm a member. A hint: `listVoiceRooms` re-reads it.
    #[serde(rename = "voice.rooms", rename_all = "camelCase")]
    VoiceRooms { server_id: Id, rooms: Vec<VoiceRoom> },
    /// G-29: who is typing in a channel now (at most 5, by key), whenever
    /// that changes; at most one per channel per tick. Empty: nobody.
    #[serde(rename = "typing", rename_all = "camelCase")]
    Typing { channel_id: Id, user_ids: Vec<Id> },
    /// Member relays (#368): anything in `getMemberRelay`'s answer changed.
    #[serde(rename = "memberRelay.changed")]
    MemberRelayChanged(MemberRelay),
    /// G-91: bringing my servers back after a restore moved on.
    #[serde(rename = "serverRestore.changed")]
    ServerRestoreChanged(ServerRestore),
    /// Device link, the new device: where its link stands.
    #[serde(rename = "deviceLink.state")]
    DeviceLinkState(DeviceLinkState),
    /// Device link: a new device was added to my account (shown on the
    /// approving device at once).
    #[serde(rename = "account.deviceAdded", rename_all = "camelCase")]
    DeviceAdded {
        at: u64,
        /// A short description of the new device, plain text; left out
        /// when unknown (today always).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Once, after `markHealthy` commits a new version. Text only.
    #[serde(rename = "update.installed")]
    UpdateInstalled { version: String, notes: Option<String> },
    /// Once, on the first healthy start after the launcher rolled back.
    #[serde(rename = "update.rolledBack")]
    UpdateRolledBack { failed: String, running: String },
    #[serde(rename = "notice", rename_all = "camelCase")]
    Notice { kind: NoticeKind, server_id: Id },
}

/// Rust addition (`listRemovedMembers`): an account the owner may let back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedMember {
    pub id: Id,
    pub short_code: String,
    /// Its last display name, if it ever posted one.
    pub display_name: String,
    /// When it was kicked (the kick's claimed time).
    pub removed_at: Timestamp,
}

/// G-47 (`listBlocked`): an account I blocked, whether or not we share a
/// server now. `name`: its display name where we share a server, else the
/// one known when I blocked it; absent if none was ever known.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedUser {
    pub user_id: Id,
    /// G-47b (UX-19): the identity code, as `Member.shortCode`, derived
    /// from `userId`, so two rows without a name can be told apart.
    pub short_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Rust addition (`createInvite`, #208): the new invite and its link.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvite {
    pub id: Id,
    pub link: String,
    /// T8-02: the short v1 link (`mvs://join/` + at most 51 base58
    /// characters). Additive: `link` stays v0 until release N+1 switches
    /// creation to v1 (design §7).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub short_link: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<u32>,
}

/// Rust addition (`listInvites`, #208): one invite of a server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInfo {
    pub id: Id,
    /// Who made it (a user ID).
    pub created_by: Id,
    /// The last time a join through it is accepted; absent for never.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    /// 0 for unlimited.
    pub max_uses: u32,
    pub uses: u32,
    pub revoked: bool,
    /// T8-02: its short v1 link, for an invite I made here that is still
    /// live (its key is kept only on the inviter's device); absent otherwise.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub short_link: String,
}

/// Voice: a call, me first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallState {
    pub channel_id: Id,
    pub participants: Vec<CallParticipant>,
    /// 5 participants: nobody else can join.
    pub full: bool,
    /// Relay-only is on: calls are off. An ended call (no participants)
    /// with this set ended because relay-only went on.
    #[serde(default)]
    pub relay_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallParticipant {
    /// A user ID.
    pub identity: Id,
    pub muted: bool,
    /// G-84b: hears no one (only with `muted`; false from cores before 0.6.0).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deafened: bool,
}

/// Why `server.removed` fired (server lifecycle).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemovedReason {
    /// I left (`leaveServer`).
    Left,
    /// The owner closed (deleted) it, mine or read; sent when its 30 days
    /// are up and the rest of it is purged.
    Closed,
}

/// Voice rooms: a live room and who is in it, from verified hellos (soft
/// state: nothing is stored).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRoom {
    pub server_id: Id,
    /// What `joinCall` takes; `CallState.channelId` in a call.
    pub room_id: Id,
    pub creator_id: Id,
    /// ms since the epoch, by the creator's clock.
    pub created_at: u64,
    /// Set by the master or the server owner. Absent: the UI shows the
    /// default name with the master's display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 2 to 5.
    pub limit: u8,
    /// Computed by the core: the earliest `joinedAt` (ties: the smaller ID).
    pub master_id: Id,
    /// At most 5, by `joinedAt` (the master first); me too when I'm in it.
    pub members: Vec<VoiceMember>,
    /// Relay-only is on: `createVoiceRoom` and `joinCall` answer
    /// `relay-only`, so the UI can disable them up front.
    #[serde(default)]
    pub relay_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMember {
    pub user_id: Id,
    /// A display hint only.
    pub muted: bool,
    /// G-84b: a display hint only, with `muted`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deafened: bool,
    /// ms since the epoch: its claim, checked within 2 minutes and frozen.
    pub joined_at: u64,
}

/// Voice: the WebRTC signalling `sendSignal` carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalKind {
    Offer,
    Answer,
    Ice,
}

/// #187: a direct connection (LAN, later hole-punched) or through the relay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    Direct,
    Relay,
}

/// Member relays (#368, slice 1): `setMemberRelay`'s setting. `Auto`: on
/// while I'm owner or admin in a server I'm still a member of.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberRelaySetting {
    #[default]
    Auto,
    On,
    Off,
}

/// Why relaying is off whatever the setting (the first that applies).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemberRelayReason {
    /// The owner's signed global switch (`flags.json`, slice 3b).
    GlobalOff,
    /// No trusted adult birth date (the age claim's rule).
    Minor,
    /// Relay-only is on.
    RelayOnly,
    /// A metered network, as the desktop shell reports it (`setMetered`).
    Metered,
}

/// Where bringing my servers back after a restore stands (G-91).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerRestoreState {
    /// No restore under way since this start.
    None,
    /// Looking for my backup on the network (none found yet).
    Searching,
    /// The backup is found; some servers have nobody reachable yet.
    Waiting,
    /// Every server from the backup is back (or isn't mine any more).
    Done,
}

/// `getServerRestore`'s answer, and `serverRestore.changed`'s payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRestore {
    pub state: ServerRestoreState,
    /// Servers the backup lists as mine (0 until it's found).
    pub found: u32,
    /// Of those, the ones not back yet because nobody was reachable.
    pub waiting: u32,
}

/// G-78: how the app lock is unlocked. `os` (Touch ID, later Windows
/// Hello) always has a passcode behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppLockMethod {
    Passcode,
    Os,
}

/// G-78: `getAppLock`'s answer. It never holds the verifier or the salt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLock {
    pub enabled: bool,
    pub method: AppLockMethod,
    pub idle_minutes: u8,
    pub lock_on_sleep: bool,
    /// Seconds until the next attempt is checked, while a delay runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

/// G-78: the outcome of a passcode or words attempt. "Wrong" is an answer,
/// not an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppLockResult {
    Ok,
    Wrong,
    RateLimited,
}

/// G-78: the answer of `verifyAppLock`, `setAppLock`, `clearAppLock` and
/// `clearAppLockWithWords`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLockAnswer {
    pub result: AppLockResult,
    /// Seconds until the next attempt is checked, when a delay runs (always
    /// with `rate-limited`; with `wrong` when this attempt started one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

/// `getMemberRelay`'s answer, and `memberRelay.changed`'s payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRelay {
    pub setting: MemberRelaySetting,
    /// Relaying for my members now (slice 2's relay reads this). False
    /// until the one-time disclosure was acknowledged (PO on #387).
    pub effective: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<MemberRelayReason>,
    /// `Auto` would turn it on: I'm owner or admin somewhere.
    pub role: bool,
    pub disclosure_seen: bool,
    /// The daily byte cap, 256..=51,200 MB (default 2,048).
    pub daily_cap_mb: u32,
}

/// Device link (`device-link-slice.md`): `startDeviceLink`'s answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLinkStart {
    /// `mvs-link:1:` and base58: printable ASCII, at most 1,024 characters.
    pub qr: String,
    /// 10 base32 characters, `[A-Z2-7]`: a rendezvous only.
    pub code: String,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceLinkPhase {
    Waiting,
    Confirm,
    Done,
    Expired,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceLinkReason {
    Cancelled,
    Timeout,
    Refused,
    Network,
    /// The account arrived but this computer's keychain couldn't store it
    /// (`keyring-unavailable` on restore).
    Keyring,
    /// The account arrived but couldn't be restored for another reason.
    Restore,
}

/// `deviceLink.state`. Absent fields are left out, never null (dev-ui #391).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLinkState {
    pub state: DeviceLinkPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sas: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DeviceLinkReason>,
}

/// `beginDeviceApproval`'s answer: the digits to compare.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceApproval {
    pub sas: String,
    pub expires_at: u64,
}
