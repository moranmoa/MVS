# Design note: server icon and description (G-51)

**Status:** draft, for the Tech Lead and the Security Lead (wire format).
**Author:** dev-identity (taken over from dev-updater).
**Scope:** core only. The UI (dev-ui) follows the contract below, after this.

**Pattern:** G-14 (`channel-topic.md`, #507): a size-capped body, an authority rule, a cap gate for older peers, plain text, and plaintext-inside-the-server honesty.

## What it is
- A server gets an optional **icon**, a small picture shown instead of its initials, and an optional **description**, a few lines shown in the server's settings and header (B11 §2, B11a–d §3.1).
- The owner or an admin sets, changes or clears each one.
- Every member sees the same, decided by the control log like the server's name.

## The description: a field of `ServerEdit` (no new kind)
`ServerEdit`'s JSON body (`{ v, name }`) already ignores unknown fields, and its `max_body` (2 KiB) was sized for "server name, icon reference, description". So:

| | |
| --- | --- |
| Body | `{ "v": 1, "name": …, "description"?: … }` |
| Field | absent: unchanged. `""`: cleared. Otherwise the new description. |
| Length | 0 to **500 code points** and at most **1500 bytes** (fits the 2 KiB body with a 100-code-point name) |
| Text rule | the topic's (`channel_topic_ok`): valid UTF-8, strict `display_text_ok` (no bidi controls, other controls or zero-width characters), trimmed. **Line breaks:** see Question 1. |

- **Who:** as for a rename today: the owner or an admin (`author_role >= Role::Admin`), privileged, so a revoke or kick voids concurrent edits.
- **Which wins:** the latest accepted `ServerEdit` that *has* the field, in linear order. A rename without the field leaves the description alone, so an older peer's rename never clears it.
- **Malformed:** a description that fails the rule makes the whole body fail to parse, so the record is never accepted, as for a bad name. One encoding per body.
- **Older peers:** they ignore the field and keep accepting the rename part. Nothing stalls, so there's **no new cap**. The existing `server-lifecycle-v1` gate on `ServerEdit` still applies. An older peer simply doesn't show the description.
- `resolve` and the incremental `Resolver` both keep `state.server_description`, and the existing equivalence tests cover it.

## The icon: a new kind
The icon is too big for `ServerEdit`, so it gets its own control kind.

| | |
| --- | --- |
| Kind | `ServerIcon = 23`, control scope only |
| Body | `history u8` (reserved for D30, must be 0) ‖ `type u8` (1 = PNG, 2 = WebP) ‖ image bytes. A body of just the two bytes, with no image, clears the icon. |
| Image | at most **8 KiB**, and **1 to 128 pixels** on each side, square or not (`ICON_MAX_BYTES`, `ICON_SIDE_MAX`) |
| `max_body` | 2 + 8192 bytes |
| Validation | strict, without decoding pixels, the same code as the profile picture (`avatar.rs`, generalised to a side limit). PNG: the signature, then IHDR, then a chunk walk to IEND, no `acTL` (no APNG). WebP: RIFF/WEBP with exactly one `VP8 ` or `VP8L`; `VP8X` without the animation flag; no `ANIM` or `ANMF`; every declared size must agree. The `type` byte must match the magic. |
| No SVG, GIF or JPEG | only these two types, by the type byte and the magic. Nothing else parses. |

- **Not re-encoded:** the core has no image codec and adding one (a parser of untrusted pixels) is a bigger risk than strict header validation. The UI re-encodes on the way in: it draws the user's picture to a 128×128 canvas and exports WebP, as it does for the profile picture. Receivers only ever check, and the UI renders through `<img src="data:…">` under CSP `img-src 'self' data:`, as for avatars.
- **Who:** the owner or an admin, privileged (voided by a concurrent revoke or kick). The latest accepted `ServerIcon` in linear order wins.
- **Log growth:** every change stays in the control log, which every joiner fetches, so 8 KiB each. The core lets an owner or admin set the icon at most **once per 10 minutes** (like profile posts): a later call answers `rate-limited`. The authority doesn't rate-limit, since a modified client could still spam, the same as with any privileged record. Pruning old icons is a later item (control-log stubs).
- **Older peers:** they refuse an unknown kind, and a control record they can't decode holds back everything after it. So there's a **strict cap gate**: a new cap **`server-icon-v1`** in `CAPS`, and `setServerIcon` answers `update-needed` while any member's latest profile lacks it. `getUpdateNeeded(serverId, 'server-icon-v1')` lists who.
  - **Residual,** as for topics: someone who joins later on an older version can't decode it until they update.

## 18+
- Both fields are **server-level**. A minor can't join an 18+ server (the age gate), and a server's own metadata isn't hidden per member, so there's nothing to withhold inside a server. This differs from an 18+ channel's topic, which is hidden from minor members of a plain server.
- If a later feature shows the icon or description *outside* the server (an invite preview, a server directory), it must apply the server's age restriction there. That's a note for that feature; nothing here shows them outside.

## Plaintext inside the server
Like the name and channel topics, both sit unsealed in the control log, so every member who holds the sync secret reads them. That includes a modified client (GAP-22). The UI says "visible to every member of the server", never that they are private.

## API
- **`setServerDescription(serverId, description)`** returns the updated `ServerSummary`.
  - The description is trimmed; an empty string clears it.
  - `bad-request` if it fails the rule.
  - `not-found` for a server I'm not in, `not-allowed` unless I'm the owner or an admin, `update-needed` while the lifecycle gate is shut.
  - Setting the same text again signs nothing.
- **`setServerIcon(serverId, dataUrl | null)`** returns the updated `ServerSummary`.
  - `dataUrl` is `data:image/(png|webp);base64,…`, checked as above; `null` clears the icon.
  - `bad-request` if it fails the check; `rate-limited` within 10 minutes of my last icon there.
  - The other errors are as for the description, plus `update-needed` behind `server-icon-v1`.
- **`ServerSummary`** gains `iconDataUrl?` and `description?` (additive; absent when unset).
- **Event:** the existing `server.updated`, for my change and for one that arrives by sync. Never unread, a mention or a notification.
- The mock and the `commands.js` allow-list come with dev-ui's PR.

## Tests
- **records:** the kind, its scope and `max_body`.
- **authority:**
  - owner and admin accepted; moderator and member refused;
  - the latest wins; clearing works; a revoke voids concurrent edits;
  - a rename without the field keeps the description;
  - malformed bodies don't parse: the history byte, a type/magic mismatch, an APNG, an animated WebP, two image chunks, 129 px, 8 KiB + 1, a bad description;
  - `resolve` equals the incremental `Resolver`.
- **api:**
  - the commands' errors, both gates and the rate limit;
  - the summary fields, and `server.updated` across two cores;
  - an older peer's rename keeping the description.

## Questions
1. **Line breaks in the description:** allow `\n`, at most 5 lines (no `\r`, no U+2028 or U+2029), or keep the topic's one-line rule? I propose allowing `\n`, up to 5 lines.
2. **Icon size:** is 8 KiB at 128×128 right? The profile picture is 2.5 KiB at 64×64.
3. **Rate limit:** one icon change per 10 minutes, enforced on the sender only. Enough?
