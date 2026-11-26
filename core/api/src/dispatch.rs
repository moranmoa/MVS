//! The JSON boundary every shell uses (Tauri command, Electron addon, IPC):
//!
//! ```text
//! request:  { "cmd": "createServer", "args": { "name": "...", "ageRestriction": "none" } }
//! response: { "ok": <result> }  or  { "error": { "code": "not-allowed", "positions"?: [...], "servers"?: [...] } }
//! event:    { "event": "server.added", "payload": <ServerSummary> }   (via EventSink)
//! ```
//!
//! `args` holds the TS method's parameters by name (`listChannels(serverId)`
//! is `{ "serverId": ... }`); commands without parameters take `{}` or no
//! `args` at all. A `void` result is `{ "ok": null }`.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::service::Core;
use crate::types::*;

#[derive(Deserialize)]
struct Request {
    cmd: String,
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerArg {
    server_id: String,
}

/// `getUpdateNeeded`: no cap is server lifecycle's (G-26).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateNeededArgs {
    server_id: String,
    #[serde(default)]
    cap: Option<String>,
}

/// G-48 `reportContent`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportArgs {
    server_id: String,
    target: ReportTargetInput,
    reason: String,
    #[serde(default)]
    text: Option<String>,
}

/// G-48: a report's ID.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportIdArg {
    report_id: String,
}

/// G-29.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypingArgs {
    channel_id: String,
    on: bool,
}

/// G-29: `setTypingIndicator`.
#[derive(Deserialize)]
struct OnArg {
    on: bool,
}

/// G-26.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactArgs {
    message_id: String,
    emoji: String,
    on: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameServerArgs {
    server_id: String,
    name: String,
}

/// G-51 `setServerIcon`: `dataUrl` null (or absent) clears it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerIconArgs {
    server_id: String,
    #[serde(default)]
    data_url: Option<String>,
}

/// G-51 `setServerDescription`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerDescriptionArgs {
    server_id: String,
    description: String,
}

/// G-52 `setAgeRestriction` and `countAgeAffected`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgeRestrictionArgs {
    server_id: String,
    age_restriction: AgeRestriction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditVoiceRoomArgs {
    room_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    limit: Option<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelIdArg {
    channel_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RangeArg {
    channel_id: String,
    start: usize,
    end: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendArg {
    channel_id: String,
    body: String,
    #[serde(default)]
    reply_to_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageIdArg {
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditArg {
    message_id: String,
    body: String,
}

/// G-30 `locateMessage`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocateArgs {
    server_id: String,
    channel_id: String,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerUserArgs {
    server_id: String,
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelInput {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    adult: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChannelArgs {
    server_id: String,
    input: ChannelInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateChannelArgs {
    channel_id: String,
    input: ChannelInput,
}

/// G-14 `setChannelTopic(channelId, topic)`; an empty topic clears it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetChannelTopicArgs {
    channel_id: String,
    topic: String,
}

/// G-11 `moveChannel(serverId, channelId, before?, after?)`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveChannelArgs {
    server_id: String,
    channel_id: String,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantArgs {
    server_id: String,
    user_id: String,
    role: Role,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateServerArgs {
    input: CreateServerInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateServerInput {
    name: String,
    age_restriction: AgeRestriction,
}

#[derive(Deserialize)]
struct InputArg<T> {
    input: T,
}

#[derive(Deserialize)]
struct AnswersArg {
    answers: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct SignOutArg {
    /// This identity's 12 words: proof the user can restore later.
    #[serde(default)]
    words: Option<Vec<String>>,
    /// "I accept losing this account": signs out without the words.
    #[serde(default, rename = "withoutWords")]
    without_words: bool,
}

#[derive(Deserialize)]
struct RestoreArg {
    words: Vec<String>,
    /// Country, birth date and language, asked again (spec, age §).
    #[serde(default)]
    input: Option<NewIdentityInput>,
}

#[derive(Deserialize)]
struct LinkArg {
    link: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteInput {
    expires_ms: Option<u64>,
    max_uses: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteArgs {
    server_id: String,
    input: Option<CreateInviteInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeInviteArgs {
    server_id: String,
    invite_id: String,
}

#[derive(Deserialize)]
struct MutedArg {
    muted: bool,
}

#[derive(Deserialize)]
struct DeafenedArg {
    deafened: bool,
}

#[derive(Deserialize)]
struct SignalArgs {
    to: String,
    kind: SignalKind,
    payload: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserArg {
    user_id: String,
}

/// G-77: a birth date, `YYYY-MM-DD`.
#[derive(Deserialize)]
struct DateArg {
    date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBlockedArgs {
    user_id: String,
    blocked: bool,
}

#[derive(Deserialize)]
struct BytesArg {
    bytes: u64,
}

#[derive(Deserialize)]
struct ChannelArg {
    channel: UpdateChannel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QrOrCodeArg {
    qr_or_code: String,
}

#[derive(Deserialize)]
struct AtArg {
    at: u64,
}

#[derive(Deserialize)]
struct MatchArg {
    r#match: bool,
}

#[derive(Deserialize)]
struct ApproveArg {
    approve: bool,
}

#[derive(Deserialize)]
struct MemberRelayArg {
    setting: MemberRelaySetting,
}

#[derive(Deserialize)]
struct MemberRelayCapArg {
    mb: u32,
}

#[derive(Deserialize)]
struct RelayOnlyArg {
    on: bool,
}

/// G-78: the app lock's arguments. Passcodes and words are wiped from
/// memory when dropped, and never logged.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyAppLockArg {
    #[serde(with = "crate::devicelink::secret_string")]
    passcode: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClearAppLockArg {
    #[serde(with = "crate::devicelink::secret_string")]
    current: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WordsAppLockArg {
    #[serde(with = "crate::devicelink::secret_string")]
    words: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetAppLockArg {
    #[serde(default, with = "optional_secret")]
    current: Option<Zeroizing<String>>,
    #[serde(with = "crate::devicelink::secret_string")]
    passcode: Zeroizing<String>,
    method: AppLockMethod,
    idle_minutes: u8,
    lock_on_sleep: bool,
}

/// An optional secret string, wiped when dropped.
mod optional_secret {
    use serde::{Deserialize, Deserializer};
    use zeroize::Zeroizing;

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Zeroizing<String>>, D::Error> {
        Ok(Option::<String>::deserialize(d)?.map(Zeroizing::new))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MeteredArg {
    metered: bool,
}

fn args<T: DeserializeOwned>(value: Value) -> CoreResult<T> {
    serde_json::from_value(value).map_err(|_| ErrorCode::BadRequest.into())
}

fn ok<T: serde::Serialize>(value: CoreResult<T>) -> CoreResult<Value> {
    value.map(|v| serde_json::to_value(v).expect("result types serialize"))
}

/// Every command in `CoreCommands`, plus the Rust additions. Commands from
/// the contract this core doesn't do yet answer `not-implemented`.
pub const NOT_YET: &[&str] = &[];

impl Core {
    /// Takes a request JSON text, returns the response JSON text.
    pub fn handle(&self, request: &str) -> String {
        let response = match serde_json::from_str::<Request>(request) {
            Ok(request) => self.handle_value(&request.cmd, request.args),
            Err(_) => Err(ErrorCode::BadRequest.into()),
        };
        match response {
            Ok(value) => json!({ "ok": value }),
            Err(error) => json!({ "error": error }),
        }
        .to_string()
    }

    pub fn handle_value(&self, cmd: &str, raw: Value) -> CoreResult<Value> {
        let raw = if raw.is_null() { json!({}) } else { raw };
        match cmd {
            "getIdentity" => ok(self.get_identity()),
            "createIdentity" => {
                let a: InputArg<NewIdentityInput> = args(raw)?;
                ok(self.create_identity(a.input))
            }
            "checkRecoveryWords" => {
                let a: AnswersArg = args(raw)?;
                let mut answers = BTreeMap::new();
                for (position, word) in a.answers {
                    let position = position.parse().map_err(|_| ErrorCode::BadRequest)?;
                    answers.insert(position, word);
                }
                ok(self.check_recovery_words(answers))
            }
            "getRecoveryChallenge" => ok(self.get_recovery_challenge()),
            "getRecoveryWords" => ok(self.get_recovery_words()),
            "restoreIdentity" => {
                let RestoreArg { words, input } = args(raw)?;
                ok(self.restore_identity_with(words, input))
            }
            "updateProfile" => ok(self.update_profile(args::<InputArg<ProfileInput>>(raw)?.input)),
            "signOut" => {
                let SignOutArg { words, without_words } = args(raw)?;
                ok(self.sign_out(words, without_words))
            }

            "listServers" => ok(self.list_servers()),
            "listChannels" => ok(self.list_channels(&args::<ServerArg>(raw)?.server_id)),
            "getMessageCount" => ok(self.get_message_count(&args::<ChannelIdArg>(raw)?.channel_id)),
            "getMessages" => {
                let a: RangeArg = args(raw)?;
                ok(self.get_messages(&a.channel_id, a.start, a.end))
            }
            "locateMessage" => {
                let a: LocateArgs = args(raw)?;
                ok(self.locate_message(&a.server_id, &a.channel_id, &a.message_id))
            }
            "sendMessage" => {
                let a: SendArg = args(raw)?;
                ok(self.send_message(&a.channel_id, &a.body, a.reply_to_id.as_deref()))
            }
            "editMessage" => {
                let a: EditArg = args(raw)?;
                ok(self.edit_message(&a.message_id, &a.body))
            }
            "deleteMessage" => ok(self.delete_message(&args::<MessageIdArg>(raw)?.message_id)),
            "discardMessage" => ok(self.discard_message(&args::<MessageIdArg>(raw)?.message_id)),
            "retryMessage" => ok(self.retry_message(&args::<MessageIdArg>(raw)?.message_id)),
            "react" => {
                let a: ReactArgs = args(raw)?;
                ok(self.react(&a.message_id, &a.emoji, a.on))
            }
            // G-48: reports to the owners and admins.
            "reportContent" => {
                let a: ReportArgs = args(raw)?;
                ok(self.report_content(&a.server_id, &a.target, &a.reason, a.text.as_deref()))
            }
            "listReports" => ok(self.list_reports(&args::<ServerArg>(raw)?.server_id)),
            "dismissReport" => ok(self.dismiss_report(&args::<ReportIdArg>(raw)?.report_id)),
            "getReportEvidence" => ok(self.get_report_evidence(&args::<ReportIdArg>(raw)?.report_id)),
            // G-29.
            "setTyping" => {
                let a: TypingArgs = args(raw)?;
                ok(self.set_typing(&a.channel_id, a.on))
            }
            "getSettings" => ok(self.get_settings()),
            "setTypingIndicator" => ok(self.set_typing_indicator(args::<OnArg>(raw)?.on)),
            "listMembers" => ok(self.list_members(&args::<ServerArg>(raw)?.server_id)),
            "createServer" => {
                let a: CreateServerArgs = args(raw)?;
                ok(self.create_server(&a.input.name, a.input.age_restriction))
            }
            "joinServer" => ok(self.join_server(&args::<LinkArg>(raw)?.link)),
            "cancelJoin" => ok(self.cancel_join(&args::<LinkArg>(raw)?.link)),

            "markRead" => ok(self.mark_read(&args::<ChannelIdArg>(raw)?.channel_id)),
            "blockUser" => ok(self.block_user(&args::<UserArg>(raw)?.user_id)),
            "previewBirthDateCorrection" => ok(self.preview_birth_date_correction(&args::<DateArg>(raw)?.date)),
            "correctBirthDate" => ok(self.correct_birth_date(&args::<DateArg>(raw)?.date)),
            "cancelBirthDateCorrection" => ok(self.cancel_birth_date_correction()),
            "setBlocked" => {
                let a: SetBlockedArgs = args(raw)?;
                ok(self.set_blocked(&a.user_id, a.blocked))
            }
            "listBlocked" => ok(self.list_blocked()),
            // Server lifecycle (#251).
            "renameServer" => {
                let a: RenameServerArgs = args(raw)?;
                ok(self.rename_server(&a.server_id, &a.name))
            }
            "setServerIcon" => {
                let a: ServerIconArgs = args(raw)?;
                ok(self.set_server_icon(&a.server_id, a.data_url.as_deref()))
            }
            "setServerDescription" => {
                let a: ServerDescriptionArgs = args(raw)?;
                ok(self.set_server_description(&a.server_id, &a.description))
            }
            "setAgeRestriction" => {
                let a: AgeRestrictionArgs = args(raw)?;
                ok(self.set_age_restriction(&a.server_id, a.age_restriction))
            }
            "countAgeAffected" => {
                let a: AgeRestrictionArgs = args(raw)?;
                ok(self.count_age_affected(&a.server_id, a.age_restriction))
            }
            "leaveServer" => ok(self.leave_server(&args::<ServerArg>(raw)?.server_id)),
            "closeServer" => ok(self.close_server(&args::<ServerArg>(raw)?.server_id)),
            "getUpdateNeeded" => {
                let a: UpdateNeededArgs = args(raw)?;
                ok(self.get_update_needed(&a.server_id, a.cap.as_deref()))
            }
            "kickMember" => {
                let a: ServerUserArgs = args(raw)?;
                ok(self.kick_member(&a.server_id, &a.user_id))
            }
            "undoKick" => {
                let a: ServerUserArgs = args(raw)?;
                ok(self.undo_kick(&a.server_id, &a.user_id))
            }
            "createChannel" => {
                let a: CreateChannelArgs = args(raw)?;
                let name = a.input.name.ok_or(ErrorCode::BadRequest)?;
                ok(self.create_channel(&a.server_id, &name, a.input.adult.unwrap_or(false)))
            }
            "updateChannel" => {
                let a: UpdateChannelArgs = args(raw)?;
                ok(self.update_channel(&a.channel_id, a.input.name.as_deref(), a.input.adult))
            }
            "deleteChannel" => ok(self.delete_channel(&args::<ChannelIdArg>(raw)?.channel_id)),
            "setChannelTopic" => {
                let a: SetChannelTopicArgs = args(raw)?;
                ok(self.set_channel_topic(&a.channel_id, &a.topic))
            }
            "moveChannel" => {
                let a: MoveChannelArgs = args(raw)?;
                ok(self.move_channel(&a.server_id, &a.channel_id, a.before.as_deref(), a.after.as_deref()))
            }
            "listRemovedMembers" => {
                ok(self.list_removed_members(&args::<ServerArg>(raw)?.server_id))
            }
            "createInvite" => {
                let a: CreateInviteArgs = args(raw)?;
                let input = a.input.unwrap_or_default();
                ok(self.create_invite(&a.server_id, input.expires_ms, input.max_uses))
            }
            "listInvites" => ok(self.list_invites(&args::<ServerArg>(raw)?.server_id)),
            "revokeInvite" => {
                let a: RevokeInviteArgs = args(raw)?;
                ok(self.revoke_invite(&a.server_id, &a.invite_id))
            }

            "getStorageUsage" => ok(self.get_storage_usage()),
            "setStorageLimit" => ok(self.set_storage_limit(args::<BytesArg>(raw)?.bytes)),
            "clearCache" => ok(self.clear_cache()),
            "exportDiagnostics" => ok(self.export_diagnostics()),
            "getAppInfo" => ok(self.get_app_info()),
            "setUpdateChannel" => ok(self.set_update_channel(args::<ChannelArg>(raw)?.channel)),
            "setRelayOnly" => ok(self.set_relay_only(args::<RelayOnlyArg>(raw)?.on)),
            "getServerRestore" => ok(Ok(self.get_server_restore())),
            // G-78, the app lock (main-only except set and clear).
            "getAppLock" => ok(self.get_app_lock()),
            "verifyAppLock" => ok(self.verify_app_lock(args::<VerifyAppLockArg>(raw)?.passcode)),
            "setAppLock" => {
                let a = args::<SetAppLockArg>(raw)?;
                ok(self.set_app_lock(a.current, a.passcode, a.method, a.idle_minutes, a.lock_on_sleep))
            }
            "clearAppLock" => ok(self.clear_app_lock(args::<ClearAppLockArg>(raw)?.current)),
            "clearAppLockWithWords" => ok(self.clear_app_lock_with_words(args::<WordsAppLockArg>(raw)?.words)),
            "getMemberRelay" => ok(self.get_member_relay()),
            "setMemberRelay" => ok(self.set_member_relay(args::<MemberRelayArg>(raw)?.setting)),
            "setMemberRelayCap" => ok(self.set_member_relay_cap(args::<MemberRelayCapArg>(raw)?.mb)),
            "markMemberRelayDisclosureSeen" => ok(self.mark_member_relay_disclosure_seen()),
            // The desktop shell only (not in the page's allow-list).
            "setMetered" => ok(self.set_metered(args::<MeteredArg>(raw)?.metered)),
            "startDeviceLink" => ok(self.start_device_link()),
            "cancelDeviceLink" => ok(self.cancel_device_link()),
            "beginDeviceApproval" => ok(self.begin_device_approval(&args::<QrOrCodeArg>(raw)?.qr_or_code)),
            "confirmDeviceApproval" => ok(self.confirm_device_approval(args::<ApproveArg>(raw)?.approve)),
            "confirmDeviceLink" => ok(self.confirm_device_link(args::<MatchArg>(raw)?.r#match)),
            "ackDeviceNotice" => ok(self.ack_device_notice(args::<AtArg>(raw)?.at)),
            // The shell restarts; nothing for the core to do.
            "restartToUpdate" => Ok(Value::Null),

            // Rust additions.
            "grantRole" => {
                let a: GrantArgs = args(raw)?;
                ok(self.grant_role(&a.server_id, &a.user_id, a.role))
            }
            "revokeRole" => {
                let a: ServerUserArgs = args(raw)?;
                ok(self.revoke_role(&a.server_id, &a.user_id))
            }
            "syncNow" => ok(self.sync_now()),

            // Voice rooms. `joinCall` takes the room ID as `channelId`.
            "createVoiceRoom" => ok(self.create_voice_room(&args::<ServerArg>(raw)?.server_id)),
            "listVoiceRooms" => ok(self.list_voice_rooms(&args::<ServerArg>(raw)?.server_id)),
            "editVoiceRoom" => {
                let a = args::<EditVoiceRoomArgs>(raw)?;
                ok(self.edit_voice_room(&a.room_id, a.name, a.limit))
            }
            "joinCall" => ok(self.join_call(&args::<ChannelIdArg>(raw)?.channel_id)),
            "leaveCall" => ok(self.leave_call()),
            "setMuted" => ok(self.set_muted(args::<MutedArg>(raw)?.muted)),
            "setDeafened" => ok(self.set_deafened(args::<DeafenedArg>(raw)?.deafened)),
            "sendSignal" => {
                let a: SignalArgs = args(raw)?;
                ok(self.send_signal(&a.to, a.kind, a.payload))
            }
            // In-app update (B8-5). Main/core only: never in CoreCommands or
            // the renderer allow-list (A2). `not-implemented` without
            // `--update-root`.
            "checkForUpdate" => self.check_for_update(),
            "downloadUpdate" => self.download_update(),
            "applyUpdate" => self.apply_update(),
            "markHealthy" => self.mark_healthy(),

            cmd if NOT_YET.contains(&cmd) => Err(ErrorCode::NotImplemented.into()),
            _ => Err(ErrorCode::BadRequest.into()),
        }
    }
}
