# Product acceptance criteria: 0.5.0 – 0.6.0 (product-lead)

Source: `docs/ux/GAPS.md` and the board rows from #321. Acceptance is given on a PR at a head SHA, against the criteria below plus the standing rules (neutral Hebrew, FSI/PDI isolation, AA contrast, reduced motion, no promise of a date or of deletion we can't keep).

## Priority (confirmed, with two moves)

| Release | Theme | Items |
| --- | --- | --- |
| 0.4.x (infra, in parallel) | Voice and restore that work for real users | **G-81** calls across networks, **G-91** servers back after a restore |
| 0.5.0 | Conversation | G-23, **G-29**, G-25, **G-26**, G-27, G-32, G-33, G-30, G-63, G-62, G-113, G-92, **G-72 (moved up from 0.6.0)** |
| 0.5.x | Managing a server | G-53, G-52, G-51, G-12, G-13, G-14, G-18, G-47, G-48, G-41, G-77 |
| 0.6.0 | Voice like Discord | G-16, G-73, G-84, G-74, G-64, G-83 |

**Moves:**
- **G-72 (microphone and speaker choice, mic test) moves to 0.5.0.** Voice is already shipped, and choosing the right device is the most common call problem. Without it, the other voice work can't be tested by real users.
- **G-81 stays the top infra item.** It's the largest gap in voice.

Board housekeeping for pm: the 0.4.0 rows (G-01, G-11, G-21, G-24, G-05, G-61, G-17, G-03, G-04, G-22, G-06) still say "todo" but are merged; mark them done.

## G-29 – "someone is typing…"

1. When a member types in a channel, the others in that channel see "⁨{name}⁩ באמצע כתיבה…" (one person), "⁨{a}⁩ ו־⁨{b}⁩ באמצע כתיבה…" (two), or "כמה אנשים כותבים…" (three or more); wording that's neutral for any gender, within 2 s.
2. The indicator disappears no later than 6 s after the last keystroke, and immediately when the message is sent or the text is cleared.
3. **Ephemeral:** never written to the log, never stored, and never relayed to non-members (sec-lead). Sent at most once every 3 s per channel.
4. Not sent for blocked accounts and not shown from them. Not sent in "ממסר בלבד" mode if it would need a direct connection.
5. A setting "הצגת חיווי כתיבה לאחרים" (on by default) turns sending off; receiving still works.
6. Screen readers: not announced (too noisy). Reduced motion: no animated dots.

## G-26 – emoji reactions

1. Hover or the context menu shows "הוספת אמוג'י" (not "תגובה", which already means a reply). Picking an emoji adds it under the message with a count. Clicking an existing reaction toggles mine.
2. Mine is visually marked (border plus `aria-pressed`), and hover or focus shows who reacted (names isolated, at most 10 plus "ועוד ⁨{n}⁩").
3. A signed record per reaction; removing mine is a tombstone. A member sees others' reactions within the normal message delivery time.
4. Limits: at most 20 distinct emoji per message, and only standard Unicode emoji (no custom images in this release).
5. Reactions on a deleted message disappear with it. A blocked account's reactions are counted but its name isn't shown.
6. Keyboard: the reaction row is reachable by Tab, with Enter/Space to toggle.

## G-72 – microphone and speaker choice, mic test

1. Settings → Voice lists input and output devices by their system names, with "ברירת המחדל של המערכת" first.
2. Changing a device during a call takes effect without leaving the call.
3. "בדיקת מיקרופון" shows a live level meter, and plays back to me only if I turn on "השמעה עצמית".
4. An unplugged device falls back to the system default, with a short notice naming the device.
5. No microphone permission is requested until the Voice page or a call is opened (the rule from #224).
6. Remembered per computer; never synced.

## G-91 – servers come back after a restore

1. After restoring with the 12 words (or linking a device), the servers I was a member of appear on their own, without an invite link, within 2 minutes of a member of each server being online.
2. Until then, the restore screen says honestly what's happening ("מחפשים את השרתים שלך…") and what to do if nothing appears (an invite link still works).
3. A server I was removed from, or that was closed, doesn't come back.
4. Roles and the age rules are as before the restore (the 30-day rule from #306 still holds).
5. Nothing about which servers I'm in is published in a way non-members can read (sec-lead review).

## G-81 – calls across networks

1. Two members on different home networks (one behind CGNAT or cellular) can talk with audio in both directions, measured on the published build.
2. Setup within 10 s at p95. If no path is found, the participant row says "אין חיבור קולי" (existing string), and the call continues for the others.
3. Audio delay at p95 under 400 ms on a typical home connection. Results go to `qa/` with no IPs.
4. The first-call IP notice (#225) still shows before the first direct call. The voice relay, if used, is disclosed the same way as member relays (#387).
5. "ממסר בלבד" still means no calls (unchanged until a decision says otherwise).
6. Release notes drop "same network only" only after QA's two-network test passes.
