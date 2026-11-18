# Design note: rotate the server's sync secret on kick (T17)

**Status:** draft, for the Tech Lead and the Security Lead. **No code** until a direction is chosen.
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

**My recommendation is C,** with the SL's view on deriving a transport secret from a content key. It has no wire change and no cap gate, and the "can't follow until keyed" case maps onto the existing `rekey-waiting` state.

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
