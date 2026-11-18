# G-78 v1.1: unlock with Windows Hello (and the OS method elsewhere)

- **Status:** proposal (spike plan). No code until the SL and TL approve this note.
- **Builds on:** `docs/design/app-lock.md` (#466), which made Windows Hello a v1.1 spike: "built from source, signed, licence-scanned". The passcode lock (v1) is #473, #476, #482 and #513.
- **Owner:** dev-voice-shell (desktop); dev-identity (core verification, if the chosen path needs it); the UI is the existing lock screen's "Unlock with {method}" button (spec §1, `lock.os`).

## 1. Goal and non-goals

- **Goal:** on a computer where the app lock is on, unlock with the OS's own user check (face, fingerprint or the Windows PIN) instead of typing the passcode. It's a convenience, offered only after a passcode is set.
- **Not a goal:**
  - replacing the passcode. It stays the fallback, and "forgot" stays the 12 words;
  - stronger protection than the passcode. Anyone at the unlocked OS session can pass the OS check; so can anyone who knows the passcode;
  - disk encryption (the lock still doesn't encrypt anything; the disclaimer stays).

## 2. Options

### W1: WebAuthn platform authenticator, in Electron (recommended to spike first)

Chromium in Electron implements WebAuthn with the OS authenticator. On Windows that's Windows Hello through `webauthn.dll`, which reportedly works with no extra setup ([Clerk: passkeys for Electron](https://clerk.com/docs/reference/electron/passkeys.md); [Teams for Linux research](https://ismaelmartinez.github.io/teams-for-linux/development/research/webauthn-fido2-implementation-plan)). macOS Touch ID needs `app.configureWebAuthn()` in recent Electron versions ([Electron docs mirror](https://ayakael.net/mirrors/electron/src/tag/v41.5.0/docs)).

- **Flow:**
  1. **Enrol** (Settings → Privacy → App lock, unlocked, after the passcode):
     - main asks the core for a random challenge;
     - the page calls `navigator.credentials.create({ publicKey: { authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, … } })`;
     - main passes the attestation's public key and credential ID to the core, which stores them with the lock settings (§4).
  2. **Unlock:**
     - the lock screen asks main for a challenge (main gets it from the core);
     - the page calls `navigator.credentials.get({ publicKey: { userVerification: 'required', allowCredentials: [id] } })`;
     - main hands the assertion to the core's `verifyAppLockOs`, which checks it like `verifyAppLock` (the same attempt counter) and answers `ok` or `wrong`. **Main stays the gate**, as for the passcode.
- **What the core verifies:**
  - the signature (ES256, P-256 ECDSA) over `authenticatorData ‖ SHA-256(clientDataJSON)` with the stored public key;
  - `clientDataJSON.challenge` equals the one it issued (single use, 60 s);
  - `type` is `webauthn.get`;
  - the UV flag is set;
  - the origin and RP ID hash are ours.
- **No new crates.** `ring` already verifies `ECDSA_P256_SHA256_ASN1` and is already in the tree (TL to confirm the version in use). The CBOR attestation is parsed only for the COSE key at enrolment; a minimal hand parser, size-capped, with fuzz tests. Alternatively, use `"attestation": "none"` with `getPublicKey()` (SPKI DER) on the renderer side, so no CBOR is needed at all. **The spike decides which.**
- **The open question, and the spike's main job: the origin.** Our page is `app://mvs`. WebAuthn needs a secure context and an RP ID that's a valid domain matching the origin's effective domain. Chromium may refuse a custom scheme. The spike tries, in order:
  1. `rp.id: 'mvs'` from `app://mvs` (the scheme is registered as secure and standard, #B1-1);
  2. Electron's WebAuthn configuration hooks (`app.configureWebAuthn`, if it exists for Windows in our Electron version);
  3. if both fail, W1 is out (we will **not** move the page to an https origin for this).
- **Licences:** nothing new (Chromium and Electron are already shipped). This answers #466's "built from source, signed, licence-scanned" condition.

### W2: Windows' `UserConsentVerifier` in the core

The core calls `Windows.Security.Credentials.UI.UserConsentVerifier.RequestVerificationAsync` and gets back a yes or no.

- **For:** no origin question, and no key to store.
- **Against:**
  - a **new crate** (`windows`, MIT/Apache) in the core, which the "no duplicate or new crypto crates" rule doesn't forbid but which adds a large dependency and needs SL and licence review;
  - the answer is a bare **boolean from the OS**, with no signature: anything that can patch or hook the core's process could fake it. That's the same trust as the passcode check, which also runs in the core, so no real loss. But W1's signed assertion is the stronger shape;
  - the prompt is owned by the core process, which has no window. It needs the window handle passed in (`IUserConsentVerifierInterop::RequestVerificationForWindowAsync`), or it appears behind the app.
- **Use only if W1's origin question fails.**

### W3: Linux and macOS

- **macOS:** we don't ship macOS today. If we do, W1 with Touch ID (`app.configureWebAuthn`, Keychain access group) or Electron's built-in `systemPreferences.promptTouchID()`, which is boolean like W2.
- **Linux:** there's no common OS user check that works across desktops. fprintd and polkit agents vary by distribution and aren't always present. **Passcode only**: the settings row and the lock-screen button don't appear. This is the documented fallback; nothing to build.
- **Everywhere:** the button only appears when enrolment succeeded on this computer and `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` is true at that moment. If Hello is removed later, the passcode remains.

## 3. Security notes (for the SL)

- **Same gate, same counter:** an OS unlock goes through main → core, like the passcode. A failed or cancelled assertion is `wrong` against the same attempt counter; cancelling the OS prompt costs nothing.
- **Challenge:** 32 random bytes from the core, single use, 60 s, bound to the request. A replayed assertion fails.
- **The page holds nothing secret:** the private key never leaves the OS authenticator (TPM-backed on most Windows PCs). The page passes opaque blobs; main size-caps them (assertion ≤ 4 KiB, attestation ≤ 8 KiB) and never logs them.
- **No user handle, no names:** `user.id` is 16 random bytes made at enrolment. `user.name` and `displayName` are "MVS", never the account's name. `residentKey: 'discouraged'`, so nothing is listed in the OS passkey manager under a person's name.
- **Path B (locked in a call):** the same, since the overlay is the same lock screen.
- **Turning it off:** the settings row removes it after the passcode (as for other changes, §4 of the spec); the core deletes the stored key. "Forgot" (12 words) clears the passcode and the OS method together.
- **Residual:** anyone who can pass the OS user check at this computer can unlock MVS. That's the documented point of the feature, said in the settings row.

## 4. Contract sketch (only if the spike passes; final in the PR)

- **Core (dev-identity):**
  - `getAppLock` gains `os: { enrolled: bool }`;
  - `appLockChallenge()` returns `{ challenge }`;
  - `enrolAppLockOs({ current, credentialId, publicKey })`, where `current` is the passcode (the same rule as setAppLock);
  - `verifyAppLockOs({ challenge, credentialId, authenticatorData, clientDataJSON, signature })` returns `AppLockAnswer`;
  - `clearAppLockOs({ current })`.
  - All main-only, off the `core:invoke` allow-list (as for the passcode, #513).
- **Desktop:** `lock.os.*` IPCs on the same rules as `lock:set` (fromUs, unlocked for enrolment, one at a time). Unlock goes through `lock:unlock({ os: assertion })`.
- **UI:** the settings row and the lock-screen button (spec §1 and §4, strings exist: `lock.os`).

## 5. The spike (≤ 1 day, on the owner's Windows machine in a throwaway profile, never a packaged build)

1. In a checkout Electron with our `app://mvs` scheme setup, call `isUserVerifyingPlatformAuthenticatorAvailable()`, then `credentials.create` and `credentials.get` with `rp.id: 'mvs'`. Record: does the Hello prompt appear, and do the calls succeed or throw (which error)?
2. If step 1 fails on the origin: try Electron's WebAuthn configuration for Windows, if our Electron has one. Record the result.
3. If W1 works: verify an assertion in a scratch Rust test with `ring`, from the SPKI key (`getPublicKey()`), with no CBOR.
4. Write the result in this note. **Go:** W1 works with no origin change and `ring` verifies it. **No-go:** the origin is refused. W2 then comes back to the SL and TL as its own proposal.

The spike touches no shipped code and needs no Docker. Its scratch code stays out of the repo except this note's results.

## 6. Size

If W1 passes: core S (dev-identity), desktop S, UI S. If only W2 works: core M (the new crate and window handle), plus SL and licence review first.
