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
- **No other core command is refused** by the core itself: main is the gate (below), as for the app lock. The network side is unchanged.

### Desktop (voice-shell)

- **Main is the gate, not the page** (as with the G-78 lock, path A). When `updateRequired` is set at start or arrives as `update.required`, main:
  1. **reloads the page into `?update-required`**, which mounts no store, shows no content and starts no sync;
  2. **narrows `core:invoke`** to `getAppInfo`, `checkForUpdate`, `restartToUpdate` and `exportDiagnostics`. Everything else answers `{ error: { code: 'update-required' } }`, including joins, sends and calls. Notifications, the badge, push-to-talk and links are held, as under the lock;
  3. keeps this for the rest of the process. A new page or a reload can't leave it; only a restart into a non-revoked version clears it.
- **During a call:** the block waits for the call to end (as G-78 path B waits). Until then, the call bar shows a one-line notice ("An update is required. It will install when the call ends."). Leaving the call, or the call ending, reloads into the screen.
- **The app lock comes first:** a locked app shows the lock screen; after unlock, the required screen.
- **Never bypassable:** the page can't send anything but the four commands, and has no route out of the screen. The window can still close, which quits the app. There's no "later" and no dismiss.

### The screen (`?update-required`, dev-ui or voice-shell)

- The logo and **"An update is required"**, plus one line: **"This version of MVS can no longer be used. Update to keep using it."**
- **Update** (primary): it's ready once downloaded; while downloading, it shows progress or "Downloading…". It calls `restartToUpdate`, which relaunches through the launcher (existing B8 flow).
- **Quit:** closes the app.
- **States:**
  - **downloading;**
  - **ready;**
  - **offline:** "Can't reach the update server" plus Try again;
  - **check your clock** (`check-clock`);
  - **not available yet:** revoked, but no newer artifact for this platform. The screen says so, keeps checking every 15 min, and Quit stays.
- **Nothing personal** on it (as the lock screen): no servers, names or counts. The version and "What's new" (signed notes) can show.

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
- **The gate is in main,** with a narrowed allow-list. The renderer can't reach sync, sends or joins while required.
- **Rollback:** the launcher never rolls back into a revoked version (existing); if the new version fails its trial, the user stays on "required" with a fresh download.
- **Diagnostics stay** (`exportDiagnostics`), so a stuck user can still send a report.

## 5. Tests

- **updater:** `is_revoked(installed)` → required after a check and after a restart, and a revoked range from `--require-from`.
- **api:** `getAppInfo.updateRequired`, `update.required` once, an immediate download.
- **desktop unit:** the narrowed allow-list (the four allowed, a sample of others refused), and the lock-then-required and in-call-then-required orders.
- **desktop e2e** (fake core):
  - a revoked start reloads into `?update-required`;
  - `listServers` and `sendMessage` are refused;
  - Update calls `restartToUpdate`;
  - a reload stays on the screen;
  - in a call, the block waits for leaveCall.
- **UI:** the screen's states and strings in he and en, and AA contrast.

## 6. Order and size

1. dev-updater: `--require-from` in the release script, plus the core's `updateRequired` and event (S).
2. voice-shell: main's gate and reload, plus tests (S).
3. The screen (S, dev-ui or voice-shell), with UX strings.
4. **Release N** carries 1–3. **K2 and T17 ship in N+1**, with `--require-from N+1`.

**Owner decision needed:** whether B7-k K2 (and T17) are required updates at all (the board already lists it as the owner's call). This note gives the mechanism either way.
