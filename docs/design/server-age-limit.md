# Design note: changing a server's age limit (G-52), core

Status: approved by the Security Lead (#590, answers and residual below); kind code and level rule from the Tech Lead; the Tech Lead's full review pending. Author: dev-identity. UX spec: `docs/ux/specs/server-age-limit.md` (#578, voice-c builds the UI).

## Today
- The limit (`none`, `16+`, `18+`) lives only in the genesis body (`GenesisBody.age_restriction`, JSON), so it can't change.
- It is enforced by each member's own core:
  - `joinServer` refuses with `AgeBlocked` when my effective age is below it;
  - when my own age drops below it, I leave (`apply_lowered_age`, `server.removed` with reason `age`);
  - I can't lower my age below the limit of a server I own (`owns-restricted-server`).
- Channel keys don't look at the server limit. Only 18+ *channels* are keyed for members ∩ adults (B7-k, `channel_readers`).

## The record
| | |
| --- | --- |
| Kind | `ServerAgeLimit = 26`, control scope only. The codes are fixed, whichever merges first (Tech Lead on #590): T17's `SecretRotation` is 25, this one is 26. |
| Body | `min u8`: 0, 16 or 18. Anything else doesn't parse. |
| `max_body` | 1 |
| Authority | The author is the **owner** (not admins), privileged, so a kick or revoke voids it like other privileged actions. For `18`, the owner must be in `State.adults` at the record (the PO's owner rule from #512); otherwise it isn't accepted. |
| Which wins | The latest accepted record in linear order. `State.age_limit: Option<u8>`; the effective limit is `state.age_limit` or else the genesis value. |

- It is plaintext inside the server, like the name.
- A `ServerAgeLimit` that equals the current limit signs nothing (no-op).

## API
- `setAgeRestriction(serverId, 'none' | '16+' | '18+')` returns the updated `ServerSummary`.
  - Owner only, else `not-allowed`. A server I'm not in is `not-found`.
  - `18+` while my effective age is under 18: `too-young`.
  - Gated with `update-needed` while any member's latest profile lacks the level of the release that ships kind 26.
    - `lv:N` is per release: "this core decodes every kind introduced up to level N" (Tech Lead on #590).
    - So the gate is `lv:1` if G-52 ships with or before T17, else `lv:2`.
    - `getUpdateNeeded(serverId, 'lv:N')` lists who.
  - The UI confirms before calling (spec §2, §3). The core doesn't take a "confirmed" flag: an extra argument wouldn't stop a modified client.
- `countAgeAffected(serverId, '18+')` returns `{ count }` for the raise dialog: current members other than me who aren't in `State.adults`. No names. For `none` and `16+` it is 0, because the app's minimum is 16.
- Everywhere that reads `genesis.age_restriction` reads the effective limit instead: `ServerSummary.ageRestriction`, the join preview, `AgeBlocked`, `age_losses`, `apply_lowered_age`, and `purge_server`'s `required`.
- A change, mine or read by sync, fires `server.updated`.

## Raising to 18+
1. **Keys:** while the effective limit is 18, `channel_readers` is members ∩ adults for **every** channel, not only 18+ channels. Readers shrink, so the next moderator's sync re-keys each channel without the minors (the B7-k removal path: `keyed_for` goes stale). Older epochs stay readable to those who had them ("messages they already received stay").
2. **Receiver rule:** B7-k's rule then applies to every channel. The raise record is the edit that `reaches` must cover, kept as `State.server_adult_edit: Option<RecordId>`, the server-wide counterpart of `adult_edits`. So a minor's post with stale deps is dropped everywhere.
3. **The minor's own core:** seeing an accepted raise above its effective age, it leaves as in `apply_lowered_age`: `Leave` through the outbox, `server.removed` with reason `age` and `required: 18+` (spec §4: the existing B7 notice). An owner never leaves, but can't be a minor here by the authority rule.
4. **Joins:** `AgeBlocked` follows the effective limit.

## Lowering from 18+
- Readers grow, so the moderator's next sync re-keys with **a new epoch** that includes the 16–17-year-olds. groupkeys is forward-only: a new reader gets no wrap for an earlier epoch. So nothing written while the server was 18+ ever opens to them. That covers the PO's G-77 rule at the key level, and the UI's confirm dialog covers it for the person.
- 18+ channels keep their own readers (members ∩ adults), so nothing in them opens.
- Existing members get no notice (spec §3).
- `none` ↔ `16+`: the same people; no re-key and no dialog.

## Older cores (why the gate)
- An older core can't decode kind 26. From #589 on, it shows `updateNeeded` (the detector). Until it updates, it keeps keying every channel for all members, so an old moderator could hand a raised server's new keys to minors.
- The `lv:N` gate keeps the owner from raising while a member could still do that. A member who downgrades afterwards is the same residual as B7-k K2. The `adult-keys-outdated` notice logic extends to "a member lacks that level in an 18+ server" and is sent once.

## Tests (plan)
- **authority:** owner only; an 18 by a non-adult owner isn't accepted; the latest wins; kick/revoke voiding; a bad body doesn't parse.
- **api:**
  - raise: the minor member's core leaves with `required: 18+`; the next rotation excludes them; their stale-deps post is dropped;
  - lower: the next rotation includes a 17-year-old, who can't decrypt a pre-lowering message and can't see an 18+ channel;
  - `too-young`, `not-allowed`, the `update-needed` gate, `countAgeAffected`, no-op, `server.updated`;
  - the join preview and `AgeBlocked` follow the effective limit.

## Residual (Security Lead on #590)
- **The risk.** A minor's core that refuses to leave after a raise (modified, or old) keeps the server's sync secret. It can read the plaintext control log and metadata. A leave never happens, so T17's leave rotation never fires.
- **Mitigation.** After an accepted raise to 18+, every current member who isn't in `State.adults` and hasn't left shows to the owner and admins as **not adult**. This uses the `countAgeAffected` source, and `listMembers` marks them. The owner can then kick them, and a kick rotates the secret (T17). Channel keys already exclude them (step 1).

## Questions for review (answered)
1. **SL, answered on #590:** yes, both. The keys stop the reading, and the server-wide receiver rule stops posting with stale deps. When a server-wide raise and a channel's own 18+ edit both exist, `reaches` must cover **the later of the two**.
2. **SL, answered on #590:** yes. The owner's `setAgeRestriction` re-keys in the same call. That helps availability, and the `Required` path already prevents sealing under a stale key.
3. **TL, answered on #590:** kind 26 (T17 keeps 25). The gate is the level of the release that ships this kind.
