# Automatic member recovery (design note, for the Security Lead)

**Status:** design only, no code. It's the backlog item at the end of `device-link-slice.md`. It follows the Security Lead's "safe automatic variant" in `sec-lead-member-verified-login.md` and the rule that members never check codes, never learn the email, and never hold OPRF shares.

**What it is:**
- An **extra, opt-in** way to recover the account when every device and the 12 words are lost.
- It never replaces the words. It never signs in with a password. It isn't the email OPRF set of #365.
- Recovery needs **all three**:
  1. the code sent to my email (by the operator-run mailer);
  2. **3 of 5** recovery shares, held by co-members' apps under 5 **different server owners**;
  3. a **72-hour hold** with no cancel from any of my devices.

## 1. Keys and shares

When I turn it on, one of my signed-in devices makes:
- **`s`**, 32 random bytes, the member part. It's split **3-of-5** with Shamir over GF(2^8), byte by byte, so share *i* is `(x_i, y_i[32])` with `x_i` in 1..=5. No two holders get the same `x`. Fewer than 3 shares reveal nothing about `s`.
- **`r_m`**, 32 random bytes, the mailer part. It's sent to the mailer **sealed to the mailer's public key**, which is pinned in the app.
- **`h`**, a random 32-byte **recovery handle**. It names this recovery everywhere: shares, the mailer record, the rendezvous, notices. It's unlinkable to my identity key and my email.
- **`k_mr = HKDF-SHA256(s ‖ r_m, info "mvs/member-recovery/v1" ‖ h)`**.
- **The envelope:** `XChaCha20-Poly1305(k_mr, { seed, profile, birthDate, birthDateTrusted, country, v })`. It's stored at the backup holders under `tag_mr = derive_key("mvs/member-recovery-tag/v1", h)`, with the highest `v` kept, like `/mvs/backup/1`.

So the mailer alone has `r_m` but no `s`, and k colluding holders have `s` but no `r_m`. Each side needs the other.

**What a holder stores** is a share record, signed by my backup write key `w`, so a holder can check later instructions came from the account:
```
{ v: 1, h, version, x, y (32 bytes), w_pub, created, sig_w }
```
- Holders keep it in their core database, per handle. It's at most 1 record per handle and at most 64 handles per holder, so storage is bounded. The newest `version` wins.
- `y` is in the clear at the holder; the threshold is the protection. A holder learns my handle `h`, but not my identity, email or seed.

## 2. Holder selection (the anti-Sybil rule)

**Candidates:** members who share a server with me and are:
- **adults:** an accepted 18+ age claim in that server (B7);
- **current:** not kicked, not left, the server not closed;
- **not blocked** by me, and not me on another device;
- **seen recently:** a presence or post in the last 14 days;
- reached through a server where **at least 2 other members** besides me exist. A server where I'm alone with one other person doesn't count.

**Owner groups:** each candidate counts under the **owner of the server it's picked through**. If a candidate is picked through several servers, the core chooses one.

**The rule: no two holders share an owner group.** Then one server owner, even one who made many sock-puppet servers and accounts under one key, supplies at most **one** holder. Taking over needs 3 independent owners colluding, plus the inbox, plus 72 hours with no cancel.
- A server I own is its own owner group (me). One of my own servers' members can hold a share, but only one.
- Owner identity is the server's genesis key. A Sybil attacker with many owner keys is the residual risk (§6).

**Greedy pick:**
1. Group the candidates by owner.
2. From each group, take the candidate with the longest shared membership, breaking ties by most recently seen.
3. Take the 5 best groups, ordered by how long I've been in that owner's server.

**Too few groups:**
- 5 groups or more: 3-of-5.
- Exactly 3 or 4 groups: **2-of-3**, marked "weak" in the UI. This needs the Security Lead's verdict (Q1).
- Fewer than 3: the feature is **unavailable**. The UI explains: "Needs members from at least 3 different communities."

## 3. Re-sharing (holders come and go)

On every sync round, a signed-in device of mine checks the current holders. **Any** of these triggers a re-share:
- a holder left, was kicked, or deleted their account;
- the server they were picked through closed;
- a holder hasn't been seen for 30 days;
- two holders now fall under the same owner (an ownership transfer);
- a better-spread set exists while I'm on 2-of-3.

**A re-share is a fresh split, not a reshuffle:**
1. New `s'`.
2. New `k_mr`.
3. A new envelope with `version + 1`. Holders of the backup store keep only the newest, so the old envelope is gone.
4. New shares to the new set.
5. A `w`-signed **delete** `{ h, below_version }` to the old holders, best effort.

Old shares can never combine into the new key, so people who drift away don't pile up valid shares over time. `r_m` and `h` stay the same; the mailer record doesn't change.

**Two of my devices re-sharing at once:**
- the envelope's `version` is the lock: the higher version wins at the holders;
- a device that loses the race re-reads and stops.

## 4. Recovery, the 72-hour hold, the notice and the cancel

**At the mailer** (the #365 mailer, devops), keyed by `tag_m = HMAC(mailer_key, normalise(email))`, it stores `{ h, sealed r_m, recovery_enabled_at }`. The address isn't kept. The client sends it with each request, as in #365 §7.

**On a new device:**
1. The user enters the email.
2. The mailer sends a one-time code. Its answer is the same whether or not the account exists.
3. The user enters the code. The mailer checks it and **starts a 72-hour hold** for `h`.
4. During the hold, the mailer publishes **pending(h, until)**, and so does every holder it can reach, as in #365 §10. Each of my devices polls by `h`, which it knows, and shows: "Someone is recovering your account by email. It completes on … Cancel?"
5. **Cancel:** any of my devices sends a `w`-signed `cancel(h, t)` to the mailer and the holders. It voids the hold, and the holders refuse a release for 72 hours after it. A cancel also re-shares, as in §3, if the user wants.
6. After 72 hours with no cancel, the mailer:
   - releases `r_m` to the new device;
   - signs a **release token** `{ h, new_device_pub, hold_started, valid_until: +7 days }` with its pinned key.
7. The new device publishes a request under the rendezvous `derive_key("mvs/member-recovery-rv/v1", h)`, carrying the token.
8. Each holder checks:
   - the mailer's signature;
   - that `h` matches;
   - that the token is still valid;
   - that there's no newer `w`-signed cancel or delete.

   Then it answers with its share **sealed to `new_device_pub`**.
9. With 3 shares, the new device rebuilds `s`, derives `k_mr`, opens the envelope and restores through `restoreIdentity`'s path, with the birth-date trust carried over, as device link does.
10. Then it **re-shares at once** (§3), because the released shares and `r_m` are now known to more parties. It also tells the mailer to rotate `r_m`.

**Holders never:**
- see the email or the code;
- decide on their own: they release only against a mailer-signed token after the hold.

**The mailer never:**
- holds `s` or the envelope key;
- sees the seed.

## 5. Availability

Holders are personal devices that come and go.
- **Shares are collected over the token's 7 days.** The new device keeps the request up and gathers shares as holders come online, so 3 holders needn't be online at the same moment.
- **Health in Settings:** for example "Recovery: 4 of 5 holders seen this week". A warning shows when fewer than 3 were seen in 14 days, which also triggers re-sharing.
- **Small communities will often be unavailable or weak (2-of-3).** That's acceptable because this is an extra path, and the opt-in screen says so.
- **If the mailer is down**, recovery waits. Nothing else is affected.

## 6. Threats

| Attack | What stops it |
|---|---|
| One server owner (with modified clients) | At most one holder per owner group; 3 independent owners needed |
| A Sybil owner (many owner keys, many servers I joined) | Residual. Mitigations: only servers with at least 2 other members count; prefer long co-membership; the email code plus 72 hours plus the notice and cancel still apply |
| Whoever controls my inbox | Still needs 3 holders' release and 72 hours with no cancel from my devices (the #365 residual, now also bound to members) |
| The mailer operator | Has `r_m` and can skip the code, but needs 3 colluding holders, and my devices see the pending notice |
| Holders who later leave | A fresh split on re-share; old shares never open the new envelope |
| Holders learning who I am | Only `h` and a share; no identity key, email or seed |
| Replay of an old release token | Bound to `h`, `new_device_pub` and a 7-day validity; a newer cancel or delete wins |
| A device of mine is lost, but I still have others | My devices cancel; the words still work. This path is only for when everything is lost |

## 7. API sketch (for dev-ui; final names at build time)

**Signed-in device:**
- `getMemberRecovery()` returns `{ state: 'off' | 'on' | 'weak' | 'unavailable', holdersSeen, holdersTotal, threshold, pending?: { until } }`.
- `enableMemberRecovery(email)` and `disableMemberRecovery()`. Disabling deletes at the mailer and sends deletes to the holders.
- `cancelMemberRecovery()`.
- Event `memberRecovery.changed`.

**New device:**
- `requestMemberRecovery(email)`;
- `confirmMemberRecoveryCode(code)` returns `{ holdUntil }`;
- Event `memberRecovery.progress` with `{ state: 'held' | 'collecting' | 'done' | 'failed', shares, threshold }`.

**Holder side:** no UI. It's a background core duty, with an entry in Settings → Privacy ("You hold recovery pieces for N people. You can't read them.").

## 8. Dependencies and build split

- **Mailer (devops):** the #365 mailer, extended with:
  - the `tag_m` record;
  - the hold for `h`;
  - publishing pending state;
  - the signed release token;
  - accepting a `w`-signed cancel;
  - rotating `r_m`.

  It does **not** need the second bootstrap (no OPRF).
- **dev-sync:**
  - the share store and the release request on the holders (`/mvs/member-recovery/1`, request-response, at most 8 KiB);
  - the rendezvous;
  - a notice slot at the holders for pending, cancel and delete. It's shared with device link's "new device added" follow-up.
- **dev-identity:**
  - Shamir split and combine (a small GF(256) routine, reviewed, with no new crate);
  - the keys and envelope;
  - holder selection and re-sharing;
  - the state machine and API;
  - tests: the selection rule, a fresh split on re-share, a cancel winning, a forged token refused, and 2 shares not being enough.
- **dev-ui:** the opt-in screen with the warnings (extra path, 72 hours, small communities), the health line, the new-device flow and the notice.

## 9. Questions for the Security Lead

1. **2-of-3** when only 3 or 4 owner groups exist: allow it as "weak", or require 5 groups?
2. **Shares in the clear at holders** (threshold only), or also sealed to a holder key so a stolen holder database alone yields nothing?
3. **Holder freshness:** 14 days seen to be picked, and 30 days unseen to be replaced. Are these right?
4. **Do holders need the email code at all**, given the mailer's signed token after the hold already binds it?
5. **Opt-in default and PO wording:** off by default, with the #365 single-device warning reused?
