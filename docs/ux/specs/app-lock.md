# App lock screens (G-78)

- **Builds on:** the design note `docs/design/app-lock.md` (SL and TL approved). It sets what is enforced and where. This spec is only what people see: the lock screen, the in-call overlay, the "Loading…" screen and the settings.
- **Owner:** dev-ui. The shell (#473) and core (#476) parts are separate. **Screenshots:** 460–469.

## 1. The lock screen (path A, `?locked`)

```
 ┌──────────────────────── MVS ─────────────────────────┐
 │                                                      │
 │                    [MVS logo 64]                     │
 │                  MVS נעולה                           │
 │                                                      │
 │          [ ••••••                    ] 👁            │  ← autofocus
 │          [        פתיחה        ]                     │
 │          [ פתיחה עם Windows Hello ]   (only if on)   │
 │                                                      │
 │          שכחת את הקוד? פתיחה עם 12 המילים            │  ← link button
 │                                            0.4.8     │
 └──────────────────────────────────────────────────────┘
```

- **Background:** `--bg-app`, a centred column 320px wide. The title bar (desktop-chrome) shows "MVS" only, with no server name.
- **Nothing personal on it:** no name, avatar, identity code, server, count or notification. The version (from `getAppInfo`) sits small at the bottom end.
- **The field:** a password input (`autocomplete="current-password"`, so a password manager can fill it), with a show/hide toggle (`aria-pressed`). If the passcode is digits only, use `inputmode="numeric"`. The field is LTR (`dir="ltr"`) in both languages.
- **Enter submits.** While checking, the button shows "בודקים…" and is disabled, for at least 300 ms so a fast answer doesn't flash.
- **Wrong:** the field is cleared and stays focused, with "הקוד שגוי." under it (`role="alert"`, linked with `aria-describedby`). No shake animation (reduced motion), just the message and a red field border plus the icon (not colour alone).
- **Rate-limited:** the field and button are disabled, with "יותר מדי ניסיונות. אפשר לנסות שוב בעוד ⁨{time}⁩." The time counts down in whole seconds or minutes (`1:30`), updated once a second in the text but announced only at start and at the end (`aria-live="polite"` on a separate line saying "אפשר לנסות שוב."). The 12-words link stays available.
- **OS method** (later, Windows Hello or Touch ID): when it's on, the screen starts the OS prompt once on show. Cancelling it leaves the passcode field focused. The button lets you start it again.

### Forgot: 12 words

- The link opens the existing recovery-words entry (B19 layout, 12 fields, paste spreads them) inside the lock screen, titled "פתיחה עם 12 המילים", with "המילים מבטלות את הנעילה. הקוד יימחק, ואפשר להגדיר חדש בהגדרות." above it.
- Buttons: "פתיחה" and "חזרה". Wrong words: "המילים לא מתאימות לחשבון במחשב הזה." Rate limits show as above.
- On success, the app opens (unlocked), and the lock is off. A one-time toast: "הנעילה בוטלה. אפשר להגדיר קוד חדש בהגדרות ← פרטיות."

## 2. Loading (`?locked=pending`)

- The logo and "טוענים…" in the centre, nothing else. It must look like a normal start, not like an error.
- After 10 s with no answer, it becomes the lock screen (fail closed). If the core is down, the T8-01 screen is reachable as today.

## 3. Locked during a call (path B overlay)

```
 ┌──────────────────────────────────────────────────────┐
 │                    [MVS logo 64]                     │
 │                  MVS נעולה                           │
 │    ┌──────────────────────────────────────────┐      │
 │    │ 🔊 בשיחה · 4 משתתפים · המיקרופון כבוי    │      │  ← no names, no room name
 │    │                    [ יציאה מהשיחה ]      │      │
 │    └──────────────────────────────────────────┘      │
 │          [ ••••••                    ] 👁            │
 │          [        פתיחה        ]                     │
 │          שכחת את הקוד? פתיחה עם 12 המילים            │
 └──────────────────────────────────────────────────────┘
```

- **Same screen as §1**, opaque (`--bg-app`, no blur of the content behind), plus a call card above the field.
- **Call card:** a speaker icon, the count as `lock.call.inCall` (gender-neutral: "אנשים", not "משתתפים"), and "המיקרופון כבוי" with a crossed-mic icon. No names, no room or server name, and no speaking ring.
- **"יציאה מהשיחה"** (secondary, red text) leaves at once, without a confirmation: the lock is the reason to be careful, and leaving is safe. The screen then reloads to §1 (path A).
- **Focus** is trapped in the overlay (field, show toggle, Unlock, 12-words link, Leave). Tab never reaches the app behind it.
- **After unlock:** the app is back as it was, with the mic still off and a toast: "המיקרופון עדיין כבוי. אפשר להפעיל אותו בסרגל השיחה." The call bar's mute button has focus.

## 4. Settings → פרטיות → "נעילת האפליקציה"

| Control | Behaviour |
| --- | --- |
| **נעילת האפליקציה** switch | Off by default. Turning it on opens "הגדרת קוד" (below). Turning it off asks for the current code |
| **נעילה אחרי חוסר פעילות** | Select: 1, 5 (default), 15, 30, 60 דקות. Hint: "לא ננעל בזמן שיחה." |
| **נעילה כשהמחשב ננעל או נכנס לשינה** | Switch, on by default |
| **שינוי הקוד** | Button. Asks for the current code, then the new one twice |
| **Windows Hello / Touch ID** | Only when available (later). Needs a code first |

- Under the controls, always visible when the lock is on (the §1 disclaimer, short):
  - "הנעילה מסתירה את MVS ממי שיושב ליד המחשב. היא לא מצפינה את הנתונים במחשב: לשם כך כדאי להפעיל הצפנת דיסק (BitLocker)."
  - "בזמן שיחה, השיחה ממשיכה מאחורי הנעילה, ואפשר לשמוע אותה."
- Changes to these controls, while the lock is on, ask for the current code once per visit to the page.

### "הגדרת קוד" dialog

- Two password fields: "קוד חדש" and "שוב, לאימות". The hint under the first: "4–12 ספרות, או משפט של 6 תווים ומעלה. מומלץ 6 ספרות לפחות."
- Errors under the field: too short, too long, "הקודים לא זהים."
- One line above the buttons: "אם שוכחים את הקוד, אפשר לפתוח עם 12 המילים."
- Buttons: "שמירה" / "ביטול".

## 5. "נעילה עכשיו"

- In the user menu (my panel), after the settings item, with the lock icon and the shortcut shown at the end (`Ctrl+L`, or what the TL settles on). Only shown when the lock is on.
- When the lock is off, the menu has no item. The settings page is where it starts.

## 6. Strings

| Key | Hebrew | English |
| --- | --- | --- |
| `lock.title` | `MVS נעולה` | `MVS is locked` |
| `lock.passcode` | `קוד` | `Passcode` |
| `lock.show` / `lock.hide` | `הצגת הקוד` / `הסתרת הקוד` | `Show passcode` / `Hide passcode` |
| `lock.unlock` | `פתיחה` | `Unlock` |
| `lock.checking` | `בודקים…` | `Checking…` |
| `lock.wrong` | `הקוד שגוי.` | `Wrong passcode.` |
| `lock.rateLimited` | `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ⁨{time}⁩.` | `Too many tries. Try again in {time}.` |
| `lock.retryNow` | `אפשר לנסות שוב.` | `You can try again.` |
| `lock.os` | `פתיחה עם ⁨{method}⁩` | `Unlock with {method}` |
| `lock.forgot` | `שכחת את הקוד? פתיחה עם 12 המילים` | `Forgot it? Unlock with your 12 words` |
| `lock.words.title` | `פתיחה עם 12 המילים` | `Unlock with your 12 words` |
| `lock.words.body` | `המילים מבטלות את הנעילה. הקוד יימחק, ואפשר להגדיר חדש בהגדרות.` | `Your words turn the lock off. The passcode is removed, and you can set a new one in Settings.` |
| `lock.words.wrong` | `המילים לא מתאימות לחשבון במחשב הזה.` | `These words don't match the account on this computer.` |
| `lock.words.done` | `הנעילה בוטלה. אפשר להגדיר קוד חדש בהגדרות ← פרטיות.` | `The lock is off. You can set a new passcode in Settings → Privacy.` |
| `lock.loading` | `טוענים…` | `Loading…` |
| `lock.call.inCall` | `{count, plural, one {אדם אחד} two {שני אנשים} other {# אנשים}} בשיחה` | `{count, plural, one {1 person} other {# people}} in the call` |
| `lock.call.micOff` | `המיקרופון כבוי` | `Your mic is off` |
| `lock.call.leave` | `יציאה מהשיחה` | `Leave call` |
| `lock.call.stillMuted` | `המיקרופון עדיין כבוי. אפשר להפעיל אותו בסרגל השיחה.` | `Your mic is still off. Turn it on from the call bar.` |
| `lock.now` | `נעילה עכשיו` | `Lock now` |
| `settings.lock.title` | `נעילת האפליקציה` | `App lock` |
| `settings.lock.idle` | `נעילה אחרי חוסר פעילות` | `Lock when idle` |
| `settings.lock.idleMinutes` | `{n, plural, one {דקה} two {שתי דקות} other {# דקות}}` | `{n, plural, one {1 minute} other {# minutes}}` |
| `settings.lock.idleHint` | `לא ננעל בזמן שיחה.` | `Never locks during a call.` |
| `settings.lock.onSleep` | `נעילה כשהמחשב ננעל או נכנס לשינה` | `Lock when the computer locks or sleeps` |
| `settings.lock.change` | `שינוי הקוד` | `Change passcode` |
| `settings.lock.disclaimer` | `הנעילה מסתירה את MVS ממי שיושב ליד המחשב. היא לא מצפינה את הנתונים במחשב: לשם כך כדאי להפעיל הצפנת דיסק (BitLocker).` | `The lock hides MVS from anyone at your computer. It doesn't encrypt your data on it: for that, turn on disk encryption (BitLocker).` |
| `settings.lock.disclaimerCall` | `בזמן שיחה, השיחה ממשיכה מאחורי הנעילה, ואפשר לשמוע אותה.` | `During a call, the call keeps going behind the lock, and you can still hear it.` |
| `settings.lock.set.title` | `הגדרת קוד` | `Set a passcode` |
| `settings.lock.set.new` | `קוד חדש` | `New passcode` |
| `settings.lock.set.confirm` | `שוב, לאימות` | `Again, to confirm` |
| `settings.lock.set.hint` | `4–12 ספרות, או משפט של 6 תווים ומעלה. מומלץ 6 ספרות לפחות.` | `4–12 digits, or a phrase of 6 characters or more. 6 digits or more is best.` |
| `settings.lock.set.mismatch` | `הקודים לא זהים.` | `The passcodes don't match.` |
| `settings.lock.set.forgotNote` | `אם שוכחים את הקוד, אפשר לפתוח עם 12 המילים.` | `If you forget it, you can unlock with your 12 words.` |
| `settings.lock.current` | `הקוד הנוכחי` | `Current passcode` |

On macOS the disclaimer says FileVault instead of BitLocker, and on Linux "הצפנת דיסק" alone (`{os}` select).

## 7. Acceptance criteria

1. The lock screen and the "Loading…" screen show no name, server, avatar, count or message text (DOM check in e2e).
2. Wrong code: message, cleared field, focus kept. 5 wrong: the countdown, with the field disabled, and it survives a restart.
3. Forgot → 12 words → unlocked, with the lock off and the toast.
4. Lock during a call: the overlay shows the count and "mic off" with no names. Leave reloads to the plain lock screen. Unlock returns to the call with the mic still off and the toast.
5. Keyboard only: Tab cycles within the lock screen or overlay; Enter unlocks.
6. Settings: turning the lock on requires setting a code; turning it off or changing anything asks for the current code.

**Screenshots:**

| # | Shot | What it shows |
| --- | --- | --- |
| 460 | `460-lock-screen-he` | The lock screen, Hebrew, light |
| 461 | `461-lock-wrong-he` | After a wrong code |
| 462 | `462-lock-rate-limited-he` | The countdown |
| 463 | `463-lock-in-call-he-dark` | The in-call overlay, dark |
| 464 | `464-lock-words-he` | Forgot → 12 words |
| 465 | `465-lock-settings-he` | Settings → Privacy → App lock, with the disclaimer |
| 466 | `466-lock-set-passcode-en` | The "Set a passcode" dialog, English |
