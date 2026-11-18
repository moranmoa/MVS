# App lock, G-78 (design note, for the Security Lead and Tech Lead)

**Status:** design only, no code.
- **Security Lead:** APPROVED, with conditions (§8).
- **Tech Lead:** APPROVED, with the two-path design for a lock during a call (§5).
- **Re-verdict:** both leads are asked to re-verdict this head.

**Background:**
- G-78 is in `docs/ux/GAPS.md` §1.7. It comes from spec question 6: "recovery words + OS keychain + an optional app lock".
- The threat model has the app lock under TB1 and GAP-11.

**What it is:** an optional lock in front of the MVS window, asked for:
- when MVS opens;
- after N minutes idle;
- when the OS locks or sleeps;
- with "Lock now".

**What it isn't:** encryption of the identity or the store. That's a separate, stronger lock (§7).

## 1. What it protects, and what it doesn't

**Protects against** someone who sits at my **unlocked, signed-in computer**: a family PC, an office desk I walked away from, a laptop left open. With the lock on, that person can't:
- read my servers, channels, messages, members or DMs;
- send, react, join, leave, or change settings as me;
- see my 12 words or my identity code;
- see message text in notifications, or the unread count on the taskbar.

**Doesn't protect against:**
- **Anyone with my OS account's files or a process running as me.** The keychain stays unlocked for my OS session. The SQLite store is plaintext (GAP-11). The lock settings could be edited out of the profile. This is the TB1 line: the lock narrows "anyone at the keyboard", not "anything running as me".
- **The core working in the background.** Sync, relaying, keeping my servers' data, voice-room presence and receiving messages all go on while locked. Locking doesn't sign me out or take me offline.
- **A stolen, powered-off laptop.** That needs disk encryption (BitLocker, FileVault, LUKS) plus GAP-11. The UI should say so in one line when the lock is turned on.
- **Content behind a locked call.** During a call, MVS keeps the call's audio running behind the lock. The page's earlier content stays in memory, hidden, until the call ends (§5 path B). The setting shows this as one more line.

## 2. How to unlock

| Method | Windows | macOS | Linux | v1? |
| --- | --- | --- | --- | --- |
| **App passcode** (a PIN or passphrase set in MVS) | yes | yes | yes | **yes, everywhere** |
| **Touch ID** | – | `systemPreferences.promptTouchID`, built into Electron | – | yes, once there's a macOS build |
| **Windows Hello** (face, fingerprint or PIN) | needs a native module (WinRT `UserConsentVerifier`); Electron has no API for it | – | – | **no, v1.1 after a spike** |
| OS password prompt | needs a native module (`CredUIPromptForWindowsCredentials`) | via Touch ID's fallback | polkit, not a fit for a desktop app | no |

**Why Windows Hello isn't in v1:**
- It needs a native module. I didn't confirm a maintained, permissively licensed one, so the spike starts by checking for one.
- If there isn't one, it means our own small N-API addon:
  - about 50 lines of C++/WinRT;
  - a native build in CI, signed with the app;
  - a licence check of its dependencies.
- Hello's consent check is only a yes/no ("the user is present"). It releases no secret. It's a UI gate, the same strength as the passcode, but more convenient.
- **Proposal:** v1 ships the passcode; a spike (about S) for Windows Hello follows.

**An OS prompt needs a passcode too.** "Use Windows Hello / Touch ID" can only be turned on after a passcode is set. That way there's always a way in when the sensor fails, someone else's face is enrolled, or the OS feature is off.

## 3. The passcode

- **Format:** 4–12 digits, or a passphrase of 6–64 characters, normalised to NFC. The UI suggests 6+ digits.
- **Stored by the core,** never by the page or main. The core keeps an Argon2id verifier in its DB, at identity's `LockParams::MIN` (19 MiB, t=2): `{ v: 1, salt, params, hash }`. It reuses identity's Argon2id, so there's no new crypto crate. The page never stores it, and main never sees more than the attempt it forwards.
- **Wrong attempts:**
  - The 5th wrong one in a row starts a delay: 30 s, doubling each time, up to 15 min.
  - The counter and "not before" time are kept in the core DB, so restarting MVS doesn't reset them.
  - The lock **never wipes anything**: wiping would lose the identity.
- **Forgot the passcode:** "Forgot? Use your 12 words" clears the lock after the words check out (the existing restore check against the stored identity). Without the words, the only way out is signing out (#304 path) and restoring.
- **Not the vault passphrase.** A short PIN that's rate-limited online is fine for this lock. It would be far too weak as the offline key for the identity (§7), so the two are never the same secret.

## 4. When it locks

| Trigger | How (main process) | Default |
| --- | --- | --- |
| MVS starts | Locked from the first frame, before the page gets any data | always, when the lock is on |
| Idle N minutes | `powerMonitor.getSystemIdleTime()` checked every 15 s. This is system-wide idle: typing in another app counts as activity | N = 5; choices 1, 5, 15, 30, 60 |
| OS locks or sleeps | `powerMonitor` `lock-screen` and `suspend` | on |
| Lock now | A "Lock now" item in the user menu, plus a shortcut. Ctrl+L (⌘L) is the candidate, but it still has to be checked against the app's existing shortcuts and the composer (TL). If it clashes, use Ctrl+Shift+L. It's a window shortcut, never a global one | – |

- **Never during a call by idle.** Idle time doesn't lock while I'm in a call, because people listen without touching anything.
- **Manual lock or OS lock during a call: the call goes on, with my mic off** (the manager's decision). This is path B in §5. Main mutes me in the core with `setMuted(true)`, and the page turns the mic track off. While locked:
  - unmuting (`setMuted(false)`) is refused;
  - push-to-talk and the global mute toggle are off;
  - any open mic test (`mic:test`) is closed and refused.

  The lock overlay shows "in a call" with a **Leave** button.
- Changing the lock settings, or turning the lock off, needs the current passcode (or OS auth).

## 5. Enforcement: in main, not in the page

A lock that the page enforces is only as good as the page's state. So **main** owns the lock state. There are two paths, because the voice engine lives in the renderer and a reload would end a call.

**Path A, locked when not in a call: reload.**

1. **The page is reloaded into the lock screen** with `?locked`. Its in-memory store (messages, members) is thrown away with the old renderer state, not hidden behind an overlay.
2. **`core:invoke` refuses** every command except a short allow-list:
   - `getAppInfo`, for the version on the lock screen;
   - the unlock and forgot-passcode commands.

   Everything else answers `{ error: { code: 'locked' } }`. This lives in main's handler, so it doesn't depend on the page's code. `exportDiagnostics` stays off the list (SL and TL).
3. **Core events aren't forwarded** to the page, except `core.status` and the new `lock.state`. **Only the latest** `link.open` (an mvs:// invite) is held, and it's delivered after unlock. A second launch of MVS while locked (`second-instance`) focuses the lock screen, and its link is held the same way.

**Path B, locked during a call: overlay, no reload.**

- **The page stays loaded** so the call's audio keeps running. Main sends `lock.state { locked: true, inCall: true }`.
- **The page hides the app:** it sets `inert` and `aria-hidden="true"` on the app root, and shows a focus-trapped overlay with:
  - "in a call" and the call's member count, with no names;
  - **Leave**;
  - unlock.
- **Main mutes me in the core** with `setMuted(true)`, and the page turns the mic track off.
- **`core:invoke` allows only:**
  - the lock commands;
  - `leaveCall`;
  - `setMuted` with `true` only. `setMuted(false)` is refused;
  - `sendSignal`, for the engine's WebRTC signalling.
- **Forwarded events:** only `call.signal`, `call.state` (in full, because the engine needs it), `core.status` and `lock.state`. Push-to-talk, the global toggle and `mic:test` are off.
- **When the call ends while locked**, by Leave or by the others, main switches to path A and reloads into `?locked`, which drops the in-memory content.
- **On unlock**, the page removes `inert` and re-syncs its store from the core, since it got no events while locked. The mic stays muted until I unmute.
- **Residual:** while a call goes on behind the lock, the page's earlier content (messages, members) **stays in renderer memory, hidden but not wiped**, until the call ends. This is recorded in `core/api/CONFORMANCE.md` under TB1. The §1 disclaimer gets the line "During a call, MVS keeps the call's audio running behind the lock."
- **e2e:** behind the overlay, Tab, Ctrl+F and the reload/DevTools shortcuts do nothing. `setMuted(false)` and any other command are refused.

**On both paths:**
1. **Notifications:** `notify:show` is refused while locked, and the page can't produce any anyway (it gets no message events). Main shows **nothing**: no generic "new message" toast either, because even that reveals activity (SL: Q2).
2. **Taskbar badge** (G-62): cleared on lock (`badge.set(0)`), and `badge:set` is refused until unlock.
3. **Push-to-talk** (G-74): `pushToTalk.reset()` on lock. `ptt:set` and the key watch are off, and the global mute shortcut is unregistered.
4. **Clipboard and window:** `clipboard:write` is refused. The window title stays "MVS", with no server or channel name.

**Fail closed at start.** Until `getAppLock` answers, the page loads as a neutral **"Loading…"** screen (`?locked=pending`), with no data and the same IPC gating as locked. This satisfies both the TL's "Loading…" and the SL's "fail closed":
- **Lock off:** the normal load follows.
- **Lock on:** the lock screen follows.
- **No answer in 10 s,** or the core is down: the lock screen follows.

The "core unavailable" screen (T8-01) stays reachable from it, because it shows no user data.

**Unlocking:**
- The page sends `lock:unlock { passcode }` (or `{ os: true }`, which starts the OS prompt in main).
- Main forwards the passcode to the core's `verifyAppLock` and gets `ok`, `wrong { retryAfter? }` or `rate-limited { retryAfter }`.
- On `ok`, main sets the state to unlocked and sends any `link.open` it held. What else happens depends on the path:
  - **Path A:** main reloads the page normally.
  - **Path B:** there's no reload. Main sends `lock.state { locked: false }`, and the page removes `inert` and re-syncs its store from the core.
- The passcode is never logged, and main keeps no copy after the call.

## 6. New interfaces (for review)

**Shell (main/preload), all behind `fromUs`:**
- **`lock:state` → `{ enabled, locked, method: 'passcode'|'os', osAvailable, retryAfter? }`.** The same object also arrives as the `lock.state` event.
- **`lock:unlock`:**
  - takes `{ passcode: string ≤ 64 }` or `{ os: true }`;
  - returns `'ok' | 'wrong' | 'rate-limited' | 'os-cancelled' | 'invalid'`.
- **`lock:now`** locks at once.

**Core:**
- **`getAppLock`**, which returns `{ enabled, method, idleMinutes, lockOnSleep, retryAfter? }`. It's read by main at start and never holds the verifier.
- **`setAppLock { current?, passcode, method, idleMinutes, lockOnSleep }`**. A change needs `current` when the lock is already on.
- **`clearAppLock { current }`**, and **`clearAppLockWithWords { words }`** for "forgot".
- **`verifyAppLock { passcode }`**.

Main handles `getAppLock` and `verifyAppLock` itself, and they aren't on the page's allow-list. The page reaches the set and clear commands only through the normal allow-list while unlocked.

**UI (dev-ui):**
- the lock screen (`?locked`);
- Settings → Privacy → "App lock" (passcode setup, method, idle time, lock on sleep, and the one-line §1 disclaimer);
- "Lock now" in the user menu.

UX writes the screen spec. Strings go in he+en, like the rest.

## 7. The stronger lock, later (GAP-11), so the two don't get confused

`core/identity` already has a **vault lock**: `Vault::set_app_lock` and `unlock`, which encrypt the keychain entry with Argon2id(passphrase). `core/api` doesn't use it yet. Turning it on means:
- The core can't open the identity until the passphrase is typed in on start, so no sync or relaying happens before then.
- It only really protects at rest together with an encrypted store (GAP-11: SQLCipher or per-row AEAD under identity's `local-storage/key`) and a peer key with owner-only permissions.

That's the "stolen powered-off laptop" protection, and the design of the G-78 v1 lock doesn't block it:
- It would be offered as a separate, later setting, "Encrypt on this computer", with a strong passphrase. It would never be the PIN.
- When both are on, the vault passphrase entered at start also unlocks the screen lock. One prompt, not two.

## 8. Decisions (SL APPROVE on 6afd790; TL APPROVE on c80f785; manager's call on Q1)

**Answers to the open questions:**
1. **Locking during a call:** **keep the call**, with my mic off in the core and on the track, and Leave on the overlay. This was the manager's decision, matching the SL's answer. The TL's two-path design makes it work: path A reloads when not in a call; path B uses an inert overlay with no reload during a call (§5). Idle still never locks during a call.
2. **Notifications while locked:** nothing at all.
3. **Windows Hello:** the v1.1 spike is OK, after the passcode ships, under these conditions:
   - consent only;
   - built from source in CI and signed with the app;
   - licence-scanned;
   - no npm prebuilt binaries.
4. **Idle:** system-wide.
5. **Start-up:** a neutral "Loading…" screen with no data (the TL's answer). It becomes the lock screen if the lock is on, or if the core gives no answer within 10 s, which keeps the SL's fail-closed rule (§5).

**Conditions for the build:**
1. **One attempt counter.** One persistent counter and backoff covers `verifyAppLock` and the `current` checks in `setAppLock` and `clearAppLock`. The 12-words path (`clearAppLockWithWords`) is rate-limited too.
2. **Locked allow-list:** `exportDiagnostics` is left off, because nobody has shown its output to be free of names, IDs and content (SL and TL). `leaveCall` is allowed.
3. **Mic test and links:** `mic:test` is refused while locked, and an open test session is closed on lock. Only the latest `link.open` is held.
4. **No way around the lock screen:**
   - In packaged builds, DevTools, the reload menu items and their accelerators are off.
   - The inspect and RunAsNode fuses are off; they already are, see `desktop/build/fuses.js`.
   - An e2e check confirms these shortcuts do nothing while locked.
5. **The passcode stays out of logs and reports.** It never reaches IPC logging, file logs or crash reports. Main checks its length and normalises it to NFC before forwarding.
6. **Docs:** the §1 disclaimer goes in the UI, including the line about the call. The core's CONFORMANCE file gets a note on TB1 and on path B's residual: content stays in renderer memory until the call ends.

## 9. Size

- **Shell:** M. Lock state, the gating in main's handlers, powerMonitor, and the reload into `?locked`.
- **Core:** S. Four commands, the Argon2id verifier and the attempt counter in the DB.
- **UI:** M. The lock screen and the settings.
- **Windows Hello spike:** S.

The pieces are separate PRs:
1. core;
2. shell, with a fake core in e2e: everything refused while locked, unlock, rate limit, a reload drops state, idle and sleep triggers with powerMonitor stubbed;
3. UI.
