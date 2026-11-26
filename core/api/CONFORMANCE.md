# Conformance: the TS mock and the Rust core

The UI is built against `MockCore` (`ui/src/core/mock.ts`). The Rust core
(`core/api`) replaces it. `tests/fixtures/conformance.json` holds scenarios
that **both** run, as JSON commands, so the two can't drift without a test
failing on one side.

- Rust side: `tests/conformance.rs` runs every scenario whose `targets`
  includes `"rust"`, through `Core::handle`. It runs in CI with the rest of
  `cargo test`.
- TS side: planned (below). This PR doesn't touch `ui/`.

## Fixture format

```jsonc
{
  "version": 1,
  "scenarios": [{
    "name": "…",
    "targets": ["mock", "rust"],      // who must pass it
    "why-not-mock": "…",              // required when "mock" is missing
    "peers": ["alice", "bob"],        // one fresh core each; Rust peers share a loopback network
    "steps": [{
      "peer": "alice",
      "cmd": "createServer",          // a CoreCommands method name
      "args": { "input": { … } },     // the method's parameters, by TS parameter name
      "expect": { "ok": … } | { "error": { "code": "…", "positions"?: […] } },
      "events": ["server.added"],     // optional: must be emitted during the step, in this order (others may be interleaved)
      "save": { "server": "ok.id" }   // optional: dotted path into the response
    }]
  }]
}
```

Matching rules (identical in both runners):

- An expected object matches if every key it lists matches. Extra keys are
  fine: the Rust core sends a few additions, such as `Member.role`.
- An expected array must have the same length, and each element must match.
- Wildcards: `"<any>"`, `"<string>"`, and `"<len:N>"` for an array of N items.
- `"${name}"` and `"${name.N}"` are replaced by a saved value, in `args` and in
  `expect`. Only whole strings are replaced.
- `"answer": { "positions", "words", "wrong"? }` replaces `args` for
  `checkRecoveryWords`, because challenge positions are random. The runner
  sends `{ answers: { [p]: words[p - 1] } }` for each 1-based position `p`,
  with `"zzzz"` instead at the indexes (into `positions`) listed in `wrong`.
- `{ "ok": null }` is a `void` result. A rejected promise is `{ "error": CoreError }`.

## TS runner (plan, for the UI owner)

1. Add `ui/src/core/conformance.test.ts` (vitest is already set up). Import
   the fixture through a relative path, or copy it into `ui/src/test/` in a
   prebuild step, so the file stays single-sourced.
2. For each scenario with `"mock"` in `targets`, create
   `new MockCore({ speed: 0, storage: undefined })` per peer, and record
   events with `core.on(name, …)` for every `CoreEventName`.
3. Map a step onto the method: `args` values in the TS parameter order. A
   per-command table, typed against `CoreCommands`, keeps it honest:
   `{ listChannels: (a) => [a.serverId], createServer: (a) => [a.input],
   kickMember: (a) => [a.serverId, a.userId], … }`.
4. `await` the method. Wrap a resolve as `{ ok: value ?? null }` and a
   rejection as `{ error }`, then apply the matching rules above. The
   matcher is about 40 lines; port `matches` from `tests/conformance.rs`.
5. Fail if a scenario lists `"mock"` but some step names a command the mock
   lacks (`grantRole`, `revokeRole` and `syncNow` are Rust additions).

The same runner later drives the real core through the shell adapter (Tauri
`invoke` or Electron IPC), using `targets: ["rust"]` scenarios too. That turns
it into an end-to-end check of the adapter.

## Where the two differ today

Each difference keeps a scenario Rust-only. Fix the mock, then add `"mock"`.

| Difference | Fix |
| --- | --- |
| The mock's word list is 64 stand-in words, with no checksum | Give the mock the BIP-39 English list and a checksum check (or call into a WASM build of `identity`) |
| The mock is one person; `joinServer` adds a canned server | Multi-peer scenarios stay Rust-only until the mock simulates peers |
| The mock lets only the owner kick | `authority`'s rule: moderators and up, against lower ranks. The mock should follow it |
| The mock may not follow the B19 §6 challenge exactly (#28) | The Rust core: `getRecoveryChallenge` gives 3 stable positions. `checkRecoveryWords` takes exactly those (else `not-allowed`) and answers `{ ok }` or `{ ok: false, wrong }`. The 5th failure burns the challenge and rejects with `too-many-attempts`, until `getRecoveryWords` succeeds. All of it survives a restart. The mock runner needs the `answer` directive too |
| The mock's `getRecoveryWords` answers at any time | The Rust core answers only until the check passes, then `not-allowed` (until the app lock, #31); the mock should too |
| The mock accepts any `updateProfile` input | The Rust core refuses oversize fields and any avatar other than a base64 PNG, JPEG, WebP or GIF `data:` URL (`bad-request`) |
| The mock has no `grantRole` / `revokeRole` | Add them to `CoreCommands` (proposed below) |
| The mock never holds a message for its key | The Rust core (see "Messages held for their key" below): a plain member without the channel key yet gets the message back at once as `pending`, with a provisional ID, instead of `not-allowed`. The mock should do the same when it simulates a fresh join |

## Proposed contract additions (Rust has them; `api.ts` doesn't yet)

- Profile picture and colour for other members (#354, `src/avatar.rs`):
  - `updateProfile` input gains `avatarSmall?` and `color?`: absent means unchanged, `""` clears.
    - `avatarSmall` is a `data:image/(webp|png);base64,` URL of at most 2,560 bytes and 64×64 declared, and still (no APNG `acTL`, no animated WebP). `color` is `#rrggbb`. Anything else, or a profile post over 4 KiB, is `bad-request`.
    - The large `avatarDataUrl` and the bio stay on this device.
  - **Publishing:** they go in my profile post (`avatar`, `color`), at most one per server per 10 minutes. Changes are coalesced, and the pending one survives a restart. Nothing is posted without a change.
  - **Receivers** check each post the same way, without decoding pixels. A valid value sets it, `""` clears it, an absent field leaves it, and an invalid value is ignored.
  - **Exposed:** `Member.avatarDataUrl?` and `Member.color?` (`avatarColor` stays the derived one), plus `Identity.color?`. A profile post that arrives brings `members.changed`.
  - **UI (Security Lead):** the picture is rendered only via `<img src>`, with CSP `img-src 'self' data:`.

- Mentions (G-24, GAPS §2.5):
  - A mention is the token `<@userId>` (64 lower-case hex) in the body, never a name. The UI shows the current name, or `mention.unknown` for someone no longer in the server. Older clients show the token as text. It counts toward the 4,000 code points.
  - `Message.mentions?: userId[]` (additive) lists the mentioned users who are members now, in order, each once.
  - `Message.mentionsMe?: true` when the body mentions me.
  - `Channel.mentions` and `ServerSummary.mentions` count unread messages that mention me (after the read marker, not mine). `markRead` resets them. `ServerSummary.unread` is set when any channel has unread messages; both come from `listServers`.
  - No authority or sync change: mentions are read from the message body.

- "Is typing…" (G-29; design `g29-typing-design.md` with Amendment 1). Ephemeral: never stored, never in a log, the backup or the logs, never unread.
  - `setTyping(channelId, on: boolean)` returns `null`.
    - `true` while typing: the first goes out at once, and repeats at most every 3 s while the UI keeps calling it.
    - `false` on send or clear: `off` goes out once, if `on` went out. `off` also goes 4 s after the last `true`, and `sendMessage` sends it too.
    - Errors: `not-found` (no channel I can see), `not-allowed` (I can't post there now).
  - `getSettings()` returns `{ typingIndicator: boolean }`, settings this device keeps. `setTypingIndicator(on)` returns `null`.
    - "Show others when I'm typing" is on by default and local only.
    - Off: nothing is sent (turning it off sends `off` wherever I was typing), but others still show.
  - Event `typing { channelId, userIds }`: who is typing there now, by key, at most 5; an empty list means nobody. It's sent when that set changes, at most one per channel per tick.
    - A typer is dropped 6 s after their last `on`, at once on `off`, or when their message arrives.
    - My own other computers (same identity) aren't shown.
  - **Transport:** sync's `/mvs/typing/1`.
    - One blob of at most 512 bytes; the answer is empty.
    - Only to and from verified current members.
    - Its own caps: per peer a burst of 3, then 1 every 2 s; all peers a burst of 30, then 10 a second.
    - Older peers fail negotiation, harmlessly. No gate is needed, since nothing is stored.
  - **Envelope:** `{ v: 1, from, server, channel, ts, nonce, on }`, signed by the identity under `mvs/typing/v1`, with `deny_unknown_fields` on the body and the wrapper. It's dropped quietly unless:
    - it verifies, is version 1, is within 2 minutes of our clock, and isn't a replay;
    - it's signed by the identity its peer is bound to;
    - that identity can read and post in the channel now (a member, not kicked, the channel known, 18+ only with a claim), in one of my servers and a channel I can see.
  - It's sent to the online members who can read that channel.

- Emoji reactions (G-26; design `g26-reactions-design.md` with Amendment 1):
  - `react(messageId, emoji, on: boolean)` returns `null` and fires `message.updated` for the message. Nothing is signed when it's already so (an add of an emoji I have on, or a removal of one I don't).
  - `Message.reactions?: { emoji, count, mine }[]` (additive) lists at most 20 emoji: the 20 with the most members, ties going to the one that appeared first. They're listed in the order they first appeared, and the field is absent when there are none. A deleted message has none.
  - A change from anyone brings one `message.updated` for the message in that sync round. Reactions are never unread, never a mention, and never notify.
  - **The emoji check** (core on write and on fold; the UI's sanitizer must match it):
    - One trailing U+FE0F is dropped first, so 👍 and 👍+FE0F are the same chip. The stored form never ends in FE0F.
    - 1–32 bytes and at most 10 scalars, made of elements joined by single ZWJs (U+200D: never first, never last, never doubled).
    - An element is one of:
      - an emoji base (the pictographic blocks U+1F000–1FAFF, plus the older emoji symbols listed in `src/reaction.rs`), with at most one VS16 or skin tone (U+1F3FB–1F3FF) straight after it;
      - a pair of regional indicators;
      - a keycap `[0-9#*] FE0F? 20E3`.
    - Never a control, bidi, whitespace or tag character (U+E0020–E007F, so no subdivision flags in v1), and no custom emoji.
  - Errors, with nothing signed:
    - `bad-request`: the emoji fails the check, or it would be my 11th emoji on this message.
    - `not-found`: no such message I can see, or it is deleted.
    - `not-allowed`: I can't write in that channel now (the same rule as a message).
    - `update-needed`: a current member's latest profile post lacks `reactions-v1`. `getUpdateNeeded(serverId, "reactions-v1")` says who.
    - `rate-limited`: 30 reaction records of mine in this channel within a minute.
  - **Record:** `Kind::Reaction = 21`, channel scope, at most 256 bytes. Authority judges it like a `Message` (any member; a kick's cut voids it the same way). The body is sealed with the channel key over a fixed 66-byte plaintext, so its length doesn't give the emoji away. The plaintext is `target (32) ‖ op (1 = add, 0 = remove) ‖ len u8 ‖ emoji ‖ zero padding`. On open, it's refused when:
    - `len` is over 32;
    - the emoji isn't valid UTF-8, or fails the check, or ends in FE0F;
    - the op isn't 0 or 1;
    - the padding isn't all zero.

    The design said 64 bytes, but 32 + 1 + 1 + 32 needs 66, so 66 keeps the 32-byte emoji limit.
  - **The fold** (deterministic in every core):
    - The channel's records go in causal order: deps first, and (claimed time, ID) only between records that are concurrent.
    - **Time bounds** (the security lead's fix: claimed times are the author's own):
      - A record's effective time is the later of its claimed time and its deps' effective times.
      - A reaction claiming a time more than 10 minutes before its deps' effective time is ignored.
      - A record claiming a time more than 10 minutes past the folding core's clock waits: it isn't counted, and its time doesn't count for the records built on it, until then.
    - **Rate:** an author's accepted reaction is ignored when 30 of theirs are already counted within a minute of its effective time, either way. The count uses the effective time capped at now, so the 10 minutes of lead add no room.
    - A new reaction is signed at its effective time (my clock, or its deps' time if later), so a clock up to 10 minutes slow isn't ignored as backdated.
    - **Accepted residual (dev-sync follow-up, GAP-25):** a hostile client whose reactions have stale deps, or no channel deps at all (only `auth_deps` is required), can still spread its claimed times freely. Only the receive-time check at sync ingest bounds that.
    - Then a reaction counts only if it opens to a valid plaintext whose target is a shown `Message` of that channel that isn't deleted.
    - Per (message, emoji, author), the last op wins.
    - An add is ignored while the author already has 10 emoji on that message; a removal frees a place.
    - There's no per-message cap in the state, so one member can't lock a message.
  - **Known residual:** with more than 20 distinct emoji on a message, the rarest drop out of view (not out of state). One member can add at most 10.
  - **Rollout:** a `reactions-v1` cap in profile posts (above). An older core refuses kind 21 and would stall on every channel record after one, so nobody reacts until every current member posts the cap. The release that reads kind 21 also posts it.
  - **Known residual: late joiners on an old version.** Someone who joins later with a pre-reactions build meets the kind-21 records already there and stalls on that channel's log, as with lifecycle records (#229). The gate can't see them before they join, since their caps arrive only with their first profile post. A join can't be refused on version either: the core has no version field to check. So:
    - the release notes say reactions need everyone on that version;
    - the in-app updater (hourly check) narrows the window;
    - once their profile post lacks the cap, `getUpdateNeeded(serverId, "reactions-v1")` names them, and new reactions wait for them again.

- Report to the owners (G-48; design `docs/design/report-to-owners.md`, with the Tech Lead's Amendment 1, the security lead's R1–R7 and the Product Owner's decisions):
  - `reportContent({ serverId, target, reason, text? })` returns `{ reportId, recipients }`.
    - `target` is `{ kind: 'message', messageId }` or `{ kind: 'member', userId }`.
    - `reason` is one of: `spam`, `harassment`, `hate`, `violence`, `sexual`, `minor`, `self-harm`, `illegal`, `impersonation`, `other`.
    - `text` is optional and trimmed. It follows the topic rule (one line, the strict text rule), up to 280 code points and 1024 bytes.
    - Errors, with nothing signed:
      - `bad-request`: the reason or text is wrong;
      - `not-found`: no such message (in a channel I can see) or member (current or removed) in that server;
      - `not-allowed`: reporting myself or my own message, or I'm not a member;
      - `rate-limited`: 5 an hour or 20 a day per server;
      - `already-reported`: the same target within 30 days;
      - `no-recipient`: nobody is left to receive it. The UI then points at the abuse address (B24).
  - **Who gets it:**
    - Recipients are the server's owner and admins, current and not kicked, minus the reported member and me. For a message, the reported member is its author.
    - Moderators don't get reports in v1.
    - Admins added after a report don't get it.
  - **Delivery:**
    - A direct, members-only protocol, `/mvs/report/1`. A box goes to each recipient on its own; nothing enters a log, so other members never learn a report exists.
    - The reporter's outbox retries about every 10 seconds while the recipient is online, and drops a row once it is acked.
    - At each send, the recipient is resolved again (R1): a row whose recipient is no longer owner or admin, or is the reported member, is dropped, and so are rows older than 30 days or for a server I left.
    - `report.status { reportId, delivered, pending }` follows progress.
  - **Staff:**
    - `listReports(serverId)` lists reports newest first. It is `not-allowed` unless I am owner or admin now, and losing that role, leaving or a kick deletes the reports I hold.
    - `report.received { serverId, report }` fires on arrival.
    - `dismissReport(reportId)` is local triage only.
    - A `ReportSummary` is `{ id, serverId, reporterId, target, reportedId, reason, text?, ts, receivedAt, dismissed, evidenceValid, evidenceWithheld }`. It **never carries evidence**: not in the list, the event, a notification or a preview.
  - **`getReportEvidence(reportId)`** (an explicit click) returns `{ authorId, channelId, ts, text? }`, the reported message as its author signed it.
    - `text` is absent when I hold no key for it.
    - Show it as plain text: never Markdown with live links, never HTML.
    - Errors:
      - `bad-request`: the evidence isn't that message (R4: the ID, server, channel, kind `Message` and the author's signature must all check);
      - `not-allowed`: for `sexual` and `minor`, staff without an 18+ claim (Product Owner). `evidenceWithheld: true` says so in advance.
    - No API path exports or forwards evidence.
    - The evidence outlives the author's delete. That's a deliberate retention exception.
  - **Non-repudiation is intended:** staff hold the reporter's signature. The UI must say "the owner and admins will see that you reported this".
  - **Wire:**
    - The signed report is a fixed 1200-byte part, then `ev_len u32` and the evidence (the reported message's own signed record, padded to 0, 2 KiB, 8 KiB or the largest record), then an Ed25519 signature under `mvs/report/v1`.
    - Each box is X25519 to the recipient's key (from Ed25519, as `groupkeys`), BLAKE3 `derive_key`, then XChaCha20-Poly1305. The associated data is `"mvs/report-box/v1" ‖ ephemeral ‖ recipient ‖ server`, and an all-zero shared secret is refused.
    - A box is at most 20 KiB.
    - Sync caps per peer: a burst of 3, then one every 10 s. Across all peers: a burst of 20, then 2 a second.
    - Sync acks every box that passes those caps before the core tries to open it, so the answer never depends on what the box holds (R7).
  - **Receiving:**
    - A box is dropped quietly unless:
      - it opens for me in one of my servers;
      - the report verifies;
      - its signer is the identity sync bound the peer to;
      - its time is within 30 days back and 10 minutes ahead;
      - I'm staff there;
      - the reporter is a current member;
      - a member target is current or removed;
      - it's new: report IDs are kept 31 days;
      - the reporter has sent under 10 an hour.
    - Each server stores at most 1000 reports.
  - **Storage:** only sealed boxes are on disk, both the outbox and the reports I received. Neither is in the account backup or the logs. The report commands aren't in the app lock's allow-set (G-78).
  - **Older peers** don't speak `/mvs/report/1`: the row stays in the outbox until they update or it expires.

- Channel topic (G-14; design `docs/design/channel-topic.md`):
  - `setChannelTopic(channelId, topic)` returns the updated `Channel` and fires `channel.updated`. The topic is trimmed; an empty one clears it. Setting the topic the channel already has signs nothing and fires nothing.
  - `Channel.topic?: string` (additive), absent when there is none. A member reading a topic change by sync gets `channel.updated` for that channel. A topic is never unread, never a mention and never a notification.
  - **The text rule** (`authority::channel_topic_ok`): one line, trimmed, 1–256 code points and at most 1024 bytes, and the strict name rule (no bidi controls, other control characters, line breaks included, or zero-width characters).
  - Errors, with nothing signed:
    - `bad-request`: the topic fails the rule.
    - `not-found`: an unknown or deleted channel.
    - `not-allowed`: I'm not the owner or an admin.
    - `update-needed`: a current member's latest profile post lacks `channel-topic-v1`. `getUpdateNeeded(serverId, "channel-topic-v1")` says who. Clearing a topic that isn't set signs nothing, so it isn't gated.
  - **Record:** `Kind::ChannelTopic = 22`, control scope, at most 1057 bytes: `channel (32) ‖ history u8 (0, reserved for D30) ‖ topic UTF-8`. A body that fails the rule never parses, so it's never accepted.
  - **Authority:** the owner or an admin, on a live channel. It's privileged, so a revoke (the only demotion) or a kick voids the author's concurrent topics. The latest accepted topic in linear order counts, per channel, and deleting the channel drops it.
  - **Plaintext:** like channel names, topics sit unsealed in the control log, so every member can read them. An 18+ channel is listed only to members with an 18+ claim, and its topic with it; every output goes through one function (`ServerView::channels`). That hiding is display-only (GAP-22: a modified client reads it), so the UI says "visible to every member of the server".
  - **Rendering:** plain text only: no Markdown (G-25), no HTML, and no auto-links outside the messages' link guard.
  - **History byte:** frozen at 0 for this kind; any future use needs a new cap.
  - **Older members:** an older core refuses kind 22 on decode and would stall on the control records after it, hence the gate. The residual is the same as for `server-lifecycle-v1`: someone who joins later on an older version can't read past a topic until they update.

- New-messages divider (G-21, option A):
  - `Channel.unreadCount?: number` and `Channel.firstUnreadIndex?: number` (additive) count the messages after my read marker that aren't mine, in `getMessages` order. `firstUnreadIndex` is the `getMessages` index of the first of them, and is absent when there are none. `Channel.unread` is `unreadCount > 0`. They appear in `listChannels` and `channel.updated`.
  - `markRead(channelId)` returns `null` and moves the marker to the channel's last message. It emits `channel.updated` with `unreadCount: 0` and no `firstUnreadIndex`.
  - Events keep the UI in step with the marker (v0.4.1 fix):
    - A new message from someone else brings `channel.updated` for its channel, with `unread`, `unreadCount`, `firstUnreadIndex` and `mentions`.
    - Then a `server.updated` with the server's recounted `unread` and `mentions`.
    - `markRead` brings `channel.updated` and then that same `server.updated`.
    - Every `server.updated` carries the counted `unread` and `mentions`.
    - While a channel is open and its bottom is seen, the UI calls `markRead` on such a `channel.updated`.
  - A channel never read counts from when this device joined the server, so history from before isn't unread.
  - The marker is local only (kv `read/<channel>`), and phase 3 syncs it. The count comes from the stored records, with no network or paging.
  - **v1 limit:** the marker is a point in `(time, ID)` order, and a message counts as unread only if it comes after it. A message that arrives late, with a time older than the marker (an offline peer catching up, say), is shown in its place but isn't counted as unread.
  - Counts are recomputed on each `listChannels`. A per-channel cached count is a follow-up (board P3), if lists get slow.

- Channel order (G-11, Tech Lead's design):
  - `moveChannel(serverId, channelId, before?, after?)` returns `Channel[]` in the new order. It puts the channel right before `before`, or right after `after`, or last with neither; both given must be one gap.
    - Errors: `not-allowed` below admin, `not-found` for an unknown channel, `bad-request` for a neighbour that isn't a live channel of the server, or two that aren't one gap.
  - It signs one control-log `Post` tagged `mvs/channel-order/v1`, `{"mvs":"mvs/channel-order/v1","v":1,"pos":{channelHex: key}}`, with no new record kind or channel field, so 0.3.x peers ignore it.
    - Keys are base-62 (`0-9A-Za-z`), compared as strings, 1–32 characters, never ending in `0`.
    - A move normally sends one key between its neighbours'. When a neighbour has no key yet, or the key would pass 32 characters, it sends keys for every channel (a rebalance).
  - **Who counts:** a post counts only if its author was owner or admin at that record, in the state of the post's causal past. Per channel, the last counting post in authority's order wins. Bad keys, deleted channels and unknown channels are ignored.
  - **Order:** `listChannels` returns channels in order. Placed ones come first by key (then by ID); the rest keep today's order.
  - `Channel.position` (additive, the key) appears on placed channels, in `listChannels` and in `channel.updated`. The core emits `channel.updated` for each channel a local move repositioned. The UI uses the list order and never re-sorts by the key.

- Restore servers, phase A (#291, `src/backup.rs`), and its progress (G-91).
  - **When the backup is written:** only when my server set changed since the last write, on the first sync round after start (login), or every 24 h (`BACKUP_REPUBLISH_MS`). Then my server list (server IDs and sync secrets) is merged into the newest backup the holders keep (`Network::fetch_backup`), sealed as the next version and handed to them (`Network::put_backup`). Rounds with nothing due fetch and put nothing. The fetch and the put run outside the core lock.
    - Servers this device listed and no longer has get a tombstone.
    - Merging keeps what my other devices wrote.
  - **The blob:** `mvsb1 ‖ tag ‖ w_pub ‖ version ‖ nonce ‖ XChaCha20-Poly1305(padded JSON) ‖ Ed25519 sig by w`.
    - The keys come from the words (#292). There's no identity key in it.
    - It's padded to 4 KiB steps, at most 64 KiB.
  - **On `restoreIdentity`:** the core fetches the backup (`Network::fetch_backup`), keeps the newest valid one, and rejoins each live server as the same member (#290). It posts no new join, profile or age claim.
    - A server whose log no longer lists me isn't entered.
    - A restore still waiting is tried again. While no backup is found: backoff, after 1 min, doubling (2, 4, 8, 16, 32) up to once an hour. Once it is found: only the servers still waiting, every 30 s (`REJOIN_EVERY_MS`), with no new backup fetch, so each comes back within 2 minutes of a member of it being reachable. Nothing more once it is done. After a restart mid-restore the backup is searched for again.
    - A server leaves the restore only on a definite answer: back (`Joined`), closed, or refused as no longer mine (`Invalid` with evidence: the log shows an accepted kick or leave of me). Anything else (nobody reachable, a partial answer, age-blocked, any error) waits for the next try, so one bad round never loses a server (Security Lead on #457).
    - Accepted residual (Security Lead on #472): a partial log that has an old leave of mine but not my later rejoin still drops the server. That errs on the safe side, and an invite link brings it back.
    - Accepted residual (Security Lead on #503), the same for `removed`: a partial log that has my kick but not a later `undoKick` (and my rejoin) says `removed` and drops the server from a restore. It errs on the safe side; a fresh invite after the owner lets me back brings it back.
    - The app lock (`Core::lock_keys`) drops the server secrets a waiting restore holds and pauses it; after `unlock_keys` the backup is fetched again. Otherwise, once found, a newer backup isn't fetched again until the next start or unlock.
  - **Progress (G-91):** `getServerRestore()` returns `ServerRestore { state, found, waiting }`. The event `serverRestore.changed` carries the same, sent only when something in it changed.
    - `state`: `none` (no restore since this start), `searching` (no backup found yet), `waiting` (found; `waiting` servers have nobody reachable yet), or `done` (every server is back, or isn't mine any more).
    - `found`: the live servers the backup lists (0 until found). `waiting`: of those, the ones not back yet.
    - The UI shows "searching" and "waiting" honestly on the restore screen, with the invite-link hint (PO G-91 criterion 2). A server I left, was removed from, or that closed never comes back and isn't counted as waiting.
  - **Buddies, phase B (#461):** every 10 min the core checks its 3 backup buddies, at most one per owner group. A gone buddy, or two under one owner, is replaced at once; 2 or more stale buddies, or room for more, wait a day. A new set makes the next backup round write to the mailbox and to them (`Network::put_backup_to`, a no-op until dev-sync's network re-checks each recipient is a bound current co-member at send time; `BUDDIES` stays off until the Security Lead's re-review).
    - **GAP-11 (local plaintext):** `member-seen`, when each co-member was last seen online, and `backup-buddies` are kept in `core.db` in the clear, like the rest of the store until GAP-11. They never go into the backup or `exportDiagnostics`.
  - **Holders:** the ports are no-ops until dev-sync's `/mvs/backup/1` and devops' mailbox exist. `LoopbackNetwork` holds them for tests.

- App lock, G-78 (`src/applock.rs`, `docs/design/app-lock.md`). The core keeps the passcode verifier and one attempt counter; the shell's main process enforces the lock.
  - **Commands.** Every answer is `ok`; "wrong" is an answer, not an error. `AppLockAnswer` is `{ result: 'ok' | 'wrong' | 'rate-limited', retryAfter?: seconds }`.
    - `getAppLock()` returns `{ enabled, method: 'passcode' | 'os', idleMinutes, lockOnSleep, retryAfter? }`. It never holds the verifier or the salt. Off: `enabled: false`, `passcode`, 5, `true`.
    - `verifyAppLock({ passcode })` returns `AppLockAnswer`. With no lock set it answers `ok`.
    - `setAppLock({ current?, passcode, method, idleMinutes, lockOnSleep })` returns `AppLockAnswer`. `current` is required once a lock is set, and is checked as an attempt. A new passcode is 4–12 digits or a passphrase of 6–64 characters (NFC, no control characters, no leading or trailing spaces); `idleMinutes` is 1–60. Anything else is `bad-request`, before anything counts.
    - `clearAppLock({ current })` returns `AppLockAnswer`; `ok` turns the lock off.
    - `clearAppLockWithWords({ words })` returns `AppLockAnswer`. `words` is a string of at most 1024 characters (longer: `bad-request`); `ok` only for this identity's 12 words (the restore check), and it turns the lock off. No identity: `not-found`.
  - **Main-only:** `getAppLock`, `verifyAppLock` and `clearAppLockWithWords` stay off the page's allow-list (`desktop/src/commands.js`); main calls them itself. The page reaches `setAppLock` and `clearAppLock` only while unlocked.
  - **Fail closed:** any stored lock record counts as on, even one that doesn't parse or has another version. Then every passcode is `wrong` (counted), and only the 12 words clear it.
  - **The verifier:** Argon2id at `LockParams::MIN` (19 MiB, t=2, p=1) over the NFC passcode and a 16-byte random salt, then `derive_key("mvs/app-lock-verifier/v1", …)` (`identity::app_lock_verifier`). Stored in the core DB as `{ v: 1, salt, mKib, t, p, hash }` with the settings, compared in constant time. It is **not** `Vault::set_app_lock`: this passcode is never the vault passphrase.
  - **One attempt counter,** kept in the core DB (a restart keeps it), shared by `verifyAppLock`, the `current` of `setAppLock` and `clearAppLock`, and `clearAppLockWithWords`. The 5th wrong attempt in a row starts a delay of 30 s, doubling up to 15 min (`retryAfter` with that `wrong`). While a delay runs, every attempt is `rate-limited` with `retryAfter`, unchecked. A right answer resets the counter. Nothing is ever wiped.
  - **Never logged:** neither the passcode nor the words, anywhere. Their argument strings are wiped from memory when dropped (the JSON request line itself isn't).
  - **TB1:** the lock is a UI gate only. The keychain and the SQLite store are untouched and stay as readable to anything running as me as before (GAP-11 is the at-rest lock).
  - **Path B residual:** during a call behind the lock, the page's earlier content stays in renderer memory, unmounted from the DOM but not wiped, until the call ends, and incoming call audio keeps playing.

- `signOut({ words: string[] } | { withoutWords: true })` returns `null` (both read at the top level of `args`). It removes this identity from this computer.
  - `words` must be this identity's 12 words: `invalid-words` (with `positions`) for unknown words, `not-allowed` for another identity's. `withoutWords: true` is the explicit "I accept losing this account" path. Neither: `bad-request`. No identity: `not-found`.
  - In order, fail safe:
    1. A wipe marker (the intent) is written beside `core.db`. If it can't be written: `internal`, and nothing changed.
    2. The keychain secret is deleted. If that fails: `keyring-unavailable`, the marker is removed, and nothing changed. Once the secret is gone, a failure to delete the recovery-check entry doesn't stop the sign-out.
    3. The local database is emptied and servers are closed. The core answers and exits, and the shell restarts it.
  - At the next start, before anything opens, with the marker present:
    - **The keychain says the secret is gone:** `core.db` and the sync folder are deleted, then the marker. That includes its `node.key`, so a new identity here gets a new peer ID. On failure the core exits and retries at the next start.
    - **The secret is still there:** only the marker is cleared.
    - **The keychain can't be read:** nothing is deleted, the marker stays, and the core starts offline, never with the old node key.
  - The app then starts at "create or restore". No new event: the UI goes back to onboarding on `ok` (pending requests fail with `core-restarted`).

- `updateProfile` with a new display name (trimmed) posts a new profile post to every server I'm still a member of (not kicked, not left, not closed); the latest one wins for everyone. The same name, or a new bio or avatar only, posts nothing: bio and avatar stay on this device, since the profile post carries the name (and caps) only. A server that refuses the post is skipped; the call still succeeds. Errors as before: `bad-request` for a bad name, bio or avatar, `not-found` with no identity.
  - **`profile-too-large`** (new code): the name, small picture and colour together don't fit one profile post (4 KiB with the caps).
    - This happens only with a long name of 4-byte characters (emoji) beside a picture near the 2,560-byte cap. For example, 128 emoji and the largest picture are refused.
    - Nothing is saved or posted, and the old profile stays. The UI says to shorten the name or use a smaller picture.
    - The budget: a 32-emoji name, the largest picture, a colour and every cap leave at least 256 bytes for later releases' caps (`lv:N`). A test guards this.

- Age claims and the 30-day rule (decision 18, B13 §3, B7 §9). Each claim is decided from my latest accepted claim in that server:
  - A birth date that raises me from "not adult" to adult posts nothing. It sets `Identity.pendingBirthDate: { date, effectiveAt }` (`effectiveAt` = when found + 30 days). Until then I count as under 18: the core refuses 18+ joins (`age-blocked`), and servers keep my earlier claim.
  - When `effectiveAt` passes, the next sync round posts "adult" to every server I'm still in, clears `pendingBirthDate`, and emits `identity.changed`.
  - A lowering is posted at once. A claim equal to the one the server holds isn't posted again.
  - So a restore (`restoreIdentity(words, input)`) can't skip the 30 days: the rejoin compares against the claim the server already holds.
  - A raise means a *changed* date. A date entered at sign-up on this computer, or one a server's **"adult"** claim already agrees with, is the one my claims come from. A "not adult" agreement proves nothing: a restored date a day short of 18 still waits. Turning 18 with it is a birthday, with no wait.
  - **Known limit,** until the encrypted backup (#291) brings the old birth date back: after a restore with a new adult date, a server I join for the first time has no earlier claim to compare, so it gets "adult" at once. Joining a fresh server first doesn't lift the wait on the old ones: only an agreeing claim or the 30 days do. The client clock, or a modified client, can also skip the wait (Security Lead, GAP-22).

- Correcting the birth date (G-77, B7 §2, §9). `date` is a real `YYYY-MM-DD` from 1900 to today (UTC); anything else is `bad-request`. Each answer is `AgeCorrectionPreview { kind: 'same' | 'lower' | 'raise' | 'too-young' | 'owns-restricted-server', effectiveAt?, loses: { serverId, name, channel? }[], blockedBy?: { serverId, name }[] }`, judged by date against my current birth date (a waiting raise doesn't count yet): an earlier date is a raise, a later one a lowering, even when my age today is the same (Tech Lead on #512: an earlier birthday at the same age would otherwise skip the wait).
  - `previewBirthDateCorrection(date)` changes nothing.
  - `correctBirthDate(date)` applies it and fires `identity.changed`:
    - **same** (the identical date): any waiting correction is dropped.
    - **lower:** at once. A restore's waiting cap (at most 17) stays until its own time, for the new date; a lowering can't lift it, and cancel can't remove it. The new age claim goes to every server I'm in. An 18+ server I'm now too young for is left (one I own refuses the correction instead, below): its `Leave` goes through the leave outbox (as `leaveServer`), and `server.removed { serverId, reason: 'age', required: '18+' }` fires. Elsewhere, each 18+ channel I saw fires `channel.removed { …, reason: 'age' }`. `loses` lists them beforehand: a whole server has no `channel`.
    - **raise:** pending for 30 days: `Identity.pendingBirthDate = { date, effectiveAt }`, and `birthDate` stays until then. A new correction replaces it; the same one again keeps its clock. When it's due, the next sync round makes it my birth date, posts the claims and fires `identity.changed`. A server left on a lowering doesn't come back by itself.
    - **too-young** (under 16): rejected with the new error code `too-young`; nothing changes.
    - **owns-restricted-server:** see "An owner" below.
  - `cancelBirthDateCorrection()` drops a waiting correction (`ok` with none). A raise found after a restore isn't a correction and can't be cancelled (`not-allowed`): there's no earlier date to go back to.
  - Same and lower never make the date "the one my claims come from": a restored date stays untrusted, so a date a day short of 18 still waits 30 days. A raise does once it settles, having waited its own 30 days (Security Lead on #512). A correction made while a restore's raise waits keeps that cap (at most 17) until its own 30 days.
  - `channel.removed` gains `reason?: 'deleted' | 'age'`; `server.removed` gains `reason: 'age'` and `required?`.
  - **An owner** (PO on #512): a lowering below the restriction of a server I own is refused with the new code `owns-restricted-server`, and `CoreError.servers` names those servers (the preview: `kind: 'owns-restricted-server'`, `blockedBy: { serverId, name }[]`). Nothing changes. The restriction is never lifted for me; the UI says to lower the restriction or close the server first (and, once G-43 exists, to transfer ownership). Raises and lowerings that keep me at or above every restriction I own still work.

- Restore on a new computer:
  - `restoreIdentity(words, input?: { locale, country, birthDate })`. The words don't carry the country or birth date, so the UI asks them again (with the agreement) before the words and passes them here, as `createIdentity` takes them. The name follows with `updateProfile`.
  - Rejoining a server I'm still a member of (its invite link, after a restore) signs no new join. It never posts an empty display name or an age claim without a birth date: the server keeps the profile and claim it holds. With no birth date it isn't age-blocked either: my earlier claim stands. A known age below the server's minimum still blocks.

- `grantRole(serverId, userId, role: 'admin' | 'moderator' | 'member')` and
  `revokeRole(serverId, userId)`.
- `Member.role: 'owner' | 'admin' | 'moderator' | 'member'`.
- Voice calls (voice v1, piece B; voice rooms v2, 0.4.3; `src/voice.rs`). IDs are 64 lower-case hex, and `identity` is a user ID.
  - Calls happen only in voice rooms ("join to create"). Rooms are soft state carried in voice hellos: no records, nothing stored or synced. A room lives while a verified participant's hellos keep arriving, and is gone with its last one. Text channels carry no calls, and there is no 18+ gate.
    - A room's ID is derived and checked by every receiver: `blake3::derive_key("mvs/voice-room/v2", serverId ‖ creatorKey ‖ createdAt_ms_le)`. It can't be claimed for another creator or time, and it can't be a channel's or a v1 room's.
    - Caps: 10 live rooms per server (the first to arrive), each room's `limit` (2 to 5) of members, and one room per identity (a hello for another room ends the earlier stay).
  - `VoiceRoom { serverId, roomId, creatorId, createdAt, name?, limit, masterId, members: { userId, muted, joinedAt }[], relayOnly }`.
    - `members` are ordered by `joinedAt`, at most 5. They're built from verified hellos only, each dropped 30 s after we last received one, and include me when I'm in the room.
    - `masterId` is computed by the core: the earliest `joinedAt`, with ties going to the smaller ID.
      - `joinedAt` is frozen for a stay. While a core is learning a room (within 30 s of first hearing of it: it just started, or the core just came online), a claim must be no earlier than `createdAt` and no later than the hello's time plus 120 s, or the hello is dropped. Every member already in the room says hello within that time, so cores agree whatever order the hellos arrive in. A newcomer to a room known for longer has its claim clamped to at least now minus 120 s, never dropped.
      - Accepted residual: someone joining within 2 minutes of another member can claim to be earlier.
      - So the master is advisory: it can only rename and set the limit, and grants no other right. The server owner's edit always wins: the master applies it whatever the master set before.
    - `name` and `limit` come only from the master's hellos. With `name` absent, the UI shows the default name with the master's display name.
  - `createVoiceRoom(serverId)` returns a `CallState` for the new room (its `channelId` is the room ID), with me as its creator and master. It leaves any other call first.
    - Errors: `not-found` (a server I don't have), `not-allowed` (not a member, or kicked), `room-cap` (10 live rooms, by this core's view), `relay-only`, `in-call-elsewhere`, `not-implemented`.
  - `listVoiceRooms(serverId)` returns the server's live rooms, `VoiceRoom[]`, oldest first.
    - Errors: `not-found` for a server I don't have (a kicked member's core removes it), `not-allowed` if I'm not a member or I'm kicked.
  - `editVoiceRoom(roomId, name?, limit?)` returns `null`. `name: ""` restores the default.
    - The master's edit is applied at once, and its next hello, sent at once, carries it.
    - The server owner's edit is sent to the master as an `edit`, and the master applies it only if the signer owns the server.
    - Errors:
      - `not-allowed`: neither the master nor the owner;
      - `bad-request`: a name over 32 characters, or with bidi, control or zero-width characters; a limit outside 2 to 5, or below who is in the room;
      - `not-found`: no such live room, or the master is unreachable for the owner's edit.
  - `joinCall(channelId)` takes a live room's ID and returns `CallState { channelId, participants: { identity, muted }[], full, relayOnly }`, me first; `channelId` is the room ID. It leaves any other call first.
    - Errors:
      - `not-found`: an unknown ID, or a room that's gone.
      - `not-allowed`: a text channel's ID, not a member, or kicked.
      - `call-full`: the room is at its limit.
      - `relay-only`: relay-only is on, so calls are off.
      - `in-call-elsewhere`: my own identity is already in a room from another computer. One computer per call, one room per identity.
      - `not-implemented`: no voice transport (sync's piece A).
  - `leaveCall()` returns `null` and is idempotent. The app lock and quitting leave too.
  - `setMuted(muted: boolean)` returns `null`. `not-allowed` outside a call.
  - `setDeafened(deafened: boolean)` returns `null` (G-84b). `not-allowed` outside a call. The others see it only together with mute, and only from cores that understand it:
    - `CallParticipant` and the voice room members gain `deafened`. It's present only when true, and only together with `muted`.
    - On the wire, every hello's `payload` advertises caps: `{"caps":["deafen"]}`, as JSON with no other keys.
      - At most 128 bytes and 8 caps, each 1–16 characters of `[a-z0-9-]`. Unknown caps are ignored, and anything malformed means no caps.
      - Cores before 0.6.0 never read a hello's payload.
    - Caps are remembered per signer, up to 1024; when full, the stalest goes. They expire with the roster's hello timeout.
    - A hello carries `deafened: true` only to signers that advertised `deafen`, because older cores refuse unknown fields.
      - A broadcast hello is sealed twice, with a fresh nonce each time. Everyone else, my own other computers included, gets the plain one.
    - A received `deafened` counts only with `muted`.
  - `sendSignal(to, kind: 'offer' | 'answer' | 'ice', payload: string)` returns `null`.
    - Errors:
      - `not-allowed`: not in a call, or `to` isn't in it.
      - `bad-request`: an unknown kind, a payload over 12 KiB, or an offer or answer whose SDP has no `a=fingerprint`.
      - `not-found`: a malformed `to`.
  - Events:
    - `call.state` (a `CallState`) on every change to my call: join, leave, mute or timeout. After a leave, or a refusal by a full call, its `participants` is `[]`.
    - `call.signal { from, kind, payload, fingerprintVerified: true }`.
    - `voice.rooms { serverId, rooms: VoiceRoom[] }`: the whole list, sent when a server's rooms change (created, gone, join, leave, mute, timeout, kick, rename, limit), whether or not I'm in one.
      - At most one per server per sync round, and only while I'm a member.
      - It's a hint: re-read with `listVoiceRooms`. `muted` is a display hint.
  - It fails closed. A core-to-core envelope is signed by the sender's identity key under `mvs/voice-signal/v1`, and the signature covers the SDP and its fingerprint. The core drops, without an event:
    - an envelope that doesn't verify, or isn't `v: 2` (0.4.x's v1 is dropped, so rooms need everyone on 0.4.3 or later);
    - one without a `room { creator, createdAt }`, or whose room ID doesn't derive from it;
    - a hello for a room new to us whose `createdAt` is more than 120 s ahead of our clock (an older room is fine: we may have come online late), or whose creator may not call;
    - an 11th room's hellos;
    - a `joinedAt` outside the window above while learning a room;
    - an `edit` from anyone but the server owner, or one not sent to the master;
    - one outside ±120 s of our clock;
    - a replayed nonce (up to 4096 remembered; when the cache is full, new envelopes are dropped);
    - one from someone who couldn't call in that server;
    - an offer or answer without a fingerprint.
  - Presence: a hello every 10 s, a bye on leaving, and a participant dropped after 30 s of silence. A master that goes quiet is dropped the same way, and the hand-off follows.
    - Hellos and byes go only to members who may call.
    - They also go to my own identity, which reaches only my other computers (same recovery words). A hello or bye signed by me counts only when sync bound its sender to me and it has no `to`. It marks me "in a call elsewhere" until its bye or 30 s without a hello, and never appears in a roster. My own envelopes echoed back are replays.
    - A full call's refusal counts only if it comes from someone already in that call, within 10 s of joining.
  - `applyUpdate` answers `not-allowed` during a call.
  - Voice media over libp2p (G-81 2a part c, #509 §2.3). The core carries Opus frames to the call's peers that the UI has no LAN WebRTC connection with:
    - `CallState.callId`: 32 lower-case hex. It's random for each call I join, present only while I'm in one, and new on every join.
    - `CallParticipant.path`: `'lan' | 'direct' | 'circuit' | 'member-circuit' | 'none'`, how my frames reach that participant now, as the node reports it. It's absent until the node reports one, and a change is a `call.state`. It's a display hint; the node picks routes, never the UI.
    - `setCallWebrtcPeers({ identities: string[] })` returns `null`. It names the participants the UI has a live LAN WebRTC connection with, and the core sends frames to every other participant. The UI can only exclude peers, never add targets.
      - At most 5 identities; more, or a malformed ID, is `bad-request`.
      - It resets on every new call. A change is a `call.state`.
    - `voiceFrame` is a sidecar line `{"cmd":"voiceFrame","args":{"callId","seq","ts","data"}}`. It has no `id` and never gets a reply, even with an `id`.
      - The sidecar's reader routes it on an exact `cmd` match only (`VoiceFrame` or `voiceFrame ` are ordinary commands, so they get `bad-request`). It never waits for a command, and replies to commands keep their order.
      - Strict: exactly those four fields. `callId` is 32 lower-case hex, `seq` and `ts` are u32, and `data` is standard base64 of at most 400 bytes (empty means a DTX gap); the length is checked before decoding.
      - It's sent only while I'm in the call with that `callId`, the keys aren't locked and I'm not signed out. Anything else is dropped silently, counted, and never logged.
      - The gate closes synchronously on leave and on a relay-only switch without `--voice-p2p`, before the node is told. So a frame that overtakes `leaveCall`, or comes after it, sends nothing.
      - Lock, sign-out and a required update (RU1) shut it first and unconditionally, whether or not leaving the call succeeds. Until unlock, no frame passes either way and no call reopens it; after sign-out or RU1, not for the rest of the process.
    - `voice.frame { callId, from, seq, ts, data }`: a frame from a participant of my current call (`data` as above). Frames of any other call are dropped.
    - `mvs-core --voice-p2p` (no value; the shell's `voiceP2p` flag): while relay-only is on, `createVoiceRoom` and `joinCall` work, and switching relay-only on doesn't end my call. Media then runs over our relay circuits only, never direct or through a member relay. Without the flag, relay-only refuses calls as below.
- Relay-only (GAP-6r), per device:
  - `setRelayOnly(on: boolean)` returns `null`. It's stored in the core database and needs no identity. On:
    - the network keeps no direct listener, makes no direct dials, and reaches peers only through relay circuits, and direct connections already open are closed (#274);
    - my call ends at once (a bye to the others, then a `call.state` with `participants: []` and `relayOnly: true`);
    - `createVoiceRoom` and `joinCall` answer `relay-only` until it's off (not with `--voice-p2p`, above).
  - At start, `mvs-core` reads the stored value before the network starts, and the node starts relay-only from the first moment (`NodeConfig.relay_only`: no direct listener, no bootstrap dial, no punching). It fails closed: a database that can't be opened or read, or a value other than off, means on.
  - Shown up front:
    - `AppInfo.relayOnly` from `getAppInfo`;
    - `VoiceRoom.relayOnly`, so the UI can disable "Join" before trying;
    - `CallState.relayOnly`.
  - After a change, one `voice.rooms` per server at the next sync round carries the new value.
- `CoreError.code`, voice: `'call-full' | 'relay-only' | 'in-call-elsewhere' | 'room-cap'`.
- Member relays (#368, slice 1). The setting only: the relay itself is slice 2.
  - `MemberRelay { setting: 'auto' | 'on' | 'off', effective: boolean, reason?: 'global-off' | 'minor' | 'relay-only' | 'metered', role: boolean, disclosureSeen: boolean, dailyCapMb: number }`.
    - `setting` is stored in the core database, per device, and defaults to `'auto'`.
    - `role` is true when I'm owner or admin in at least one server where I'm still a member (not closed, kicked or left), by the log as read so far.
    - `'auto'` means `role`.
    - `effective` is false until the one-time disclosure is acknowledged with `markMemberRelayDisclosureSeen` (PO on #387), whatever the setting. It's the one value slice 2's relay reads, so it fails closed. The UI shows the disclosure when relaying would be on but `disclosureSeen` is false: no `reason`, and the setting is `'on'`, or `'auto'` with `role`.
    - `reason` forces `effective` off, whatever the setting. The first that applies wins:
      1. `global-off`: the signed manifest's flag. Reserved; slice 3, never set yet.
      2. `minor`: no trusted adult birth date (the age claim's rule: a restored date counts only once it agrees or its 30 days are up).
      3. `relay-only`: relay-only is on.
      4. `metered`: the desktop shell reports a metered connection (`setMetered`, below), and also at every start until the shell first reports (it fails closed).
      5. `on-battery`: the desktop shell reports running on battery (`setOnBattery`, below), and also at every start until the shell first reports (it fails closed).
    - Without an identity, `effective` is false.
    - `dailyCapMb` defaults to 2048.
  - `getMemberRelay()` returns `MemberRelay`.
  - `setMemberRelay(setting)` returns `MemberRelay`. A setting other than those three is `bad-request`.
  - `setMemberRelayCap(mb: number)` returns `MemberRelay`. Values from 256 to 51200 are accepted; anything else is `bad-request`.
  - `markMemberRelayDisclosureSeen()` returns `null`.
  - `setMetered(metered: boolean)` returns `null` (slice 3a). The desktop shell sends it, never the page: it is not in the renderer's allow-list or `CoreCommands`. Kept in memory only, and it fails closed (SL on #640): from every start the core counts as metered until the shell first sends it. The shell sets it whenever a core comes up, then on every change (it checks at start, every 60 s and when the network changes, and any error counts as not metered). A non-boolean or an extra field is `bad-request`.
  - `setOnBattery(onBattery: boolean)` returns `null` (relay in the app, RR2). Like `setMetered`, the desktop shell sends it, never the page; it is kept in memory only. It fails closed: from every start the core counts as on battery until the shell first sends it, so the shell sends it whenever a core comes up (`false` on a machine with no battery), then on every change. A non-boolean or an extra field is `bad-request`.
  - Event `memberRelay.changed`, with a `MemberRelay` payload. It fires once whenever any field differs from the last value announced, and never otherwise. That covers:
    - a role read from the log (promote, demote, ownership);
    - a join or leave;
    - relay-only toggled;
    - the birth date changing, or its 30 days ending;
    - the setting, the cap or the disclosure changing.
    The core checks after every command and every sync round.
  - `core.status.memberRelay.effective` is the desktop shell's to add (it builds `core.status`). It can follow `memberRelay.changed`.
- Device link, "approve on your other device" (`device-link-slice.md`). The network is dev-sync's `/mvs/device-link/1`, behind the port in `device-link-port-api.md`.
  - **New device** (signed out):
    - `startDeviceLink()` returns `{ qr, code, expiresAt }`. It's `not-allowed` once signed in, and `offline` without a relay reservation.
      - `qr` is `mvs-link:1:` and base58 of `e_new_pub ‖ peer ID ‖ "\n" ‖ circuit address`. It's printable ASCII, at most 1024 characters.
      - `code` is 10 characters of base32 (`[A-Z2-7]`), a rendezvous only: `derive_key("mvs/device-link-rv/v1", code)`.
      - The link lasts 5 minutes. A new `startDeviceLink` replaces it.
    - `cancelDeviceLink()` returns `null`.
    - `confirmDeviceLink(match: boolean)` returns `null`, dispatched as `{ match }`. This is the new device's own check of the digits (Security Lead on #394): a DHT server that saw the rendezvous could race the first Hello with its own account.
      - Nothing (seed, profile, birth date) is applied before `match=true`. A box that arrives earlier is held until then.
      - `match=false` ends the link (`failed`, `refused`) and wipes anything held.
      - Errors: `not-found` with no link; `bad-request` before `confirm`, when no digits are shown yet.
    - Event `deviceLink.state`: `{ state: 'waiting' | 'confirm' | 'done' | 'expired' | 'failed', sas?, reason?: 'cancelled' | 'timeout' | 'refused' | 'network' | 'keyring' | 'restore' }`. Absent fields are left out, never `null`.
      - `waiting` comes on start.
      - `confirm`, with `sas`, comes on the approving device's first hello.
      - `done` comes once the account has arrived and my user has confirmed the digits, followed by `identity.changed`.
      - `expired` (`timeout`) comes after 5 minutes.
      - `failed` comes with `cancelled`, or with `refused` (`confirmDeviceLink(false)`, or a box that doesn't open), or, when the account arrived but couldn't be restored, with `keyring` (this computer's keychain couldn't store it) or `restore` (anything else).
  - **Approving device** (signed in):
    - `beginDeviceApproval(qrOrCode)` returns `{ sas, expiresAt }`. A code may be lowercase, with spaces or dashes. Errors:
      - `bad-request`: neither a QR nor a code;
      - `not-allowed`: signed out;
      - `not-found`: no such link, expired, or a QR whose key isn't the one answering;
      - `locked-out`: another device's Hello holds the link, so someone else may be trying, and the user should start again (Security Lead on #394);
      - `rate-limited`: after 3 attempts at one link;
      - `offline`.
      A retry from the same device reuses its one-time key, so it's the same session with the same digits.
    - `confirmDeviceApproval(approve: boolean)` returns `null`. `true` sends the account and emits `account.deviceAdded { at, label? }`. `false` ends this attempt, and nothing is sent. Errors: `bad-request` with no approval in progress, `not-found` once expired.
    - `account.deviceAdded { at, label? }`: `label` is plain text, at most 64 characters, with no control characters and no invisible format or direction marks (zero-width, bidi embeddings, overrides and isolates, word joiner, line and paragraph separators, BOM), and left out when unknown (today always). The notice is kept in the core database until `ackDeviceNotice(at)` (which returns `null`; an unknown `at` is fine). It's announced again at the first sync round after each start until acknowledged, so a client may see the same `at` twice and should key notices by it. The cross-device notice will feed the same store.
  - **Crypto:**
    - one-time X25519 keys;
    - the SAS is `derive_key("mvs/device-link-sas/v1", e_new_pub ‖ e_old_pub)`, its first 4 bytes little-endian, mod 10^6, as 6 digits;
    - the transfer key is `HKDF-SHA256(X25519, info "mvs/device-link/v1" ‖ e_new_pub ‖ e_old_pub)`. A low-order point gives no key;
    - the account goes as one XChaCha20-Poly1305 box, a 24-byte nonce first: `{ seed, profile: { displayName, avatarSmall?, color? }, birthDate, birthDateTrusted, country }`.
  - **Restore:** the new device follows `restoreIdentity`'s path: the keychain, then the backup's servers (#291). The birth date stays trusted if it was (#306), and the picture and colour are checked as for a profile post.
  - **Not yet:** the notice on my other devices needs a notice slot at the backup holders (dev-sync). For now only the approving device shows `account.deviceAdded`.
- Invites (#208), all moderator and up (`not-allowed` below that):
  - `createInvite(serverId, input?: { expiresMs?: number, maxUses?: number })`
    returns `{ id, link, expiresAt?, maxUses? }`. `expiresMs` is the last time a
    join through it is accepted (ms since epoch). An absent `expiresMs` means
    never, and `bad-request` if it isn't in the future. An absent `maxUses`
    or 0 means unlimited.
  - `listInvites(serverId)` returns
    `{ id, createdBy, expiresAt?, maxUses, uses, revoked }[]`, oldest first,
    revoked ones included. `maxUses` 0 is unlimited.
  - `revokeInvite(serverId, inviteId)` is allowed for the invite's author or
    someone ranked above it (`not-allowed` otherwise). `not-found` for an
    unknown or malformed ID, or an invite already revoked.
  - A create or a revoke fires `server.updated`, since the server's
    `inviteLink` may then name another invite (or be empty once none is
    left open).
  - Short links (T8-02, `docs/design/short-invite-link.md`):
    - `createInvite` also returns `shortLink`, and `listInvites` returns it for
      an invite I made that is still live; it is absent otherwise. A short link
      is `mvs://join/` plus at most 51 base58 characters, **case-sensitive**.
    - `joinServer` accepts both formats. A short link that finds nobody online
      is retried like any other join.
    - **The UI must not show `shortLink` until release N+1.** Peers on older
      releases can't parse it, so it would read as invalid to them. Until
      then the UI keeps showing the v0 `link` / `inviteLink`. From N+1,
      `createInvite`'s `link` itself becomes the short form.
    - A short link stops working when its invite is revoked, expires or is
      used up, and when the server is closed, left or purged.
- `Member.connection: 'direct' | 'relay' | null` (#187): how we reach an online member, a direct connection (LAN) or through the relay; `null` for us and for members who are offline. A change fires `members.changed`.
- Messages held for their key (#285 follow-up). A plain member who just joined has no channel key until a moderator's re-key reaches them (usually well under a second).
  - `sendMessage` then resolves at once with `{ ..., id: 'pending-<16 hex>', sendState: 'pending' }`, and fires `message.added` with it. Nothing is sealed or sent yet.
    - The message is listed after the channel's stored messages (`getMessages`, `getMessageCount`).
    - It lives in memory only: a restart drops it.
    - At most 50 are held per channel at once; past that, `not-allowed`. Failed ones are bounded too: beyond 50 failed in a channel the oldest are dropped (the UI may still show them until it re-reads the channel).
  - When the key comes, the core's background sync seals and sends it, and fires `message.updated` with the real message: its record `id`, `sendState: 'sent'`, and **`replaces: 'pending-…'`**. From then on it is an ordinary message (`sent`, then `received`).
    - **Its `index` may differ from the pending entry's.** The same round can bring in other messages first: the key can make earlier messages readable, and others may have written meanwhile. These come as their own `message.added` events, before the replacement. The real message is placed after them, and any other held messages after it.
    - So on `replaces`, the UI drops the entry with that `pending-…` ID (wherever it sits) before applying the message at its `index`. It should also re-read `getMessageCount` (or the visible window) rather than keep its own count.
  - With no key after **2 minutes**, or if I can no longer send there (kicked, left, closed), it turns failed:
    - `message.updated` with the same `pending-…` ID and `sendState: 'failed'`;
    - and `notice: rekey-waiting` for the server.
    - It stays listed, failed, until a restart or `discardMessage(messageId)`, which drops a held or failed `pending-…` message and wipes its text (`not-found` for any other ID). "Send again" is `discardMessage` plus a new `sendMessage`.
  - `Message.replaces?: string` is new, and appears only on that one `message.updated`.
  - A moderator or above never gets a pending message: they make the key on the way. A non-member, or someone kicked, still gets `not-allowed` at once.
- `Message.unreadable?: 'no-key' | 'untrusted'` (additive, TODO #21, the PO's placeholders). The message keeps its place (`index`, `createdAt`, `id`), and its `body` is `""`. It has no `mentions`, `mentionsMe` or `reactions`. It counts in `getMessageCount` but never in `unreadCount`, `firstUnreadIndex` or `mentions`.
  - `'no-key'`: sealed under a key this device doesn't hold, by someone who had already seen me join (their record's auth deps reach my latest `Join`). It keeps its `authorId`. It isn't final: if a later rotation opens it, `message.updated` (same `id`) brings the text with no `unreadable`. A message from before my join that doesn't open is never listed, as before.
  - `'untrusted'`: it opens only under a rotation authority doesn't accept (#21). It has **no `authorId`** and no `sendState`, and it's never a reply target.
  - `react`, `editMessage` and `deleteMessage` on a placeholder give `bad-request`.
  - An edit that doesn't open leaves the original text shown (with no `editedAt`); the message is a placeholder only when the original doesn't open either.
- Re-seals (LM-2, the SL's and the TL's decision): a sender who sealed a message before applying someone's Join re-sends it, so the joiner can read it.
  - **What gets re-sent:** my own messages that don't reach that Join, with `ts ≥ Join.ts − 60 s`, that I sent at most 10 min before I applied the Join, in a channel the joiner reads now, and that I never edited or deleted.
  - **The form:** a `MessageEdit` with the same text and the original's `ts`. It's sealed for the current readers once the join re-key covers the joiner.
  - **Limits:** at most 50 per channel per Join, and 100 a minute.
  - **Never re-sent:** to a joiner removed meanwhile, or anything from before that window (D30).
  - **18+ channels turned plain (PO, child safety):** a message written while its channel was 18+ never reaches a joiner who isn't an adult. It stays hidden like pre-join history, with no placeholder.
    - Where the message sits decides, not its time: for such a joiner, in a channel that was ever 18+ (it has a `State.adult_edits` entry), only messages whose `auth_deps` reach the channel's latest accepted edit back to plain are re-sent. A backdated `Join.ts` (a window of about 10 min) changes nothing.
    - It fails closed: with no edit back to plain, or concurrent ones none of which has the others in its past, nothing from that channel is re-sent to them.
  - Display, for every core from this one on:
    - **A reader who can open both the original and the edit:** `editedAt` is absent when the texts are equal, so there's no "edited" label, no `message.updated` and no second unread. With a different text it's an ordinary edit, even when its `ts` equals the original's.
    - **A reader who can't open the original (the joiner):** the edit's text shows in the message's place. `editedAt` is absent when the edit's `ts` equals the original's. Unread and mentions count once, as for a new message.
    - Older cores show a re-seal as an ordinary edit with the same text, perhaps labelled "edited".
  - A message whose latest edit carries its own `ts` isn't pruned (B6-p), and neither are its same-`ts` edits, so readers can compare the texts.
- `CoreError.code`: `'bad-request' | 'not-implemented' | 'internal'`, and `'keyring-unavailable'` (QA-20): the OS keychain (Secret Service on Linux) is missing or unusable. The core still starts; `getIdentity` and anything needing the identity reject with it, and the UI shows the keyring cause.
- `NoticeKind`: `'rekey-waiting'`, sent when removed members still hold a channel key and only a moderator can renew it. Until a moderator does, sending there answers `not-allowed`.
- Server lifecycle (#229 design, #251 authority; `docs/design/server-rename-leave-delete.md`):
  - `renameServer(serverId, name)` returns the updated `ServerSummary` and fires `server.updated` (here, and for every member when they read it). The name is trimmed, then must pass the strict server-name rule (1–100 code points, no bidi, control or zero-width characters). The owner or an admin only.
  - `leaveServer(serverId)` returns `null`. Any member but the owner (who deletes instead). **It never answers `update-needed`.** The server leaves this device at once and `server.removed { serverId, reason: 'left' }` fires.
    - The signed `Leave` waits in a durable outbox, which survives restarts. Only the server's sync secret and its control subscription stay.
    - Each sync round it goes out once the rollout gate is open, and is retried until a member has it (B6 `sent`). Then the secret and subscription go too, and the others re-key.
    - If I'm kicked first, the `Leave` is dropped.
    - The leaver isn't banned, and comes back through a new invite as a plain member.
  - `getUpdateNeeded(serverId, cap?)` returns the user IDs of members whose latest profile post lacks the cap, or who have none. With no cap it's `server-lifecycle-v1`: who blocks a rename or a delete. With `"reactions-v1"`: who blocks reactions (G-26). With `"channel-topic-v1"`: who blocks topics (G-14). Any other cap name is `bad-request`. An empty list means the gate is open.
  - `closeServer(serverId)` returns `null`. The owner deletes the server for good: the core syncs first, then sends the close.
    - On the owner's core, and on every member's when it reads the close, the server is closed, not purged at once. `server.closed { serverId }` fires; any call there ends; its keys and sync subscription go, and it's no longer synced. It stays in `listServers`, read-only, with `ServerSummary.closed: true` (additive).
    - 30 days (`CLOSED_RETENTION_MS`) after the close was received, the rest is purged and `server.removed { serverId, reason: 'closed' }` fires. Its genesis and close record are kept forever, so the server reads as closed, never unknown.
    - An old invite, from someone who was in it or a stranger a stale peer still serves, gives `join.status` `{ phase: 'closed', link }`.
  - Purge (a leave, or a closed server's 30 days): the server's records, sync secret, channel keys, sync subscription, and any call in it. "Removed from your devices", not erased: other members keep their copies.
  - `server.removed` gains an optional `reason: 'left' | 'closed'`. It's absent for a kick, as before.
  - Errors:
    - `not-found`: a server I'm not in.
    - `not-allowed`: not permitted (role), or the owner leaving.
    - `bad-request`: a name that fails the rule.
    - `update-needed` (rename and close only): a current member's latest profile post doesn't carry `caps: ['server-lifecycle-v1']`, or they have no profile post. Nothing was signed. An older member would refuse the record and stall on every control record after it.
  - Profile posts now carry `caps: ['server-lifecycle-v1', 'reactions-v1', 'channel-topic-v1', 'adult-keys-v1', 'server-meta-v1']`, and older versions ignore the field. A core re-posts its profile once where its latest post lacks one of them.
  - **Caps are frozen after `server-meta-v1`** (Tech Lead on #555): released cores gate on these exact names, so they are posted for good. The next gated feature adds one cap of the form `"lv:N"`, a single level that implies every feature up to N; a gate checks `lv >= k`, older cores ignore it, and the profile post stops growing with each release.
    - `lv:N` is per release, not per feature (Tech Lead on #590). It means "this core decodes every kind introduced up to level N".
    - The first release that ships a new kind posts the next level, and every kind that release introduces gates on `lv >= N`.
    - The kind codes are fixed: `SecretRotation` (T17) is 25 and `ServerAgeLimit` (G-52) is 26. If both ship in one release, both gate on that release's level.
- Server age limit (G-52; design `docs/design/server-age-limit.md`, Security Lead and Tech Lead on #590; records and authority #610):
  - `setAgeRestriction(serverId, 'none' | '16+' | '18+')` returns the updated `ServerSummary` and sends `server.updated`.
    - The owner only (`not-allowed`); `not-found` for a server I'm not in; `bad-request` for any other value.
    - `18+` only while my effective age is 18 or more (`too-young`, PO on #512).
    - Behind `lv:1` (`update-needed` while a member's latest profile lacks it; `getUpdateNeeded(serverId, 'lv:1')` lists who): an older core would ignore the limit and keep keying minors.
    - The current value signs nothing. The UI confirms raises and lowerings before calling (spec §2, §3); the core takes no "confirmed" flag.
  - `countAgeAffected(serverId, ageRestriction)` returns `{ count }`: for `18+`, the members other than me without an accepted 18+ claim; 0 otherwise. No names. The owner or an admin (`not-allowed`).
  - The effective limit (the latest accepted change, else the genesis value) replaces the genesis value everywhere: `ServerSummary.ageRestriction`, the join preview and `AgeBlocked`, birth-date corrections and `server.removed`'s `required`.
  - **While the server is 18+:**
    - every channel's readers are members ∩ adults, so the next rotation (at once, in the owner's call) leaves minors out;
    - the receiver rule applies to every channel: deps that don't reach the raise, and the channel's own 18+ edit where there is one, count only from an adult now. A server 18+ from its genesis counts as raised there;
    - a member's core under the limit leaves (`server.removed`, reason `age`, `required: '18+'`), unless its age is unknown (a restored device without a birth date) or it is the owner.
  - **Lowering** re-keys forward only: 16- and 17-year-olds get no key to anything sealed while it was 18+. 18+ channels keep their own readers.
  - `Member.notAdult?: true`: in an 18+ server, a member without an accepted 18+ claim, shown to the owner and admins only.
  - **Accepted residual (Security Lead on #590):** a minor's core that refuses to leave keeps the sync secret, so it can read the plaintext control log and metadata, and T17's leave rotation never fires for it. Such members show as `notAdult` to the owner and admins, who can kick them; a kick rotates the secret.
- 18+ channel keys (B7-k, Security Lead, P1 before the open alpha):
  - An 18+ channel's key rotates to the members with an accepted 18+ claim (`State.adults`) only; every other channel's key goes to all members, as before. The cipher learns the adults and the 18+ channels with the rest of its state (`GroupCipher::set_adults`, from the control log each time it syncs).
  - Someone leaving that set is a removal, as for a kick (#100): an adult whose claim goes "not adult", or a plain channel turned 18+. The next moderator round re-keys the channel for the adults, with `notice: encryption-renewed`, or `rekey-waiting` without a moderator. What's sent after can't be opened by the minor, even with the old key and the record in hand.
  - Someone entering it (a new 18+ claim) is like a join: re-keyed through the GAP-8 bucket.
  - Sending: an 18+ channel isn't listed to, or found by, a member without an 18+ claim, so the send is `not-found` (B7 §4: no hint it exists). A raise counts only after its 30 days (decision 18, already in force), so a raised claim never gets the key early.
  - The cipher's adults are fresh at every seal: a channel turned 18+ and written to at once (no sync between) is re-keyed for the adults first, never sealed under the old key.
  - **Rollout (Security Lead K2):** profile posts carry the new cap `adult-keys-v1`, and `getUpdateNeeded(serverId, 'adult-keys-v1')` lists members whose latest post lacks it. A moderator on an older version still re-keys 18+ channels for every member, so what's sent while such a member re-keys is readable by minors (**residual**, until everyone updates). Owners and admins of a server with an 18+ channel get `notice` `{ kind: 'adult-keys-outdated', serverId }` once while that list isn't empty, and again only after it has emptied. The release carrying B7-k should be a required update for the open alpha.
  - Not covered yet (its own PR, rule agreed by the TL and SL): receivers drop a Message, MessageEdit or Reaction in an 18+ channel whose author isn't an adult at the record's causal position, or, if its deps don't reach the latest ChannelEdit that made the channel 18+, isn't an adult now.
- Display names with emoji ZWJ sequences (B23-z2, Tech Lead on #241), in two steps so a name never reaches a core that would drop it:
  - **Now (the reader):** other people's display names from profile posts pass `authority::display_name_ok`. That's the strict rule, except that a zero-width joiner may join two emoji ("👨‍👩‍👧", "👩🏽‍💻"). A stray ZWJ, or any bidi, control or other zero-width character, is still refused: that post's name is ignored and the previous good one stays.
  - **One release later (the writer):** `updateProfile` accepts such a name for me too (`WRITE_ZWJ_NAMES` in `model.rs` flips to true). Until then my own name keeps the strict rule (`bad-request`).
  - Server, channel and room names keep the strict rule for good: a ZWJ is never allowed there.
  - The UI side (dev-ui): guardCore allows a ZWJ in display names only, never in server or channel names.

- Server icon and description (G-51, `docs/design/server-icon-description.md`):
  - `setServerIcon(serverId, dataUrl | null)` returns the updated `ServerSummary`.
    - `dataUrl` is `data:image/(png|webp);base64,…`, checked in this order: the prefix, a length cap on the base64 text, strict base64, then the magic bytes against the prefix's type, still (no APNG or animated WebP), at most 8 KiB and 128 px a side. Anything else is `bad-request`. `null` clears the icon.
    - Setting an image: at most once per server every 10 minutes from this device (`rate-limited`), since every icon stays in the control log. Clearing it (`null`) is never limited, so an admin can remove an icon at once.
  - `setServerDescription(serverId, description)` returns the updated `ServerSummary`.
    - The text is trimmed; empty clears it. Otherwise up to 500 code points and 5 lines (`\n` only), with no `\r` or U+2028/2029, no blank first or last line, no two blank lines in a row, and no line ending in whitespace. Anything else is `bad-request`.
    - Shown as plain text with its line breaks (`white-space: pre-line`): never Markdown or links.
  - Both commands: the owner or an admin only (`not-allowed`), `not-found` for a server I'm not in, and `update-needed` while a member's latest profile lacks `server-meta-v1` (`getUpdateNeeded(serverId, 'server-meta-v1')` lists who). Setting what's already set signs nothing.
  - `ServerSummary` gains `iconDataUrl?` and `description?` (additive; absent when unset). Any change, mine or read by sync, fires `server.updated`. It's never unread, a mention or a notice.
  - Plaintext inside the server, like the name: every member, or a modified client, can read them (GAP-22).
- `JoinStatus` gains `{ phase: 'removed', link }` (the UI string `join.removed`): I was kicked from this server and not let back (`undoKick`). It's final, like `closed`: the join stops, nothing is signed or stored, and the server's subscription is closed again. It comes before the age gate. It tells me only what I already know, that my own account was removed; it carries no server name, ID or member, and someone else with the same link joins as usual. A restore treats it as a definite answer (the log holds the accepted kick). Before, this was `invalid`.
- Blocked accounts (G-47):
  - `listBlocked()` returns `BlockedUser[]`, `{ userId, shortCode, name? }`, ordered by `userId` (`shortCode` is the identity code, as `Member.shortCode`, so rows without a name can be told apart, G-47b): everyone I blocked, also accounts I share no server with now. `name` is the display name in a server we share, else the one known when I blocked them; it's absent if none was ever known.
  - `setBlocked(userId, blocked: boolean)` returns `null` and is idempotent: setting what's already set changes nothing and fires nothing. My own ID is `bad-request` (from `blockUser` too); an ID that isn't 64 hex is `not-found`.
  - `blockUser(userId)` stays a toggle, for older shells.
  - On a change, from either command: `blocks.changed { blocked: BlockedUser[] }` (the whole new list), and `members.changed` for each server the account is in.
  - Unblocking also drops the kept name. A block stays on this device only; it's never sent.
- Message links (G-30, `docs/design/g30-message-links.md` §4):
  - `locateMessage(serverId, channelId, messageId)` returns `{ index }`: the message's place in `getMessages(channelId)` order, as of now. Local and read-only: it never asks peers or starts a sync. It costs one decryption pass over the channel, like `getMessages`.
  - **One answer for everything I can't see** (Security Lead, R1): `not-found`, identical in every case, so a link never confirms that something hidden exists. That covers: not a member (servers I left or was removed from are purged), no such channel or one `listChannels` doesn't give me (an 18+ channel hidden by B7 §4), IDs that don't agree, a message that isn't here or doesn't open (no placeholders until #21), and a message still waiting to send (`pending-…`).
  - `bad-request` only for an ID that isn't 64 hex (the UI never sends one).
  - A deleted message keeps its index (the tombstone). A closed server answers as its `getMessages` does: its keys go at the close, so messages that no longer open are `not-found` there too.
  - The index is a snapshot: a message with an earlier timestamp can arrive later and shift it. The UI checks the ID at the index and locates again if it moved.
- 18+ channels, the receiver rule (B7-k, Tech Lead and Security Lead on #544). In a channel that is 18+ in my current fold, a Message, MessageEdit or Reaction counts only if:
  - (a) its author is an adult at the record's causal position: their latest accepted age claim before its `auth_deps` (`Resolver::adult_at`); and
  - (b) if its `auth_deps` don't reach the latest edit that made the channel 18+ (`State.adult_edits`, `Resolver::reaches`), its author is also an adult now.
  - A failing record is dropped like a kicked author's: not shown, never unread, a mention or a notice. It stays in the log. A plain channel, or one turned plain, has no check. Nothing is cached per record: it's recomputed on every fold.
  - So a minor's post with stale deps is dropped, and an adult who lowers their age keeps what they posted after the channel turned 18+. Posts from before the flip by someone who isn't an adult now are hidden: the accepted cost.
  - **Accepted residual (Security Lead):** a former adult whose claim a modified client lowered can still post with stale deps that point at an adult moment after the edit. The claim is self-attested anyway (GAP-22).
- Newer versions in a server (the detector, Tech Lead plan):
  - `ServerSummary` gains `updateNeeded: boolean` (additive, default false). It turns true when a current member of a server I'm in wrote a validly signed record of a kind this version doesn't know (`records::Record::peek_unknown`): they run a newer version, and mine may miss what it adds. The UI shows an "update to keep up" hint for that server.
  - Sync still refuses that record: it's never stored, forwarded or acked. Anyone else's (a stranger, a kicked member, a broken signature, a server I'm not in) never sets the flag.
  - One `server.updated` when it turns true, then none for further records. In memory only: never cleared by a timer, only by a restart, so it comes back after one only if such a record is seen again.
- Server secret rotation (T17, `docs/design/server-secret-rotation.md`; step 2b, draft):
  - **Reading** is always on.
    - The accepted `SecretRotation` parts are grouped by (author, rotation), so a part signed under someone else's rotation ID never joins theirs (Security Lead and Tech Lead on #609). Only complete groups count: every part, no gaps.
    - The complete rotation whose last part is latest in linear order wins.
    - When it sealed a secret for me, I store it (sealed), reopen sync on it, and send `server.updated`: the invite link carries the new secret. Every secret a rotation replaced stays, sealed, for 7 days (`PREVIOUS_SECRET_FOR_MS`), for reading the old secrets' frozen prefixes (Security Lead T17-W1, Tech Lead on #609).
    - The secret never appears in a log or an event.
  - **Writing** stays off (`WRITE_SECRET_ROTATION`) until S3/S4 and S5 are merged, in the release that requires updating (Tech Lead on #592 and #609). A unit test keeps it off until then. Then:
    - a kick rotates at once, from the kicker's core (PO on #557);
    - the owner's core rotates whenever the current secret is held by someone who is no longer a member (a kick or a leave: S2 `Required`), or misses a member who joined through an invite from before the rotation (S2 `Add`). A join through a newer invite rotates nothing, since its link already carries the new secret.
    - a moderator rotates only for their own kick, so moderators don't all rotate at once.
    - A rotation seals a fresh secret for the current members only (S2).
  - `lv:1` joins the posted caps: this core decodes every kind up to code 26 (`SecretRotation` 25, `ServerAgeLimit` 26; Tech Lead on #609). `LEVEL_MAX_KIND` and a test hold the level to what the core decodes.
  - Not yet, still to come in T17:
    - the old secret's read-only frozen prefix (S3/S4, dev-sync);
    - re-issued invites with the owner notice, the backup and the LAN beacon key following the rotation (S5);
    - with no owner online, an admin rotating for a leave after 24 h plus 0–6 h of jitter (Security Lead Q1 on #609, step 2c).
- `syncNow()`: test-only until `sync` drives updates. It shouldn't ship in
  the UI.

## In-app update (B8)

Built in B8-5 (`src/update.rs`, tests in `tests/update.rs`), from
`core/updater/docs/B8-in-app-update.md`, approved by the tech lead and the
security lead. The `updater` crate does all the work (signatures, root
chain, policy, hash, size, unpack, state, lock); `core/api` only wires it in.

**Startup.** `mvs-core --update-root <install folder>`. The shell passes it
only when packaged and the root checks out (§0: derived from
`process.execPath`, and `mvs-launcher` must exist). Without it, updates are
off: each command below answers `not-implemented`, no timer runs, and the
core never contacts the update host. Updates also stay off in a build
without `MVS_APP_VERSION` (set by release.yml; the running version). The
state folder is `updater::UpdateDirs::default_state_dir()`.

**Commands.** All four are main/core-only. None is in `CoreCommands`
(`ui/src/core/api.ts`) or in the renderer allow-list
(`desktop/src/commands.js`), per A2. The renderer keeps only
`restartToUpdate`, which main handles itself and turns into `applyUpdate`
plus a relaunch through the launcher.

| Command | Result `ok` | Errors (`code`) |
| --- | --- | --- |
| `checkForUpdate()` | `{ "status": "up-to-date" \| "available" \| "staged", "current": "1.2.0", "available": "1.3.0" \| null, "freshness": "fresh" \| "stale" \| "never" }` | `offline`, `invalid-update` (any verification failure; details only in the log), `check-clock` (`IssuedInFuture`, or every manifest expired) |
| `downloadUpdate()` | `{ "version": "1.3.0" }` once it is verified, unpacked and staged | `nothing-to-download`, `offline`, `invalid-update`, `disk-full` |
| `applyUpdate()` | `{ "version": "1.3.0" }`: main may now relaunch through the launcher | `nothing-staged`, `not-allowed` (in a voice call or screen share; `update.ready` then has `waitingForCall: true`) |
| `markHealthy()` | `{ "committed": "1.3.0" \| null }` (`null` when the running version was already committed) | `not-allowed` (not a trial boot) |

**Events.**

| Event | Payload | When |
| --- | --- | --- |
| `update.ready` (exists: `UpdateInfo`) | `{ "version": "1.3.0", "waitingForCall": false }` | after a stage, and again when a call ends |
| `update.installed` (new) | `{ "version": "1.3.0", "notes": "plain text" \| null }` | once, after `markHealthy` commits a new version; `notes` comes from `ManifestBody::notes_for(<UI language>)`. The UI shows it as **text only** |
| `update.rolledBack` (new) | `{ "failed": "1.3.0", "running": "1.2.0" }` | once, on the first healthy start after the launcher rolled back |
| `update.required` (new) | `{ "version": "1.3.0" \| null }` | when a required update turns on (an accepted manifest revoked the running version), or when the version on offer changes; `null`: none yet |

**Required updates** (`docs/design/required-update.md`):
- `getAppInfo` gains `updateRequired: { version: string | null } | null`. It's set from the first moment of a start when an earlier check found the running version revoked (`policy.json`), and after any check that does. It never clears within a process; only a restart into a version that isn't revoked clears it.
- While it's set:
  - the download starts at once and checks repeat every 15 minutes;
  - a version that failed its trial here is never fetched again;
  - **RU1:** the core signs nothing and syncs nothing. Every command that would sign answers `update-required` (a new `ErrorCode`), with nothing signed. The sync round, re-keys, rotations, re-joins, profile posts and the report outbox don't run, and the node goes quiet (no gossip, pulls, dials or relaying). Local reads still answer.
- `checkForUpdate` keeps working; it's what the banner's Try again calls.
- **Residuals, accepted by the SL on #599:**
  - **Unreadable or missing `policy.json`:** it fails open. The version isn't required until the next accepted check (within minutes), and in that window an outdated core could run one sync round. Fail-closed would lock people out over a corrupt file, and only local file access can cause it. Network-side refusal is the backstop.
  - **Startup:** the node starts just before the core reads `policy.json` and quiets it, so for a moment it may serve and store records. The core signs and publishes nothing in that window. Follow-up: start the node quiet.

**Rules the core keeps:**
- The first check runs once the UI is up (the first `markHealthy`, so the
  UI hears `update.ready`), or 2 minutes after start if that never comes.
  Then every hour ± 5 min (jitter), and at once after `setUpdateChannel`.
  Each check downloads whatever is available. Downloads are never paused
  for a call: only the apply step waits. Check and download errors go to
  the log (`RUST_LOG`), never to the UI. An already staged version is
  announced again (`update.ready`) on every check.
- All state goes through `UpdateLock`, `save_state` and `write_atomic`.
- Before any schema migration, it writes `core.db.pre-<schema>` (owner-only)
  and records it in `db-snapshot.json`. It deletes the snapshot when
  `markHealthy` commits (§0). TODO: `db.rs` has no versioned migrations
  yet; the first one calls `Updater::record_db_snapshot`.
- The UI channel maps to the manifest channel: `stable` → `alpha` during the
  closed alpha, `beta` → `beta`. Each has its own fixed-tag release,
  `update-<channel>`. Switching channel never downgrades: the running
  version is the floor.
- `update.installed` carries the notes in the profile's language (`he`
  when there is none yet), falling back as `ManifestBody::notes_for` does.

**`api.ts` changes for dev-ui:**
- add `update.installed` and `update.rolledBack` to `CoreEvents`;
- add `'offline' | 'invalid-update' | 'check-clock' | 'nothing-to-download' | 'nothing-staged' | 'disk-full'` to `CoreError.code`, for when main forwards them.
