# Closed alpha: tester plan

Nov 25, 2026 · business agent · builds on `docs/business/plan-1.md` (§1), `docs/business/alpha-invite-pack.md` and `docs/design/relay-in-app.md` (§4, R5). Tester-facing texts stay in the invite pack and `docs/release/ALPHA-QUICKSTART.md`; this page is the plan.

**In one line:** about 30 testers in Israel, aged 16+, recruited as small friend groups in three waves over 8 weeks, starting with 0.5.0. They install from the GitHub pre-release and report in a testers' server inside MVS. We measure join success and collect the field data the tech lead needs before our relays can be removed. No telemetry: every number comes from what testers choose to send.

## 1. Who and how many

| Wave | Who | How many | Starts |
| --- | --- | --- | --- |
| 0 | People the owner knows, technical, on at least two networks | 3–5 | 0.5.0 published |
| 1 | Israeli tech, PC-hardware and Linux communities (with each admin's OK) | 10–15 | Week 2, if wave 0 has no blocker |
| 2 | Whole gamer friend groups of 4–8 | 3–4 groups (15–25) | Week 4, after one update shipped cleanly |

- **Total:** 30–45 people. Hard cap 50, so every report gets read.
- **Israel only:** recruit only in Israeli channels and send the invite only to people who confirm they live in Israel. The legal drafts in plan-1 §3 assume Israeli law; anywhere else needs the lawyer's check first.
- **16+:** the sign-up form asks for a yes/no age confirmation (never a birth date), and the app's age check (B7, minimum 16) applies on top. Don't recruit in youth forums.
- **Mix we need:** Windows and Linux only (macOS waits for R8). At least 5 testers on cellular or a work network and, if possible, a few on ISP CGNAT, so the network data covers all three home types (open IP, home router, CGNAT).
- **Sign-up form:** nickname, OS, group size, the 16+ and Israel confirmations, one contact. Nothing else, and it's deleted at the end of the alpha (plan-1 §1.5).

## 2. Install

1. The welcome message links to the **GitHub pre-release** of the current version (`moranmoa/MVS`, Releases) and to `ALPHA-QUICKSTART.md`.
2. Windows: `setup.exe`, per-user, no admin. It shows a SmartScreen warning until signing lands (the quickstart shows how to get past it). Linux: AppImage or `.deb`.
3. The tester creates an account, writes the 12 words on paper and joins the **testers' server** from the invite link.
4. Later versions arrive through in-app update once the owner signs them. Until then, testers install the new version over the old one; announcements go in `#announcements`.

## 3. Bug reports

| Where | What for |
| --- | --- |
| `#bugs` in the testers' server | Default: what you did, what you expected, what happened, OS and version. Attach the diagnostics file (Settings → Diagnostics → "ייצוא קובץ אבחון"). |
| GitHub Issues on `moranmoa/MVS` | Testers comfortable with GitHub, and anyone who can't open the app at all |
| The invite channel (WhatsApp/Telegram) | Fallback when the app won't start and the tester has no GitHub |

- **Never in a screenshot:** the 12 words. The welcome message and `#bugs` topic say so.
- **Triage:** QA moves reports to `docs/BOARD.md` within a day; the product lead sets priority; P0s block the next release.
- **Weekly survey:** questions 1–5 from the invite pack (§3), plus question 6 below. The full set comes in the end survey.

## 4. What we measure

All sources are opt-in: the testers' server, surveys, diagnostics files the testers export, and the relay's in-memory aggregate counters (no connection logs, plan-1 §3.2).

**Product (from plan-1 §1.7):**

| Metric | Target | Source |
| --- | --- | --- |
| Join success: invite opened → member of the server, first try | ≥ 90% | Testers' server + survey Q6 |
| Join success on a second device or network (laptop, phone hotspot) | ≥ 80% | Survey Q6 + diagnostics files |
| Active testers in week 4 | ≥ 60% | Testers' server + survey |
| Groups still writing in week 4 (3+ members in that week) | ≥ 50% of groups | Group lead's report |
| Crashes | < 1 per tester per week | Reports |
| Successful updates (once signed) | ≥ 98%, nobody stuck | Reports + version in the testers' server |

New survey question 6 (weekly): *"Did joining a server or opening an invite fail this week? On which network?"* (No / Yes, home / Yes, cellular or work / Yes, other)

**Network field data for relay-in-app (R5):** the tech lead needs this before our relays can be removed. Collect it across **two releases**, as the design asks.

| Data | Why | Source |
| --- | --- | --- |
| Connection path per join, sync and call: direct, hole-punched, member relay or our relay | Removal needs member relays plus the cache to carry about 95% of sessions | Diagnostics files (QA's path log), relay counters |
| Each tester's reachability type: open IP, home NAT (mapped or not), CGNAT | Sizes the owner's model of open homes serving and CGNAT homes as clients only | Diagnostics files, once R1 reports it |
| **Servers with zero reachable members** | Such a server has no relay once ours are gone (TL 2) | Group leads + diagnostics files from at least one member per group |
| Relay-only testers and whether they connect | Relay-only users keep our relays first while ours exist (RR6) | Survey + diagnostics files |

**Asks for the dev team (not in this PR):**

- The diagnostics file should contain the path type and the reachability result with no IPs, so testers can share it safely.
- Testers may need a "send weekly network summary" button in the app, opt-in and off by default, with nothing more than the table above.

QA owns the path log; business sums it up in the weekly report.

## 5. Timeline

Week 1 starts the day 0.5.0 is published as a pre-release.

| Week | Milestone |
| --- | --- |
| 0 | Testers' server ready; invite pack and quickstart links checked; sign-up form live |
| 1 | Wave 0 installs. Fix the embarrassing bugs |
| 2 | Wave 1 invited (go if there's no P0 open). First weekly report |
| 3 | First signed update, or install over the old version if signing isn't ready |
| 4 | Wave 2: friend groups, with a 15-minute setup call each |
| 5 | R1 build to testers if it's ready: reachability data starts |
| 6 | Group interviews (2–3 groups) |
| 7 | Second release with R1/R2: second round of network data |
| 8 | End survey. Go/no-go for the open alpha (plan-1 §1.8), plus the network data summary for R5 |

**Weekly report to the owner (one page):** metrics, the top three problems, the network table, open decisions.

**Stop or slow down:** if any of these happens, pause invites and fix first:
- a data-loss bug;
- a security finding;
- join success below 70% for two weeks;
- a broken update.

## 6. Open points

| # | Point | Owner | Recommendation |
| --- | --- | --- | --- |
| 1 | Does the diagnostics file already hold the path type and reachability, with no IPs? | dev-sync, QA | Add both before week 5 |
| 2 | Testers' server host: whose PC keeps it reachable? | owner | The owner's PC plus two wave-0 testers, so the server is never empty |
| 3 | GitHub Issues template for testers | QA | One short template, English with a Hebrew hint |
| 4 | When and how much do we tell testers about relay-in-app (their IP visible to the relaying member)? | product lead | Notice v3 in the app before R2 reaches testers |
