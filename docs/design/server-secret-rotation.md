# Design note: rotate the server's sync secret on kick (T17)

**Status:** direction chosen by the Tech Lead (#557): option A. The Security Lead reviews the sealing and serving rules; no code until then.
**Author:** dev-identity.
**Follows:** T16 (#100, a kick re-keys every channel).

## What the secret does today (GAP-4)
- Each server has a 32-byte sync secret. It's created with the server, sealed under the storage key, and carried in every v0 invite link (`mvs://join/<server>/<invite>/<secret>`). Short links carry it inside the envelope.
- `Network::open_server(server, secret, channels)` uses it to fetch and subscribe. Without it a peer can't ask for the server's logs.
- After a kick, T16 re-keys every channel, so the kicked member can't read new **messages**. But they still hold the secret, so they can keep **syncing**:
  - the control log (plaintext: names, roles, topics, age claims, who joins and leaves);
  - the sealed channel records (unreadable, but their metadata leaks: who posts, when and how much);
  - and they still count as a peer that holds the server's data.

T17 closes that: after a kick, the remaining members move to a new secret the kicked member never learns.

## What a rotation must do
1. **Make** a new secret: the moderator who signs the kick, or the first one to read it, as T16 does for keys.
2. **Get it to every remaining member, and only to them.**
3. **Switch** sync to the new secret once a member has it. Keep the old one only long enough to finish delivering the rotation.
4. **Invite links** carry the old secret, so existing links stop working. They need re-issuing, or the old secret has to stay valid for joining only (see Q3).
5. **Converge:** two moderators rotating at once must end on one secret, with no member stranded.

## Options for step 2 (distribution)
- **A. A new control kind, `SecretRotation`.** The body is the new secret sealed to each current member, as `KeyRotation` seals channel keys (groupkeys' per-member boxes). It's privileged (moderator and above), so a concurrent kick voids it, as for rotations. The latest accepted rotation in linear order wins, which settles concurrent ones.
  - Needs: a records kind, an authority rule, a cap gate (an older core would stall on the unknown kind), and groupkeys' sealing reused for a 32-byte payload.
  - Cleanest, but the largest piece.
- **B. Ride on #general's key.** After T16's re-key, a moderator posts the new secret as a sealed message (a reserved message type) in #general, which only remaining members can open.
  - No new control kind.
  - But it depends on #general being keyed for everyone, on a message type older clients would show as garbage (needs a gate anyway), and on message ordering.
- **C. Derive it.** The new secret is `derive_key("mvs/sync-secret/v1", old_secret ‖ kick record id ‖ latest channel key of #general)`.
  - Every remaining member can compute it locally once they hold #general's new key; the kicked member can't.
  - No new wire data at all.
  - But it ties sync to #general's key schedule. A member who hasn't got the new key yet (offline, or no moderator online) can't follow until they do. The waiting-for-a-moderator path already exists for keys (`rekey-waiting`).

**Decision (Tech Lead on #557): A**, not C. Channel keys rotate for joins, kicks and B7-k, so there is no single agreed "latest #general key", and concurrent rotations would split the server. An 18+ #general (or G-18 later) would strand members who can't read it. And C couples a transport secret to a content-key schedule.

## Questions
1. **Distribution:** A, B or C?
2. **The switch:** how long does a member keep fetching on the old secret after switching (so a straggler's records still arrive)? I propose until every member they can see has posted under the new one, capped at 7 days.
3. **Invites:**
   - re-issue every open invite on rotation (new links, old ones dead); or
   - keep the old secret join-only for a grace period (a kicked member could then still fetch the control log through an old invite, which is the leak T17 is meant to close)?

   I propose re-issuing: a kick is rare, and the owner can re-share links.
4. **Scope:** a kick only, or also a leave and a revoke? A leaver also holds the secret. I propose kick and leave; a revoke leaves the person a member.
5. **Board size:** this is closer to M than S (any of A, B or C touches sync, invites and the restore backup, which holds secrets). OK to re-size?

## Tests (whichever option)
- A kicked member can't fetch anything signed after the rotation, while remaining members sync on.
- Concurrent kicks by two moderators converge on one secret.
- A member offline during the rotation catches up.
- Old invite links behave per Q3.
- The restore backup carries the current secret.

## Decision and rules (Tech Lead on #557)
- **Distribution: A.** A new control kind, `SecretRotation`:
  - the new secret is sealed to each remaining member with groupkeys' per-member boxes, as `KeyRotation` does for channel keys;
  - it's privileged (moderator and above), so a concurrent kick voids it;
  - the latest accepted rotation in linear order wins, so concurrent rotations converge.
- **Serving rule (new):** after a rotation, the old secret serves only a **frozen prefix**: the logs up to and including the rotation record, never anything signed after it. A member who was offline can still fetch the rotation (sealed to them) with the old secret. The kicked member gains nothing new.
- **Q2, the switch:** members keep fetching on the old secret until every member they can see has posted under the new one, capped at 7 days.
- **Q3, invites:** re-issue every open invite on rotation, with a notice to owners and admins to re-share links. Old links stop working.
- **Q4, scope:** a kick or a leave triggers a rotation; a revoke doesn't.
- **Q5, size:** M.
- **Gate (replaced by the PO's rule):** no blocking gate. The rotation happens at once on a kick. `lv:1` (the first use of the `lv:N` scheme) only **reports** who needs updating (`getUpdateNeeded(serverId, 'lv:1')`).

Next: the Security Lead reviews the sealing (the per-member box format, and who may rotate) and the serving rule (how sync enforces the frozen prefix for the old secret). The build follows as small PRs: records and authority first, then sync's serving rule (dev-sync), then core/api.

## Security Lead's conditions for the build (approved at e903be4)
- **S1, its own box:** the label and AAD are `"mvs/sync-secret-box/v1" ‖ server ‖ epoch/prev ‖ recipient`, so a channel `KeyRotation` box never opens as a `SecretRotation` box. There's a test for that cross-domain replay. The secret is a fresh 32 random bytes, and every value derived from it uses its own context.
- **S2, recipients:** exactly the members at the record's position, minus the removed. A recipient who isn't a member means `Required`; a member missing means `Add`. A rotation that still includes the kicked member gives `Required` and a re-rotation (test).
- **S3, the frozen prefix:** the rotation record R's **causal** past plus R, control log only, with no channel records. A linear prefix would leak concurrent post-kick records. Test: what the kicked member can fetch is exactly R's causal past plus R.
- **S4:** nothing new is published on the old topics; the 7 days are read-only.
- **S5:** invites are re-issued and the backup holds only the current secret. Every value derived from the secret follows the rotation: the sync topics and handles, the LAN beacon key, v0 links and short-link envelopes, and the backup.
- **PO (#557):** rotate at once on a kick. A member on an old core sees update-needed for that server, never a silent failure, and resumes after updating. No warning to owners before a kick. Test: the kicked identity can't pull, an updated member syncs, and an old-core member sees update-needed.

## What a core that's already released does (Tech Lead on #557)
- **It can't recognise any of this.** It refuses the unknown `SecretRotation` kind on decode, so that record, and every later control record whose deps include it, waits forever in its pending set. It also never learns the new secret, so it can't fetch or subscribe on the new topics.
- **What its user sees:** the server simply stops updating. The released cores have no "a record I can't read" state: today nothing in `core/api` detects an undecodable control record. So the PO's condition 1 (an old core shows update-needed, never a silent failure) **can't be met by cores that are already out**. What does reach them:
  - the in-app updater (B8), which prompts every outdated core to update anyway;
  - other members' new cores, which list the outdated member through `getUpdateNeeded(serverId, 'lv:1')`.
- **From this release on (proposed, part of the T17 build):** a core that holds a control record it can't decode (an unknown kind from the same server, correctly signed by a member) marks that server `updateNeeded` in its `ServerSummary` and fires `server.updated`. The UI then shows "you need to update MVS to keep syncing this server" instead of a hang. Every later new kind then degrades visibly on cores from this release onward.
- **After updating:** the core decodes the rotation, opens its box, moves to the new secret and syncs on, with no further action.

## Tests (the T17 build)
- The PO's three-sided test: the kicked identity can't pull, an updated member syncs, and an old-core member sees update-needed (simulated with a core that refuses the kind; the real old releases can't show it, as above).
- S1: a channel `KeyRotation` box replayed as a `SecretRotation` box is refused.
- S2: a rotation that includes the kicked member gives `Required` and a re-rotation.
- S3: what the kicked member can fetch is exactly R's causal past plus R.
- Concurrent kicks by two moderators converge on one secret.
- A member offline during the rotation catches up.
- Old invite links stop working, and new ones work.
- The restore backup holds the current secret.
- The LAN beacon key changes with the rotation (SL on #557: a kicked member on the same LAN can't keep decrypting beacons).
