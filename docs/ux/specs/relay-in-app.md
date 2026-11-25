# Relay in the app: consent screens

- **Builds on:**
  - `docs/design/relay-in-app.md` (#561, TL and SL approved; R1 → R2 → R3);
  - the SL's port-mapping conditions PM1–PM11 (shared notes, `sec-lead-port-mapping.md`);
  - the existing member-relay row and disclosure (#368, screenshots 410–419).
- **Owners:** dev-ui for the settings rows and the invite dialog; voice-shell for the shell side of port mapping, if any. The core decides every state; the UI only shows it.
- **Screenshots:** 530–539.
- **Rule for every string:** say plainly who sees what (an IP address, when someone is connected, how much data), and never call a user's computer a "server". A relay is "ממסר".

## 1. Where it lives: Settings → פרטיות → "ממסר לחברי השרתים"

The existing row gains a status line and two child rows:

```
 ממסר לחברי השרתים                                   [●  ]
   פועל: המחשב הזה נגיש מבחוץ ומשמש כממסר.            ← status (§2)
   מגבלה יומית   [2 GB (ברירת מחדל) ▾]                ← existing
   ┌───────────────────────────────────────────────┐
   │ פתיחת פורט בנתב                       [  ○]  │  ← §3, off by default
   │ MVS תבקש מהנתב לפתוח פורט אחד…               │
   ├───────────────────────────────────────────────┤
   │ הכתובת שלי בקישורי הזמנה              [  ○]  │  ← §4, off by default
   │ קישורי הזמנה שחברי השרתים יוצרים…            │
   └───────────────────────────────────────────────┘
```

- The child rows are indented (`padding-inline-start`) under the relay row, so it's clear they depend on it.
- **While the relay switch is off, or relaying isn't possible** (§2's reasons), both child switches are shown **disabled**, with the line "פועל רק כשהממסר לחברי השרתים פועל." / "Only works while the member relay is on." They aren't hidden, so people can find them.
- Turning the relay switch off turns nothing else on or off in storage. The child switches keep their own values, but they have no effect (and no port is mapped, PM4) until relaying is on again.
- **Under 18** (effective age, decided by the core): all three switches are disabled with the existing `memberRelay.reason.minor` "כבוי: זמין רק מגיל 18." There's no way to turn them on.

## 2. Relaying: status and reasons

The status line is a `role="status"` element under the switch. It shows one state from the core:

| State | Hebrew | English |
| --- | --- | --- |
| relaying (reachable, R1 proven) | `פועל: המחשב הזה נגיש מבחוץ ומשמש כממסר.` | `On: this computer is reachable and relays for members.` |
| checking (R1 dial-back pending) | `בודקים אם המחשב הזה נגיש מבחוץ…` | `Checking whether this computer can be reached…` |
| on but unreachable | `המתג פועל, אבל המחשב הזה לא נגיש מבחוץ, ולכן הוא לא משמש כממסר כרגע.` | `It's on, but this computer can't be reached from outside, so it isn't relaying right now.` |
| paused (on battery, or a metered connection) | `מושהה: המחשב עובד על סוללה או בחיבור עם מגבלת נתונים. הממסר יחזור לפעול כשזה ישתנה.` | `Paused: this computer is on battery or a metered connection. Relaying resumes when that changes.` |
| behind CGNAT (PM2) | `ספק האינטרנט לא מאפשר חיבורים נכנסים למחשב הזה, ולכן הוא לא יכול לשמש כממסר.` | `Your internet provider doesn't allow incoming connections to this computer, so it can't relay.` |

**Battery and metered are a pause, not a disabled switch (SL):** they change during the day, so the switch keeps the person's choice and stays enabled, and the status line says "paused" (above). The existing `memberRelay.reason.metered` is no longer used to disable the switch, and there's no `reason.battery`. The disabled reasons stay `minor`, `relayOnly` and `globalOff`. While paused, no port is mapped (PM1/PM4); the port-mapping status shows nothing until relaying resumes.

- When the address changes (PM9), the status goes back to "checking" until R1 proves it again. There's no separate message.
- When "unreachable" shows, add a link-button "מה אפשר לעשות?" / "What can I do?" that expands one line: "אפשר להפעיל 'פתיחת פורט בנתב' למטה, או לפתוח פורט ידנית בהגדרות הנתב." / "Turn on 'Open a port on my router' below, or open a port in your router's settings."

### The disclosure (extended)

The existing one-time dialog (`memberRelay.disclosure.*`) shows when relaying first becomes active. Its body now also says that timing and volume are visible (design §3). **Bump its stored key**, so everyone who saw the old text sees this one once.

- `memberRelay.disclosure.body`:
  - he: `חברי השרתים יכולים להתחבר דרך המחשב הזה כשאין להם חיבור ישיר זה לזה. הם יראו את כתובת ה-IP של המחשב הזה, והמחשב הזה יראה את הכתובות שלהם, מתי הם מחוברים וכמה נתונים עוברים. התוכן שהם שולחים לא קריא כאן. השימוש מוגבל ל-⁨{quota}⁩ ביום. אפשר לכבות את זה בהגדרות ← פרטיות.`
  - en: `Members of your servers can connect through this computer when they can't connect to each other directly. They'll see this computer's IP address, and this computer sees their addresses, when they're connected and how much data passes. What they send can't be read here. Use is limited to {quota} a day. You can turn this off in Settings → Privacy.`
- The buttons are unchanged ("הבנתי", "כיבוי").

## 3. Port mapping (PM1–PM11)

A child switch, **off by default**, only for an adult on desktop, with relaying on (PM1). It's never turned on automatically.

| Key | Hebrew | English |
| --- | --- | --- |
| `portMap.label` | `פתיחת פורט בנתב` | `Open a port on my router` |
| `portMap.hint` | `MVS תבקש מהנתב לפתוח פורט אחד, כדי שחברי השרתים יוכלו להגיע למחשב הזה. כתובת ה-IP של הבית תהיה אז גלויה לחברי השרתים שמתחברים דרך המחשב הזה.` | `MVS will ask your router to open one port so other members can reach you. Your home IP is then visible to the members you relay for.` |

The hint is always visible under the switch (it's the consent text, PM1).

**Status line** (`role="status"`, only while the switch is on):

| State | Hebrew | English |
| --- | --- | --- |
| asking | `מבקשים מהנתב…` | `Asking your router…` |
| on | `הפורט פתוח (⁦{port}⁩). בודקים שהמחשב נגיש…` then, once R1 proves it, `הפורט פתוח (⁦{port}⁩).` | `Port open ({port}). Checking that this computer can be reached…` / `Port open ({port}).` |
| refused | `הנתב לא אישר את הבקשה. אפשר לפתוח פורט ⁦{port}⁩ ידנית בהגדרות הנתב.` | `Your router didn't allow it. You can open port {port} in your router's settings.` |
| not possible (CGNAT, PM2) | `לא אפשרי בחיבור הזה: ספק האינטרנט לא מאפשר חיבורים נכנסים.` | `Not possible on this connection: your internet provider doesn't allow incoming connections.` |

- The `{port}` number is the only technical detail shown, always LTR (`⁦…⁩`). **No IP address appears anywhere in this UI** (PM11).
- "on" doesn't mean "reachable": the relay status (§2) still says "checking" until R1 proves it (PM5).
- Turning the switch off removes the mapping (PM4). The status line disappears; there's no toast.
- **Diagnostics panel** (G-81 panel style): one row, `מיפוי פורט: ⁨{state}⁩` / `Port mapping: {state}`, where state is one of `פועל` / `כבוי` / `נכשל (הנתב סירב)` / `לא אפשרי` (en `on` / `off` / `failed (router refused)` / `not possible`). No addresses.

## 4. "My address in invite links" (RR3, RR4, TL 1)

A separate child switch, **off by default**, never for a minor. It's separate from "I relay": relaying alone never puts an address in a link.

| Key | Hebrew | English |
| --- | --- | --- |
| `inviteAddr.label` | `הכתובת שלי בקישורי הזמנה` | `My address in invite links` |
| `inviteAddr.hint` | `קישורי הזמנה שחברי השרתים יוצרים יכולים לכלול את כתובת ה-IP של המחשב הזה, כדי שמי שמצטרפים יוכלו להתחבר גם בלי ממסר של MVS. כל מי שמחזיקים בקישור יכולים לראות את הכתובת, גם אם הוא מתפרסם ברבים. קישורים ששותפו כבר ימשיכו לכלול את הכתובת עד שהתוקף שלהם יפוג, גם אם המתג הזה יכובה.` | `Invite links that members create can include this computer's IP address, so people joining can connect even without an MVS relay. Anyone who has the link can see the address, even if it's posted publicly. Links already shared keep the address until they expire, even if you turn this off.` |

**Turning it on asks once more** (a small dialog), because the address can end up public:
- title: `להוסיף את כתובת המחשב הזה לקישורי הזמנה?` / `Add this computer's address to invite links?`
- body: `inviteAddr.hint` (the same text)
- buttons: `הוספה` / `Add` (primary) and `ביטול` / `Cancel`. Initial focus on Cancel, since the safe choice comes first here. Esc = Cancel.

Turning it off needs no confirmation. Links already shared keep the address until they expire (PM10), and the hint says so plainly (SL).

## 5. The invite dialog

When the core says the created link carries relay hints (≥ 1), the invite dialog shows one line under the link, in `--text-muted`, with an info icon (`aria-hidden`):

- `invite.hintsNote`: `הקישור הזה כולל כתובות IP של חברים שמשמשים כממסר. כדאי לשתף אותו רק עם מי שמזמינים.` / `This link includes the IP addresses of members who relay. Share it only with people you're inviting.`

With no hints, there's no line. The line never names who is listed.

## 6. Relay-only

Relay-only users never relay. All three switches are disabled with the existing `memberRelay.reason.relayOnly`. The relay-only switch's hint gets one more sentence, since a relaying member sees their IP (design §1, RR6):

- `relayOnly.memberNote`: `גם במצב הזה, מי שמשמשים כממסר בשבילך רואים את כתובת ה-IP שלך.` / `Even in this mode, whoever relays for you can see your IP address.`

## 7. Accessibility

- Every switch is a `role="switch"` with its label, plus `aria-describedby` pointing to its hint and its status line.
- The status lines are `role="status"` (polite). Changes are announced once, not on every recheck.
- Disabled switches keep their reason text visible and linked with `aria-describedby`, not as a tooltip only.
- The consent dialog in §4 is a focus-trapped `role="alertdialog"`, with initial focus on Cancel.

## 8. Acceptance criteria

1. A fresh adult account on desktop: relay follows #368's default; port mapping and invite addresses are off.
2. Under 18: all three switches are disabled with the 18+ reason, and no mapping or hint is ever created (core test).
3. Relay on but unreachable: the "unreachable" status, plus the "What can I do?" line.
3a. Relay on, then the laptop unplugs or joins a metered network: the switch stays on and enabled, and the status says "paused". It returns to "checking" or "relaying" when power or the network changes back.
4. Port mapping on: "asking", then "port open", while the relay status shows "checking" until the dial-back proves it.
5. A router refusal shows the manual-port line, with the port number LTR and no IP anywhere in the DOM.
6. CGNAT: the relay shows the provider line, and port mapping shows "not possible".
7. Turning on invite addresses asks first, with focus on Cancel. Cancel leaves it off.
8. An invite created with hints shows `invite.hintsNote`; one without doesn't.
9. The extended disclosure shows once more for someone who saw the old one.
10. Relay-only: all three switches are disabled, and the relay-only hint has the new sentence.

**Screenshots:**

| # | Shot | What it shows |
| --- | --- | --- |
| 530 | `530-relay-settings-active-he` | Relay on and active, both child switches off |
| 531 | `531-relay-unreachable-he` | Relay on, unreachable, with "What can I do?" expanded |
| 532 | `532-portmap-on-he` | Port mapping on, "port open", relay status "checking" |
| 533 | `533-portmap-refused-en-dark` | Router refused, with the manual-port line |
| 534 | `534-invite-addr-confirm-he` | The "Add this computer's address…" dialog |
| 535 | `535-invite-hints-note-he` | The invite dialog with `invite.hintsNote` |
| 536 | `536-relay-minor-he` | Under 18: all three disabled with the reason |
| 537 | `537-relay-cgnat-en-dark` | CGNAT: the provider line, and port mapping not possible |
