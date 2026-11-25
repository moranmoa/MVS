# "Update required": the read-only banner

- **Owner:** dev-ui (the banner and the disabled states), with voice-shell for main's gate. **Screenshots:** 560–569.
- **Follows the approved design note** `docs/design/required-update.md` (#577, TL and SL). The UI only reacts to the core's `getAppInfo().updateRequired` and the `update.required { version }` event. The trigger is "my running version is revoked by a signed manifest", never a new manifest field.
- **It isn't a full block: read-only is the default (TL amendment 1; the owner may still decide otherwise).** The app stays open on its own content, read-only, so nobody is locked out of their data while an update can't be fetched yet. Everything that writes or connects is disabled.
- **RU1 (SL):** while an update is required, the core signs nothing and stops sync. Update checks and downloads are its only network traffic. The UI never offers anything that would sign.

## 1. The banner

A full-width bar at the top of the app, under the title bar and above everything else. It has no close button and no "later".

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │ ⟳  צריך לעדכן את MVS                                [עדכון] [יציאה]   │
 │    עד העדכון אפשר לקרוא את מה שבמחשב הזה, אבל לא לשלוח או להתחבר.     │
 │    מורידים את העדכון… ███████░░░ 64%                 מה חדש · פרטים   │
 └───────────────────────────────────────────────────────────────────────┘
```

- **Colours:** `--warning-bg` with `--warning-text` (the B20 tokens, AA). It's a `role="region"` labelled by its title, and its first line is a `role="status"`.
- **Title:** `update.required.title` "צריך לעדכן את MVS" / "An update is required".
- **Line:** `update.required.body` "עד העדכון אפשר לקרוא את מה שבמחשב הזה, אבל לא לשלוח או להתחבר." / "Until you update, you can read what's on this computer, but not send or connect."
- **Buttons:**
  - `update.required.update` "עדכון" / "Update", the primary button. It's enabled once the download is ready, and it calls `restartToUpdate`. While downloading, it's disabled, and the progress shows instead.
  - `update.required.quit` "יציאה" / "Quit". It closes the app.
- **Links:**
  - `update.whatsNew` "מה חדש" (existing), for the signed notes;
  - "פרטים" / "Details", which expands the versions, `⁦{running} → {version}⁩`, LTR;
  - `update.required.manual` "הורדה ידנית" / "Download manually", through the open-in-browser prompt. It shows in the failed and not-available states.
- On a phone-width window, the buttons wrap under the text. The banner never covers the composer area.

## 2. States in the banner (the third line)

| State | Hebrew | English | Buttons |
| --- | --- | --- | --- |
| downloading | `מורידים את העדכון…` plus the percentage (`role="progressbar"`) | `Downloading the update…` | Update (disabled), Quit |
| ready | `העדכון מוכן.` | `The update is ready.` | **Update**, Quit |
| offline | `אי אפשר להגיע לעדכונים כרגע. כדאי לבדוק את החיבור לאינטרנט.` | `Can't reach updates right now. Check your internet connection.` | "לנסות שוב" / "Try again", Quit, manual |
| check-clock | `השעון במחשב לא מכוון, ולכן אי אפשר לאמת את העדכון. כדאי לתקן את השעה ולנסות שוב.` | `Your computer's clock is off, so the update can't be verified. Fix the time and try again.` | Try again, Quit |
| not available yet | `עדיין אין גרסה חדשה למחשב הזה. ממשיכים לבדוק כל רבע שעה.` | `There's no new version for this computer yet. We keep checking every 15 minutes.` | Quit, manual |
| failed | `העדכון לא הצליח. אפשר לנסות שוב, או להוריד ידנית.` | `The update didn't work. Try again, or download it manually.` | Try again, Quit, manual |

No error codes or URLs appear; details stay in the log.

## 3. Disabled actions

Everything main refuses with `update-required` is disabled in the UI, not hidden, so people see what's paused:
- **Disabled:** the composer, sending, editing, deleting, emoji reactions, join and leave, creating, invites, call buttons, and settings that sign (profile, server settings, roles).
- **Each control** keeps its place, with `aria-disabled="true"` and the reason on hover and focus (`aria-describedby`): `update.required.disabled` "צריך לעדכן את MVS כדי לעשות את זה." / "Update MVS to do this."
- **The composer** shows the same text as its placeholder, and it can't be typed in.
- **Still available:** reading, scrolling, search, copying text, local settings (theme, language, notifications), the app lock, and diagnostics.

## 4. During a call (SL: at most 30 minutes)

- The call goes on, and only its own media keeps flowing. RU1 applies at once.
- **The call bar** shows a one-line notice: `update.required.inCall` "צריך לעדכן את MVS. העדכון ייכנס לתוקף כשהשיחה תסתיים." / "An update is required. It applies when the call ends."
- **After 25 minutes:** `update.required.inCallSoon` "צריך לעדכן את MVS. השיחה תסתיים בעוד 5 דקות." / "An update is required. The call ends in 5 minutes." It's announced once (`role="status"`).
- **At 30 minutes** the call ends, and the banner (§1) applies. The end-of-call toast says why: `update.required.callEnded` "השיחה הסתיימה כי צריך לעדכן את MVS." / "The call ended because MVS needs an update."
- New calls can't start (§3).

## 5. Lock and start

- **App lock (G-78):** the lock screen comes first. The banner appears only after unlock, and the lock screen shows nothing about the update.
- **At start:** if `updateRequired` is already set, the app opens straight into the read-only state, with the banner, with no flash of enabled controls.
- **A reload can't leave it.** Only a restart into a version that isn't revoked clears it.

## 6. Accessibility

- When the banner appears, focus doesn't jump. It's announced once through its status line.
- The progress is announced at most every 25%. Reduced motion means no animated fill.
- The banner's buttons are 24px minimum (44px on touch), and they come first in Tab order after the title bar.

## 7. Acceptance criteria

1. With `updateRequired` set, the app shows its content read-only, with the banner. There's no close and no "later".
2. Sending, reacting, joining, calls and signing settings are disabled, with the reason on hover and focus. Reading, search and local settings still work.
3. Downloading leads to ready, and "Update" restarts into the new version. Offline, check-clock, not-available and failed each show their line and buttons.
4. In a call: the call-bar notice shows, then "…in 5 minutes" at 25 minutes. At 30 minutes the call ends, with its toast.
5. When locked, the lock screen comes first, and the banner shows only after unlock.
6. Reloading the page keeps the read-only state.

**Screenshots:** 560 `560-update-required-downloading-he`, 561 `561-update-required-ready-he`, 562 `562-update-required-offline-en-dark`, 563 `563-update-required-not-available-he`, 564 `564-update-required-in-call-soon-he`, 565 `565-update-required-composer-disabled-he`.
