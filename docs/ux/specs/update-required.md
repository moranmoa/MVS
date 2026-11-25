# "Update required" screen

- **Owner:** voice-shell, with the screen built in the UI. **Screenshots:** 560–569.
- **When:** the signed update manifest says this version is below the minimum the network needs, for example a release like B7-k (K2) that the owner marks as required (BOARD K2-req). This isn't the per-action `update-needed` message, where *other* members are on old versions (`server.updateNeeded`); this screen is about *my* version.
- **Open owner question:** whether a required update blocks the whole app, or only sending and syncing. This spec covers the blocking screen, plus the in-call exception, which is the conservative reading. If the owner chooses "read-only until updated", only §1's buttons change.
- **SL RU1 (core rule, whatever the owner decides):** while a required update is pending, the core stops all background signing: no messages, reactions, edits, profile or server records, relay offers or receipts. So even a "read-only" mode signs nothing. In read-only mode the composer and every action that would sign are disabled, with the reason `update.required.readOnly` "צריך לעדכן את MVS כדי לשלוח ולשנות דברים." / "Update MVS to send messages or make changes."

## 1. The screen

A full window that replaces the app, like the lock screen. It shows no server, channel or message content, and no names.

```
 ┌─────────────────────────────── MVS ───────────────────────────┐
 │                         [MVS logo 64]                         │
 │                    צריך לעדכן את MVS                           │
 │   הגרסה הזו כבר לא יכולה להתחבר לשרתים. העדכון שומר על          │
 │   החשבון, השרתים וההודעות שלך.                                 │
 │                                                               │
 │   מורידים את העדכון…  ███████░░░  64%                          │
 │                                                               │
 │            [ הפעלה מחדש ועדכון ]   (once it's downloaded)      │
 │                    מה חדש · הורדה ידנית                        │
 │                                                   0.4.9 → 0.5.1│
 └───────────────────────────────────────────────────────────────┘
```

- **The title:** `update.required.title` "צריך לעדכן את MVS" / "MVS needs an update".
- **The body:** `update.required.body` "הגרסה הזו כבר לא יכולה להתחבר לשרתים. העדכון שומר על החשבון, השרתים וההודעות שלך." / "This version can no longer connect to your servers. Updating keeps your account, servers and messages."
- **Progress:** "מורידים את העדכון…" / "Downloading the update…", with a `role="progressbar"` (`aria-valuenow`) and the percentage. It starts on its own; no button is needed to begin.
- **Once it's downloaded:** the primary button `update.required.restart` "הפעלה מחדש ועדכון" / "Restart and update". It has focus.
- **Links:**
  - `update.whatsNew` "מה חדש" (existing) opens the release notes in the app;
  - `update.required.manual` "הורדה ידנית" / "Download manually" opens the project's releases page through the existing "open in browser?" prompt. It's the way out if the in-app update fails.
- **Versions** at the bottom end, small and LTR: `⁦{running} → {required}⁩`.

## 2. States

| State | What shows |
| --- | --- |
| downloading | progress, as above |
| ready | `update.required.restart` |
| offline | `update.required.offline` "אין חיבור לאינטרנט. העדכון יתחיל כשהחיבור יחזור." / "No internet connection. The update starts when you're back online." It retries on its own; there's also "לנסות שוב" |
| failed (download or signature) | `update.required.failed` "העדכון לא הצליח. אפשר לנסות שוב, או להוריד את הגרסה החדשה ידנית." / "The update didn't work. Try again, or download the new version manually." Buttons: "לנסות שוב", plus the manual link, shown more prominently |
| in a call | §3 |

There are no error codes or URLs on the screen. Diagnostics stay in the log.

## 3. In a call

A required update never cuts off a call that's already going.

- While in a call, the app stays as it is, with a persistent bar above the call bar: `update.required.inCall` "צריך לעדכן את MVS. העדכון יותקן כשהשיחה תסתיים." / "MVS needs an update. It will install when the call ends." It reuses the update-pill colours (`--update`), has no close button, and is a `role="status"`.
- When the call ends, the full screen (§1) appears.
- Joining a new call isn't possible once the requirement is known. The join button shows the same text as its reason.

## 4. Lock and start

- **App lock (G-78):** the lock comes first. After unlock, this screen shows, never before it, so a locked app shows nothing about the update.
- **At start:** if the requirement is already known, the screen shows right after "טוענים…", with no flash of the app.

## 5. Accessibility

- The page is one `main` landmark with the title as `h1`. Focus starts on the primary button when there is one, otherwise on the title (`tabIndex=-1`).
- Progress is announced at most every 25% (`aria-live="polite"` on a separate line), not on every percent.
- Reduced motion: the progress bar fills without animation.

## 6. Strings (new)

`update.required.title`, `.body`, `.downloading`, `.restart`, `.manual`, `.offline`, `.failed`, `.inCall`, as above. `.downloading` is "מורידים את העדכון…" / "Downloading the update…".

## 7. Acceptance criteria

1. With a manifest minimum above the running version, the screen replaces the app, and no server or message text is in the DOM.
2. The download starts on its own. "הפעלה מחדש ועדכון" shows once it's ready, and it restarts into the new version.
3. Offline shows the offline line, and it recovers by itself when the connection returns.
4. A failed signature shows the failed state, with no technical detail on screen.
5. During a call, the call goes on with the bar showing. When the call ends, the full screen shows.
6. When locked, the lock screen comes first, and this screen comes only after unlock.

**Screenshots:** 560 `560-update-required-downloading-he`, 561 `561-update-required-ready-he`, 562 `562-update-required-failed-en-dark`, 563 `563-update-required-in-call-he`.
