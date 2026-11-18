# Design note: report to the owners (G-48)

Status: draft for the security lead and the Tech Lead. Author: dev-updater. The core PR follows this note; the UI is voice-c's.

## Goal
- A member reports a message or a member to the server's staff: the owner and the admins.
- Only the staff can read a report. Nobody else should learn that a report exists or who filed it, and that includes the reported member.
- A report is signed by the reporter, so staff know who filed it and a forged report can't be pinned on someone.
- It's a safety basic for the 16+ alpha.

## What a report carries
A fixed-size plaintext, so its length leaks nothing. All integers are little-endian.

```text
v          u8         1
server     [u8; 32]
reporter   [u8; 32]   Ed25519 key, the signer
kind       u8         1 = message, 2 = member
channel    [u8; 32]   the message's channel; zero for a member
target     [u8; 32]   the message's record ID, or the member's key
reason     u8         see below
ts         u64        ms, the reporter's clock
nonce      [u8; 16]   random; with the reporter, it gives the report ID
text_len   u16        0..=TEXT_BYTES
text       UTF-8      optional note, at most 280 code points and 1024 bytes
padding    zeros      up to PLAIN_LEN = 1200 bytes, then
evidence   optional   the reported message's signed record, as held (below)
sig        [u8; 64]   Ed25519 over "mvs/report/v1\0" ‖ all of the above
```

- **Reason** (enum, `u8`): 1 spam, 2 harassment or bullying, 3 hate, 4 violence or threats, 5 sexual content, 6 **involves a minor**, 7 self-harm, 8 illegal, 9 impersonation, 255 other. Any other value is refused. The UI asks for the text only with "other".
- **Text:** the same strict rule as channel names and topics (`display_text_ok`, no line breaks, trimmed with `char::is_whitespace`), at most 280 code points.
- **Evidence (kind = message):** the reporter attaches the reported message's own signed record, exactly as it holds it, up to `MAX_RECORD_BYTES`. Staff can verify the author's signature, and open the body with their channel key, so the evidence can't be forged and survives a later edit or delete. A report about a member carries none.
- **Report ID:** BLAKE3 `derive_key("mvs/report-id/v1", reporter ‖ nonce)`. Staff de-duplicate on it.

## Who can read it: sealed to each staff member
- **Recipients:** the owner and the admins, as the reporter's core resolves them when it sends, **minus the reported member** (an admin who is reported doesn't get the report about them). If no one is left (the owner reported, and no admins), `reportContent` returns `no-recipient` and nothing is sent.
- **Sealing:** for each recipient separately, the signed report goes into a box. An ephemeral X25519 key, against the recipient's X25519 key (derived from Ed25519, as in `groupkeys`). BLAKE3 `derive_key("mvs/report-seal/v1", shared ‖ ephemeral ‖ recipient ‖ server)`, then XChaCha20-Poly1305 with a random nonce.
- **One ciphertext per recipient**, so no recipient list travels, and every box has the same size for a given evidence length.

## How it travels: direct, not the log (recommended)
**Option A (recommended): a direct, members-only protocol `/mvs/report/1`.** It is the typing and voice pattern: a request carries one sealed box, at most 20 KiB, and the answer is a one-byte ack.
- **Sending:**
  - The reporter's core keeps an **outbox** (db) with one row per (report, recipient).
  - Each sync tick, it sends to every recipient that is online, and drops a row once that recipient acks.
  - Rows older than 30 days are dropped.
  - `report.status { reportId, delivered, pending }` follows progress.
- **Receiving:** a box is opened only if all of these hold:
  - it opens with my key;
  - the signature is valid and the signer is the identity sync bound the peer to;
  - the server is mine, and I am the owner or an admin there now;
  - the reporter is a current member, not kicked;
  - the ID is new;
  - `ts` is no more than 10 minutes in the future and no more than 30 days in the past.

  Anything else is dropped quietly, and the answer is still an ack, so a probe learns nothing.
- **Privacy:** no record enters the log, so other members never see that a report exists. The relay and the network see only that two members exchanged an encrypted frame.
- **Offline staff:** a report waits in the reporter's outbox until the reporter and that staff member are online together. Member relays (`member-relays.md`) can carry it later. This residual is stated in the UI ("delivered to 1 of 3 staff").
- **Cost:** a small node.rs hookup, the same shape as G-29's typing. dev-sync owns that file, so I tell them the lines.

**Option B: a tagged control-log `Post`** (`{"mvs":"mvs/report/v1","box":...}`, one box per recipient). Older peers already ignore unknown posts, so there's no cap gate, and offline staff get it on sync. But a post's author is plaintext to every member, so every member, including the reported one, would see that X filed a report and when. That is a retaliation risk on a safety feature. **Not recommended.**

## Caps
- **Reporter (core, before signing):** 5 reports an hour and 20 a day per server, and one report per target per reporter (a repeat is `already-reported`).
- **Receiver:**
  - per reporter, 10 reports an hour, beyond which they are dropped;
  - at most 1000 stored reports per server, oldest dismissed first.
- **Network:** per peer, a burst of 3 then one every 10 s; all peers, a burst of 20 then 2 a second. These are the typing limiter's own kind, separate from voice and typing.
- **Sizes:**
  - plaintext 1200 bytes, plus evidence up to `MAX_RECORD_BYTES`, plus the signature;
  - a box at most 20 KiB;
  - text at most 280 code points.

## API
- **`reportContent({ serverId, target, reason, text? })`** → `{ reportId }`.
  - `target` is `{ kind: 'message', messageId }` or `{ kind: 'member', userId }`.
  - Errors:
    - `bad-request`: a bad reason or text;
    - `not-found`: an unknown message or member, or one not in that server;
    - `not-allowed`: reporting myself, or I'm not a member;
    - `rate-limited`;
    - `already-reported`;
    - `no-recipient`.
  - Nothing is signed on an error.
- **`listReports(serverId)`** (owner and admins) → `Report[]`, newest first. A `Report` is `{ id, serverId, reporterId, target, reason, text?, ts, receivedAt, evidence?: Message, dismissed }`. `evidence` is the opened message when I hold its channel key; otherwise it is absent and `evidenceSealed: true`.
- **`dismissReport(reportId)`:** local only, for my own triage. It isn't shared with other staff in v1.
- **Events:**
  - `report.received { serverId, report }` to staff. It is a notification (with no text in the preview, per the notification-preview rule) and counts in a staff-only badge.
  - `report.status { reportId, delivered, pending }` to the reporter.
- **Never visible to the reported member:** no event, no list entry. The reporter's own list (`listMyReports`) can come later.

## Out of scope for v1
- Sharing triage state (who handled what) between staff.
- Reports to the app's operators (that's the B24 abuse address).
- Auto-actions on reports (hiding, kicking).
- Moderators as recipients.

## Tests (core PR)
- **Codec:**
  - the plaintext round-trips;
  - every refusal: reason, text rule, `text_len`, padding not zero, a bad signature, a wrong server, an unknown `v`;
  - evidence with a valid and a forged signature.
- **Seal:**
  - a box opens only for its recipient;
  - tampering is refused;
  - boxes for one evidence length have the same size.
- **sync relay:**
  - members only, both ways;
  - its own caps;
  - never arrives as voice or typing.
- **api, cores through the in-process hub:**
  - staff get it, the reported admin doesn't, and a plain member never sees anything;
  - the outbox delivers when an offline admin comes online;
  - dedup and replay;
  - the rate and size caps;
  - `no-recipient`;
  - the evidence opens, and stays after the author deletes the message;
  - the dispatcher and the JSON shapes.

## Questions for the reviewers
1. Option A (direct and private, but staff must come online) or option B (in the log, but the reporter is visible to all)? I recommend A.
2. Should evidence be the signed record (verifiable, up to about 16 KiB), or only a reference?
3. Should moderators receive reports too? This note says owners and admins only, as the board item asks.

## Amendment 1 (Tech Lead review)
- **The questions:**
  - **Q1:** option A. Delivery through member relays or a holder mailbox is a later follow-up.
  - **Q2:** the evidence is the signed record. The receiver checks:
    - its ID equals `target`;
    - its channel equals `channel`, a channel of `server`;
    - its author is the reported author.

    The evidence is padded to buckets (0, 2, 8, 16 KiB), so the box size doesn't follow the message's length.
  - **Q3:** owner and admins only.
- **A1. Who is reported:** for kind = message, the reported member is the message's author, taken from the record. They are excluded from the recipients. With nobody left, the answer is `no-recipient`, and the UI points at the B24 abuse address.
- **A2. The outbox re-checks at every send:** a row whose recipient is no longer owner or admin is dropped. Admins added after a report don't get it in v1.
- **A3. Losing staff status:**
  - When I stop being owner or admin, `listReports` is `not-allowed`, and my stored reports for that server are deleted.
  - Leaving the server, or being kicked, deletes them too.
  - When the reporter leaves a server, their outbox rows for it are deleted.
- **A4. Never in the account backup or the logs:** neither reports nor the outbox. Dedup IDs are kept for 31 days, matching the 30-day `ts` window.
- **A5. Receiving a member report:** the target must be a current or removed member of the server.
- **A6. Non-repudiation is intended:** staff hold a signed report and can prove who filed it. The UI (voice-c and UX) must say "the owner and admins will see that you reported this".
- **A7. Crypto:**
  - reuse `groupkeys`' Ed25519→X25519 conversion and the existing XChaCha20-Poly1305 and BLAKE3 crates, with no new or duplicate crypto crate;
  - AEAD associated data = `"mvs/report-seal/v1" ‖ recipient ‖ server`;
  - the security lead reviews the codec and the seal.
- **A8. node.rs is dev-sync's:** I send them the exact hookup: the protocol, the limiter and the typing members-only check. The protocol lives in its own module.
- **A9. One PR, core only, with CONFORMANCE.md:** `mock.ts`, the allow-list and the UI go to voice-c.
