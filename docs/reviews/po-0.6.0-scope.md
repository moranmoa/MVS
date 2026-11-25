# 0.6.0 scope, order and acceptance criteria (product-lead)

Theme: **no server needed, and safe for the closed alpha.** The standing rules apply to every item: neutral Hebrew, FSI/PDI isolation, AA contrast, reduced motion, and no promise of a date or of deletion we can't keep. Acceptance is given on a PR at a head SHA.

## Order

| # | Item | Why this place |
| --- | --- | --- |
| 1 | Relay-in-app R1 → R1b → R1c → R2 → R3 (#561) | The owner's top goal: users are the relays, no central server |
| 2 | G-81 P2P calls on by default | Needs 1. Calls across networks are the largest voice gap |
| 3 | T17-pre, then T17 secret rotation | A kick must close access (M2), and T17-pre ships first |
| 4 | G-48 reports (core #515 + UI) | A safety basic for a 16+ alpha |
| 5 | B24a About | Required before the closed alpha: abuse address, agreement, privacy |
| 6 | G-52 age restriction setting (M–L) | The owner controls their server's audience. Needs a new owner-only control kind and T17's rotation, so it comes after 3 |
| 7 | G-51 server icon UI | Polish; first to slip if 0.6.0 is late |

## Acceptance criteria

**1. Relay-in-app (R1–R3)**
- A computer with an open or mapped port relays for members of its servers only, within the daily cap and the disclosure from #387; nobody relays before seeing it.
- Two members behind ordinary home NAT connect through a third member's app with no project server running (the test turns the owner's relay off), using a full invite link (R2 invite hints). The third member must be reachable: an open IP, or a home router mapped by R1b, with its address propagated by R1c.
- Port mapping (R1b) is in 0.6.0 scope, but it stays off until the owner decides; when on, it's opt-in and explained. **If the owner declines R1b,** the test uses a third member with an open IP, and the release notes say home users serve only with an open port.
- CGNAT and cellular users can use relays but never serve. Metered connections never serve, where the OS reports them as metered.
- No relay sees content (end-to-end encryption unchanged), and nothing about who relays for whom is published to non-members.

**2. G-81 P2P calls on by default**
- The criteria in `docs/reviews/po-acceptance-0.5.md` (G-81, #499): home NAT ↔ home NAT required, set up within 10 s and under 400 ms at p95, with no STUN/TURN/media server.
- The voiceP2p gate is removed only after QA's two-network test passes on the published build; the release notes name the network pairs that were tested.
- The IP notice v2 (#497) shows before the first direct call.

**3. T17-pre, then T17**
- T17-pre ships in the same release as T17 or earlier: a core with a record it can't read shows "צריך לעדכן את MVS כדי להמשיך לסנכרן בשרת הזה", and sync resumes after updating.
- After a kick, the kicked identity can't pull new records; up-to-date members keep syncing; members on an older version see "update needed", never a silent failure.
- The release notes say older versions stop syncing a server after a kick until they update.

**4. G-48 reports**
- The R6 decisions (evidence behind a click for reasons 5 and 6, hidden from staff under 18, no copy for reason 6, the 105 line, delete offered first) and the self-harm help line (101/1201).
- Staff notifications follow #567 (they come through a mute; the staff-only switch; text-free; 1 per minute).
- The reporter's identity is visible to staff only; nothing reaches non-staff or the network in clear.

**5. B24a About**
- The version, the abuse-report address from the release config (the release build fails if it's empty), and links to the agreement and the privacy note.
- The privacy note is the current one (no connection logs at the relay, voice IP disclosure, member relays).
- The real domain never appears in git.

**6. G-52 age restriction setting**
- Owners can change a server's age restriction in settings (a new owner-only control record behind the version gate; SL review).
- **Raising it:** members without a matching age claim are removed deterministically, with a re-key and the T17 secret rotation, as for a kick. Never silently: the owner first sees a confirmation that says how many, and each removed member sees why ("הגבלת הגיל של השרת עלתה").
- **Lowering it:** allowed, with no removals. It's the owner's explicit choice. 18+ channels stay 18+.
- An owner can't set a restriction above their own age (B11c §4.1, G-77).
- Lowering it never happens automatically (the G-77 decision).

**7. G-51 server icon**
- Upload, crop and remove the icon, using the image rules of B11e (scaled down; refused only above 25 MB or 40 MP).
- The icon shows in the rail and the header for every member, and the letter fallback meets AA contrast.

## Out of 0.6.0
G-79 tray (P2, after G-81), G-43 ownership transfer, roles in the UI.
