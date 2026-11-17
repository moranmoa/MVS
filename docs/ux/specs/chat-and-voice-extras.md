# Chat and voice extras – typing, reactions, picker, voice controls, push-to-talk

- **Gaps:** G-29 (typing), G-26 (reactions), G-27 (emoji picker), G-72 (devices), G-73 (per-person volume), G-84 (deafen), G-74 (push-to-talk). See `docs/ux/GAPS.md`.
- **Builds on:** B25 (context menus), voice-rooms.md and #224/#239 (call bar, roster), and B17 (FSI around names).
- **Screenshots:** 440–459.

## 1. "Is typing…" (G-29)

- **Signal:** ephemeral, member-gated, never stored or logged. Sent at most once every 3 s while the composer has text and keys are being pressed. It expires 6 s after the last keystroke, or at once on send or when the composer is cleared. Only for the channel I'm in.
- **Display:** one muted line directly above the composer (it takes its height only while shown, so the layout doesn't jump: reserve 1.25rem).

| Who | Hebrew | English |
| --- | --- | --- |
| 1 | `⁨{name}⁩ באמצע כתיבה…` | `⁨{name}⁩ is typing…` |
| 2 | `⁨{a}⁩ ו-⁨{b}⁩ באמצע כתיבה…` | `⁨{a}⁩ and ⁨{b}⁩ are typing…` |
| 3+ | `כמה אנשים כותבים…` | `Several people are typing…` |

  "באמצע כתיבה" is a noun phrase, and "כותבים" is plural, so both are gender-neutral.
- **Animation:** three dots. Static under `prefers-reduced-motion`.
- **Screen readers:** not announced (`aria-live="off"`), because it's too noisy.
- **Privacy:** a Settings → Privacy switch, "הצגת חיווי כתיבה לאחרים" / "Show others when I'm typing", on by default. When off, I don't send the signal, but I still see others'.
- **Blocked accounts:** their typing isn't shown.

## 2. Reactions (G-26)

- **Data:** a signed record per (message, emoji, me), which synced members see. Unicode emoji only in v1; server-custom emoji are phase 2.
- **Pills:** under the message, in a row that wraps: the emoji and a count (`<bdi dir="ltr">`). If I reacted, the pill has an accent border and an accent-soft background. Click toggles my reaction.
- **Tooltip and accessible name:** "⁨{emoji}⁩ · ⁨{names}⁩", up to 10 names, then "ועוד ⁨{n}⁩" / "and ⁨{n}⁩ more". Use `Intl.ListFormat`.
- **Adding:**
  - a smiley-plus button in the message hover toolbar;
  - **"הוספת אמוג'י"** in the message context menu (B25 §2). Not "תגובה", which already means reply;
  - a "+" pill at the end of an existing pill row.
  All three open the picker (§3).
- **Limits:** up to 20 different emoji per message. Past that, the "+" pill and the menu item are hidden, and the existing pills still toggle.
- **Deleted message:** no pills. **Blocked accounts:** their reactions are counted, but their names aren't listed (product-lead, #426).
- **Keyboard:** the pills are buttons inside the message's roving focus. Enter or Space toggles.

## 3. Emoji picker (G-27)

```
 ┌───────────────────────────────┐
 │ 🔍 חיפוש אמוג'י               │
 │ אחרונים                       │
 │ 😂 👍 ❤️ 🔥 …                  │
 │ סמיילים ואנשים                 │
 │ 😀 😃 😄 😁 😆 😅 🤣 😂        │
 │ …                             │
 │ [😀][🐶][🍔][⚽][✈️][💡][🔣][🏳️] │  ← category tabs
 └───────────────────────────────┘
```

- **A popover anchored to its trigger,** 8 columns, about 352×400px. On a phone (<40rem) it's a bottom sheet.
- **Search** on top, with focus there when it opens. It matches English CLDR names plus Hebrew keywords when available. Results replace the grid. With no match: "לא נמצא אמוג'י" / "No emoji found".
- **Recent:** the 24 most recent, local only, stored in app settings.
- **Keyboard:** ↓ from search enters the grid; arrows move (mirrored in RTL); Enter picks; Esc closes and returns focus to the trigger. Tab moves between search, grid and category tabs.
- **Also from the composer:** a smiley button in the composer inserts at the cursor and keeps the picker open with Shift+click.
- **Accessible name of each cell:** the emoji's name in the UI language (CLDR), for example "פרצוף צוחק".
- Skin tones and custom emoji are later items.

## 4. Voice settings (G-72) – Settings → "קול"

| Control | Behaviour |
| --- | --- |
| **מיקרופון** | A select from `enumerateDevices()`, with "ברירת המחדל של המערכת" first. Changing it mid-call switches the track live |
| **בדיקת מיקרופון** | A live input meter (a bar, with no numbers) while the page is open, with `role="meter"`. A switch "השמעה עצמית" (off by default) plays my mic back to me |
| **רמקולים** | Output select (`setSinkId`). "השמעת צליל בדיקה" plays a short sound on that device |
| **אופן הדיבור** | Radio: "פתוח לדיבור" (default) / "לחיצה לדיבור" (§6) |

- **Mic gate (V-C2, sec-lead): option (a).** The shell allows `getUserMedia` only during a call, so **the full controls live in the in-call Voice dialog** (call bar, #429). Settings → "קול" outside a call shows the speaker picker and "השמעת צליל בדיקה" (no mic needed), plus a line instead of the meter: "אפשר לבדוק את המיקרופון בזמן שיחה." / "You can test your microphone during a call." Device names appear once the mic has been allowed in a call. There's no separate mic-test permission window (it would need a sec-lead review).
- **Device unplugged mid-call:** fall back to the system default, with a toast naming the device: `call.micUnplugged` (and the speaker equivalent, plus a no-name version), as built in #436

## 5. In-call controls

**Per-person volume (G-73):** right-click a person in the room roster (B25) → a "עוצמה" slider, 0–200% in 10% steps (above 100% needs a Web Audio gain path in `ui/src/voice`, voice-d; until then 0–100% is acceptable as a first step), with the value shown as `⁨{n}⁩%`. "השתקה אצלי" sets it to 0. Local only, remembered per userId across calls. There's no slider for myself.

**Deafen (G-84):** a headphones button in the call bar, between mute and hang-up, at 44px, with `aria-pressed` and the label "השתקת השמע" / "Deafen".
- On: all incoming audio is muted and my mic is forced off.
- Off: my mic returns to its state before deafening.
- Others see a crossed-headphones icon next to my name (a signalling flag, so it needs voice-c and core).

## 6. Push-to-talk (G-74)

- **Mode** in Settings → "קול": "לחיצה לדיבור". Below it, a key-capture field: "מקש לדיבור", with "לחיצה על מקש…" and the chosen key shown as `<kbd>`. Esc cancels the capture.
- **Default key:** none. The mode needs a key before it turns on.
- **Behaviour:** hold the key to talk, with a 200 ms release delay. While held, my mic icon shows active (accent) and others see me speaking as usual. In PTT mode the mute button still works as a hard mute.
- **v1 scope: only while the MVS window is focused.** Electron's `globalShortcut` fires on key-down only, so true hold-to-talk can't be built on it. Global PTT needs a native input hook (for example uiohook) and a **sec-lead review**, since it's a system-wide keyboard listener. Until then, show a line under the field: "עובד כשחלון MVS פעיל." / "Works while the MVS window is active."
- **Losing focus counts as releasing the key** (voice-shell). If the window loses focus while the key is held, the key-up never arrives. So blur is treated as a release, after the same 200 ms, and the mic goes back to muted. Otherwise Alt+Tab with the key held would leave the mic open.
- **Optional global key in v1: toggle mute, not hold.** `globalShortcut` does fire on press while unfocused, so a separate "מקש השתקה גלובלי" / "Global mute toggle" (press to toggle mute) works without any keyboard listener. Off by default, with no key set.
- **Shell wiring:** focused key-down and key-up come from `webContents` `before-input-event` (so it works with focus in a text field). The shell emits `ptt.down` / `ptt.up`, and the voice engine flips the mic.

## 7. Strings (new)

| Key | Hebrew | English |
| --- | --- | --- |
| `typing.one` | `⁨{name}⁩ באמצע כתיבה…` | `⁨{name}⁩ is typing…` |
| `typing.two` | `⁨{a}⁩ ו-⁨{b}⁩ באמצע כתיבה…` | `⁨{a}⁩ and ⁨{b}⁩ are typing…` |
| `typing.many` | `כמה אנשים כותבים…` | `Several people are typing…` |
| `privacy.typing` | `הצגת חיווי כתיבה לאחרים` | `Show others when I'm typing` |
| `reactions.add` | `הוספת אמוג'י` | `Add reaction` |
| `reactions.more` | `ועוד ⁨{n}⁩` | `and ⁨{n}⁩ more` |
| `emoji.search` | `חיפוש אמוג'י` | `Search emoji` |
| `emoji.recent` | `אחרונים` | `Recent` |
| `emoji.none` | `לא נמצא אמוג'י` | `No emoji found` |
| `voice.settings` | `קול` | `Voice` |
| `voice.mic` | `מיקרופון` | `Microphone` |
| `voice.speaker` | `רמקולים` | `Speakers` |
| `voice.systemDefault` | `ברירת המחדל של המערכת` | `System default` |
| `voice.micTest` | `בדיקת מיקרופון` | `Mic test` |
| `voice.playTest` | `השמעת צליל בדיקה` | `Play test sound` |
| `voice.needPermission` | `צריך לאשר גישה למיקרופון` | `Allow microphone access` |
| `call.micUnplugged` | `המיקרופון ⁨{name}⁩ נותק. עוברים לברירת המחדל של המערכת.` | `Microphone ⁨{name}⁩ was unplugged. Using the system default.` |
| `voice.micTestInCall` | `אפשר לבדוק את המיקרופון בזמן שיחה.` | `You can test your microphone during a call.` |
| `voice.mode` | `אופן הדיבור` | `Input mode` |
| `voice.mode.open` | `פתוח לדיבור` | `Voice activity` |
| `voice.mode.ptt` | `לחיצה לדיבור` | `Push to talk` |
| `voice.pttKey` | `מקש לדיבור` | `Push-to-talk key` |
| `voice.pttCapture` | `לחיצה על מקש…` | `Press a key…` |
| `voice.pttFocusOnly` | `עובד כשחלון MVS פעיל.` | `Works while the MVS window is active.` |
| `voice.globalMute` | `מקש השתקה גלובלי` | `Global mute toggle` |
| `call.volume` | `עוצמה` | `Volume` |
| `call.localMute` | `השתקה אצלי` | `Mute for me` |
| `call.deafen` | `השתקת השמע` | `Deafen` |

## 8. Acceptance criteria

1. **Typing:** A types and B sees "A באמצע כתיבה…" within 1 s. It disappears within 6 s of A stopping, and at once on send. With the privacy switch off, B sees nothing.
2. **Three people typing** shows "כמה אנשים כותבים…". The composer doesn't move.
3. **Reaction:** clicking 👍 on a message shows "👍 1" with my highlight on both computers. Clicking again removes it.
4. **20 different emoji** on one message hide "+" and "הוספת אמוג'י".
5. **Picker:** typing "laugh" (or "צחוק") finds 😂. Enter picks; Esc returns focus to the trigger. Recent shows it first next time.
6. **Mic switch** mid-call moves the track with no reconnect, and others keep hearing me.
7. **Volume:** a 0% slider on B mutes B only for me, and it persists across calls.
8. **Deafen:** on means I hear nobody and my mic is off. Off restores my previous mute state. Others see the deafened icon.
9. **PTT:** with the window focused, holding the key transmits and release stops after about 200 ms. With the window unfocused, nothing is sent, and the hint line is shown. Alt+Tab while holding the key mutes the mic within about 200 ms.
10. **Reduced motion:** the typing dots are static.

**Screenshots:**

| # | Shot | What it shows |
| --- | --- | --- |
| 440 | `440-typing-he` | Typing line above the composer, one person |
| 441 | `441-reactions-he` | A message with 3 pills, one mine highlighted, and the tooltip |
| 442 | `442-emoji-picker-he` | The picker with search and recent |
| 443 | `443-voice-settings-he` | Settings → קול with the meter |
| 444 | `444-volume-menu-he` | The roster context menu with the volume slider |
| 445 | `445-call-bar-deafen-he` | The call bar with deafen on |
| 446 | `446-ptt-setting-he` | The PTT mode with a captured key |
| 447 | `447-voice-dialog-he` | The in-call Voice dialog (call bar): mic, speakers, meter, "השמעה עצמית" |
