# Design note: server icon and description (G-51)

**Status:** approved by the Tech Lead with Amendment 1 (applied below: the description is its own kind, and one cap covers both). The Security Lead reviews the wire format.
**Author:** dev-identity (taken over from dev-updater).
**Scope:** core only. The UI (dev-ui) follows the contract below, after this.

**Pattern:** G-14 (`channel-topic.md`, #507): a size-capped body, an authority rule, a cap gate for older peers, plain text, and plaintext-inside-the-server honesty.

## What it is
- A server gets an optional **icon**, a small picture shown instead of its initials, and an optional **description**, a few lines shown in the server's settings and header (B11 §2, B11a–d §3.1).
- The owner or an admin sets, changes or clears each one.
- Every member sees the same, decided by the control log like the server's name.

## The description: a new kind (Amendment 1)
Not a `ServerEdit` field. Every `ServerEdit` must carry `name` (older peers require it), so a description edit would re-sign the name, and a concurrent rename by another admin would be silently reverted when the description edit lands later in linear order. `ServerEdit` stays as it is.

| | |
| --- | --- |
| Kind | `ServerDescription = 24`, control scope only |
| Body | `history u8` (reserved for D30, must be 0) ‖ the description, UTF-8; empty clears it |
| Length | 0 to **500 code points** and at most **1500 bytes** |
| `max_body` | 1 + 1500 bytes |
| Text rule | `authority::server_description_ok`, shared by the API and the parser: valid UTF-8, the strict `display_text_ok` per line (no bidi controls, other controls or zero-width characters), trimmed. `\n` line breaks are allowed, **at most 5 lines**, with no `\r` and no U+2028 or U+2029. No leading or trailing blank line, and at most one empty line in a row. |

- **Who:** the owner or an admin (`author_role >= Role::Admin`), privileged, so a revoke or kick voids concurrent edits.
- **Which wins:** the latest accepted `ServerDescription` in linear order.
- **Malformed:** a body that fails the rule doesn't parse, so the record is never accepted. One encoding per body.
- **Older peers:** refuse the unknown kind, so it's behind the same cap gate as the icon (`server-meta-v1`, below).
- `resolve` and the incremental `Resolver` both keep `state.server_description`, and the equivalence tests cover it.
- **Display:** plain text in the UI, never Markdown or HTML.

## The icon: a new kind
The icon is too big for `ServerEdit`, so it gets its own control kind.

| | |
| --- | --- |
| Kind | `ServerIcon = 23`, control scope only |
| Body | `history u8` (reserved for D30, must be 0) ‖ `type u8` (1 = PNG, 2 = WebP) ‖ image bytes. A body of just the two bytes, with no image, clears the icon. |
| Image | at most **8 KiB**, and **1 to 128 pixels** on each side, square or not (`ICON_MAX_BYTES`, `ICON_SIDE_MAX`) |
| `max_body` | 2 + 8192 bytes |
| Validation | strict, without decoding pixels, through **one validator shared with the profile picture** (`avatar.rs`, given a side limit). See R2 below for the order of checks. |
| No SVG, GIF or JPEG | only these two types, by the type byte and the magic. Nothing else parses. |

- **Not re-encoded:** the core has no image codec and adding one (a parser of untrusted pixels) is a bigger risk than strict header validation. The UI re-encodes on the way in: it draws the user's picture to a 128×128 canvas and exports WebP, as it does for the profile picture. Receivers only ever check, and the UI renders through `<img src="data:…">` under CSP `img-src 'self' data:`, as for avatars.
- **Who:** the owner or an admin, privileged (voided by a concurrent revoke or kick). The latest accepted `ServerIcon` in linear order wins.
- **Log growth:** every change stays in the control log, which every joiner fetches, so 8 KiB each. The core lets an owner or admin set the icon at most **once per 10 minutes** (like profile posts): a later call answers `rate-limited`. The authority doesn't rate-limit, since a modified client could still spam, the same as with any privileged record. Pruning old icons is a later item (control-log stubs).
- **Older peers:** they refuse an unknown kind, and a control record they can't decode holds back everything after it. So there's a **strict cap gate**: one new cap for both new kinds, **`server-meta-v1`**, in `CAPS`; `setServerIcon` and `setServerDescription` answer `update-needed` while any member's latest profile lacks it. `getUpdateNeeded(serverId, 'server-meta-v1')` lists who.
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
  - `not-found` for a server I'm not in, `not-allowed` unless I'm the owner or an admin, `update-needed` behind `server-meta-v1`.
  - Setting the same text again signs nothing.
- **`setServerIcon(serverId, dataUrl | null)`** returns the updated `ServerSummary`.
  - `dataUrl` is `data:image/(png|webp);base64,…`, checked as above; `null` clears the icon.
  - `bad-request` if it fails the check; `rate-limited` within 10 minutes of my last icon there.
  - The other errors are as for the description, plus `update-needed` behind `server-meta-v1`.
- **`ServerSummary`** gains `iconDataUrl?` and `description?` (additive; absent when unset).
- **Event:** the existing `server.updated`, for my change and for one that arrives by sync. Never unread, a mention or a notification.
- The mock and the `commands.js` allow-list come with dev-ui's PR.

## Tests
- **records:** the kind, its scope and `max_body`.
- **authority:**
  - owner and admin accepted; moderator and member refused;
  - the latest wins; clearing works; a revoke voids concurrent edits;
  - a description edit never touches the name (its own kind), and a concurrent rename stays;
  - malformed bodies don't parse: the history byte, a type/magic mismatch, an APNG, an animated WebP, two image chunks, 129 px, 8 KiB + 1, a description over 5 lines, or with ``, U+2028 or two blank lines in a row;
  - `resolve` equals the incremental `Resolver`.
- **api:**
  - the commands' errors, both gates and the rate limit;
  - the summary fields, and `server.updated` across two cores;
  - an older peer's rename keeping the description.

## Answers (Tech Lead on #547)
1. **Line breaks:** yes, `\n`, at most 5 lines. No `\r` and no U+2028/2029. No leading or trailing blank lines, and at most one empty line in a row (`server_description_ok`).
2. **Icon size:** 128 px and 8 KiB, with a side parameter added to `avatar.rs`.
3. **Rate limit:** the sender-side 10 minutes is enough for v1.

## Security Lead review (#547)
- **R1 (one rename, the same in every version):** this targeted the earlier draft, where the description was a `ServerEdit` field. Since Amendment 1 the description is its own kind (`ServerDescription = 24`), so a `ServerEdit` is exactly what it was. A bad description can't make new and old cores disagree about a rename. Old cores refuse the new kind, which is what the `server-meta-v1` gate is for. Duplicate JSON keys don't arise, since neither new body is JSON.
- **R2 (the icon check, in this order, one validator shared with `avatar.rs`):**
  1. the data URL prefix (`data:image/png;base64,` or `data:image/webp;base64,`);
  2. a length cap on the base64 text before decoding (8 KiB rounded up to base64);
  3. strict base64;
  4. the record's `type` byte, the MIME type and the magic bytes all name the same format;
  5. **PNG:** at most 64 chunks; IHDR first and IEND last, with nothing after IEND; no `acTL`;
  6. **WebP:** exactly one `VP8 ` or `VP8L`, whose own dimensions are checked against `VP8X`'s (when present) and against 128 px; no animation flag, `ANIM` or `ANMF`;
  7. every side within 1..=128.
- **Q1:** `\n` only, at most 5 lines, every line `display_text_ok`. Shown as plain text with `white-space: pre-line`: no Markdown, no links.
- **Q2 and Q3:** as the Tech Lead answered.
- **Board (manager):** any display outside the server (an invite preview, a directory) must apply the server's age restriction.
