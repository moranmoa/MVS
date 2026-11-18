# System tray: product note (for a PO decision)

Status: **deferred to P2**. The product lead decided on #358: no tray in the
alpha, and minimizing goes to the taskbar. The tray comes after calls across
networks (G-81), when people will close the window mid-call. This note is the
design for then; nothing is built until the PO picks an option.
Owner: dev-voice-shell (shell); dev-ui (one setting and its strings).
Platforms we ship: Windows (NSIS) and Linux (AppImage, deb).

## Why it matters for MVS

Today closing the window quits MVS; during a call the page asks first. With
MVS quit, nothing arrives: there's no server, so messages reach you only
while your app runs (or later, from peers or the relay). It also means no
desktop notifications (G-61) and no taskbar count (G-62). Chat apps usually
keep running in the tray, and many users expect that. For a peer-to-peer
app it also keeps you available for sync.

The cost is a background process people may not know is running: memory,
network and battery use, and an app that "won't close".

## Options

| | What closing the window does | Tray icon |
| --- | --- | --- |
| **A. No tray** (today) | Quits (asks during a call) | none |
| **B. Tray, opt-in** | Quits, unless "Keep running in the tray when closed" is on (Settings → General, off by default) | shown only when the setting is on |
| **C. Tray, on by default (Windows)** | Hides to the tray; the first time, a one-off notice says "MVS is still running. Quit from the tray icon." Linux: as B | always on Windows; Linux as B |

**Recommendation: C on Windows, B on Linux** (the reason is below). If the PO prefers to keep it simple, B on both platforms is the safe first step.

## Behaviour (options B and C)

- **Tray menu** (main builds it; nothing from page content):
  - Open MVS
  - Mute / Unmute (only during a call)
  - Lock now (only when the app lock is on, G-78)
  - Quit MVS
- **Click** on the icon (Windows): show and focus the window. Linux can't rely
  on clicks (see below), so "Open MVS" is always the first menu item.
- **Unread dot:** the tray icon gets a small dot when there's anything unread.
  It shows no number: the exact count stays on the taskbar (G-62). The tooltip
  is "MVS" or "MVS: unread messages", never names or message text. This
  matches the notification-preview-off default.
- **Quit semantics:**
  - "Quit MVS" (tray menu, or the app menu) really quits: the core stops and
    you're offline.
  - Closing the window only hides it. The core stays up, and notifications and
    the badge keep working.
  - **In a call:** closing the window hides it and the call continues (the
    voice engine lives in the page, which stays alive while hidden). The tray
    icon shows the in-call state and offers Mute. "Quit MVS" during a call asks
    first, like closing does today.
  - **Sign-out** quits as today. **"Restart to update"** relaunches as today.
- **App lock (G-78):** hiding doesn't lock by itself; idle and sleep still
  do. Opening from the tray while locked shows the lock screen. While locked,
  the menu offers only Open, Mute (if in a call) and Quit.
- **Launching again** (Start menu, or an `mvs://` link) shows the hidden
  window. The single-instance handler already does this.

## Windows vs Linux

| | Windows | Linux |
| --- | --- | --- |
| Tray support | Always there. New icons land in the overflow ("hidden icons") until the user pins them | Depends on the desktop. KDE, Cinnamon, XFCE and Ubuntu's GNOME (AppIndicator built in) show it. **Stock GNOME (Fedora, Debian) shows nothing** without an extension |
| Detecting a visible tray | Not needed | Electron can't tell whether the icon is visible. Hiding on close could make MVS "vanish" with no way back except relaunching it |
| Click on the icon | Click and double-click work | With AppIndicator only the menu works, not clicks |
| Unread dot | Icon swap (as the G-62 overlay) | Icon swap; some docks also show the launcher count |
| Default (recommended) | C: hide on close, with the first-close notice | B: off, with the setting's caveat: "If your desktop has no tray, MVS keeps running in the background with no icon. Start MVS again to bring it back." |

## Out of scope (separate decisions)

- **Start with the computer** (login item): a natural companion, but a separate
  privacy and consent question. Not part of this note.
- **Quiet hours / do not disturb**: covered by mute (G-61).
- **macOS**: not shipped.

## Questions for the PO

1. Option A, B or C (or C/B split per platform, as recommended)?
2. Does closing during a call hide the window and keep the call going (recommended), or keep today's "This will end your call" question?
3. Unread dot on the tray icon: yes or no (no count either way)?

## Size and reviews

- Shell: S to M (`desktop/src/tray.js`, main wiring, icons, e2e).
- `ipc.ts`: one setting.
- UI: one toggle, two strings in he and en, the first-close notice (dev-ui).
- Security Lead review: the menu and tooltip carry no page content, and the tray menu never bypasses the lock.
