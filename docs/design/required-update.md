# Required updates (for B7-k K2 and T17)

- **Status:** proposal. No code until the SL and TL approve. dev-updater owns `core/updater` and the release scripts, voice-shell owns `desktop/`, and the UI screen goes to dev-ui unless the manager says otherwise.
- **Why:** B7-k's 18+ key rule (K2) and T17's secret rotation each need a release that **older versions must install**: a client that stays old keeps the old behaviour on the network.

## 1. The lever: `revoked`, not a new manifest field

- **A new field breaks old clients.** `ManifestBody` is `#[serde(deny_unknown_fields)]`, so a `minVersion` or `required` field (or `format: 2`) makes every deployed client **reject the manifest**, and then they never update again. That's the worst possible outcome, so the manifest format doesn't change.
- **`revoked` already means "you must not run this".** Every deployed client parses it:
  - `ClientPolicy` keeps every revoked version, and the set only grows;
  - an update never installs one, and the launcher never rolls back to one;
  - if the **running** version is revoked and nothing newer is staged, the launcher starts it anyway "so its updater can fetch the fix" (`Boot::RecoveryRequired`);
  - `ClientPolicy::is_revoked` exists, documented as "the app should treat the next update as urgent", but nothing calls it yet.
- **So a required release is a manifest whose `revoked` lists every older version that must move up.** It's signed like everything else, offline, by the owner. It's capped by `MAX_MANIFEST_BYTES`; dozens of versions fit. The release script (dev-updater, `manifest-body.mjs`) gets an option `--require-from <version>` that fills in every published version below it.

## 2. What the app does when its running version is revoked

### Core (dev-updater, `core/updater` + `core/api`)

- After every accepted check, `required = policy.is_revoked(installed)`. It's also read at core start from `policy.json`, so a restart doesn't forget.
- **API:**
  - `getAppInfo` gains `updateRequired: { version: string | null } | null`, where `version` is the newer version on offer, if any;
  - a new event `update.required { version }` fires when it turns on.
- **While required:** the core downloads the newest version at once (it doesn't wait for the 6-hour timer), and `checkForUpdate` keeps working.
- **RU1 (SL condition): the core signs nothing on its own while required.** Main's gate only stops the page, but an outdated core would still re-key and sign in background sync, which is the very risk behind B7-k. So while `updateRequired` is set, the core:
  - makes **no automatic signed action**: no re-key or key rotation, no secret rotation, no profile or cap posts, no restore re-joins, no leave sends, no relay serving;
  - stays **offline for sync**: no dialling, gossip or relaying. **Update checks and downloads are its only network traffic;**
  - still answers the page's read-only commands from local data.
  - **Test:** a required core that receives a join, or a member change that would trigger a rotation, signs and sends nothing.

### Desktop (voice-shell)

- **Main is the gate, not the page.** When `updateRequired` is set at start or arrives as `update.required`, the app goes **local read-only plus update** (TL amendment 1: never lock people out of their own data when the update can't be fetched yet):
  1. **Allowed:** reading what's on this computer, meaning servers, channels, members, `getMessages`, search, profile and settings reads, `exportDiagnostics` and any data export, the G-78 lock commands, and the update commands (`getAppInfo`, `checkForUpdate`, `restartToUpdate`).
  2. **Refused** with `{ error: { code: 'update-required' } }`: everything that writes to or talks to the network. That's sending, editing, deleting and reacting, joining and leaving, creating, invites, calls (`joinCall`, voice frames), signed actions (roles, kicks, server settings), device linking, and settings that sign or publish.
  3. **The list is an allow-list** (`commands.js` gains a `readOnly` flag per command, reviewed by the SL), so a new command is refused until someone marks it read-only.
  4. **The core stops sync** while required (no dial, no gossip, no relay), so the network side matches the gate. Asking for a manifest is the only outbound traffic.
  5. Notifications, the badge, push-to-talk and links are held.
  6. It holds for the rest of the process. A reload can't leave it; only a restart into a non-revoked version clears it.
- **During a call:** the gate waits for the call to end (as G-78 path B waits), **for at most 30 minutes** (SL). After that, the call ends and the gate applies.
  - Until then, the call bar shows a one-line notice: "An update is required. It applies when the call ends." After 25 minutes it changes to "…in 5 minutes."
  - The core's RU1 rules apply **at once**, even during the call. Only the call's own media keeps flowing until it ends.
- **The app lock comes first:** a locked app shows the lock screen; after unlock, the required screen.
- **Never bypassable:** the page can't send anything but the four commands, and has no route out of the screen. The window can still close, which quits the app. There's no "later" and no dismiss.

### What people see (dev-ui or voice-shell)

- **The app stays open on its content, read-only.** A banner that can't be closed sits above everything, and the composer, call buttons and every action are disabled, with the reason on hover or focus. The banner reads **"An update is required"** plus one line: **"Until you update, you can read what's on this computer, but not send or connect."**
- **The banner carries the states below, with Update and Retry,** instead of a separate screen. There's no "later" and no dismiss.
- **Update** (primary): it's ready once downloaded; while downloading, it shows progress or "Downloading…". It calls `restartToUpdate`, which relaunches through the launcher (existing B8 flow).
- **Quit:** closes the app.
- **States:**
  - **downloading;**
  - **ready;**
  - **offline:** "Can't reach the update server" plus Try again;
  - **check your clock** (`check-clock`);
  - **not available yet:** revoked, but no newer artifact for this platform. The screen says so, keeps checking every 15 min, and Quit stays.
- The version and "What's new" (signed notes) can show in the banner's details.

### A bad required release (TL amendment 2)

- **`revoked` only grows** on every client (`ClientPolicy`), so a later manifest can't take a revocation back. **The way out of a bad required release is a newer good one:** publish N+2 (fixed). Every client, required or not, updates to it, and `updateRequired` clears because N+2 isn't revoked.
- **No restart loop:**
  - If N+1 fails its trial, the launcher rolls back. It can't roll back into a revoked version, so it starts the revoked version only to fetch a fix (`RecoveryRequired`, existing).
  - The core then **doesn't re-stage the same failed N+1**: the launcher's trial-failure record marks N+1 as failed, and the core skips a failed version until a newer one is offered.
  - The user stays read-only with "Update not available yet" until N+2 is out. The app is never stuck restarting.
- **Runbook** (`docs/release/`, dev-updater): how to publish a required release (`--require-from`), and if it's bad, how to ship N+2 at once. "Removing the revocation" isn't a fix, and the runbook says why.
- **Tests:**
  - a required install whose trial fails ends on the revoked version, read-only, with no second attempt at the same version;
  - offering N+2 then clears `updateRequired` after one restart.

## 3. Versions that predate this feature

- A client from **before** this ships has no screen. It reads the manifest, sees its version revoked, and updates through the **normal** path (the `update.ready` banner), but nothing forces it.
- **So the first release with this feature (call it N) can't itself be required for older clients.** It can only be pushed hard by release notes and the network rules below.
  - K2 and T17 **ship in N+1 or later**, which is required for everything below N+1.
  - Anything older than N updates normally and is then blocked by N's code if it stops halfway.
- **Network-side refusal** of clients that are too old (peers refusing records from old versions) is the backstop for pre-N clients. That's a protocol decision for the TL and dev-sync, **out of this note's scope**; K2 and T17 may already behave that way.

## 4. Security notes (for the SL)

- **Who can force an update:** only a signed manifest (the update root key, offline, held by the owner). Revoking versions is the existing trust; nothing new is trusted.
- **Abuse:**
  - a stolen update key could already push any release;
  - revoking everything **without** offering a newer artifact strands users on "not available yet". That's a signed act, and the screen says what happened, which is better than a silent failure. GAP-12's root rotation caps apply unchanged.
- **Replay:** `revoked` only grows (`ClientPolicy`), and an expired manifest is refused. Replaying an old manifest can't un-require.
- **The gate is in main,** with a read-only allow-list (`commands.js` `readOnly`, default refused). The renderer can't send, join, call or sign while required, and the core's sync is stopped too.
- **Rollback:** the launcher never rolls back into a revoked version (existing); if the new version fails its trial, the user stays on "required" with a fresh download.
- **Diagnostics stay** (`exportDiagnostics`), so a stuck user can still send a report.

## 5. Tests

- **updater:** `is_revoked(installed)` → required after a check and after a restart, and a revoked range from `--require-from`.
- **api:** `getAppInfo.updateRequired`, `update.required` once, an immediate download.
- **desktop unit:** every command in `commands.js` is classified, and a test fails on an unclassified one. Under required, the read-only ones pass and the rest are refused. The lock-then-required and in-call-then-required orders.
- **desktop e2e** (fake core):
  - a revoked start keeps reads working (`listServers`, `getMessages`);
  - writes and the network are refused (`sendMessage`, `joinServer`, `joinCall`, a voice frame);
  - Update calls `restartToUpdate`;
  - a reload stays read-only;
  - in a call, the gate waits for leaveCall.
- **UI:** the screen's states and strings in he and en, and AA contrast.

## 6. Order and size

1. dev-updater: `--require-from` in the release script, plus the core's `updateRequired` and event (S).
2. voice-shell: main's gate and reload, plus tests (S).
3. The screen (S, dev-ui or voice-shell), with UX strings.
4. **Release N** carries 1–3. **K2 and T17 ship in N+1**, with `--require-from N+1`.

**Owner decision needed:** whether B7-k K2 (and T17) are required updates at all (the board already lists it as the owner's call). This note gives the mechanism either way.
