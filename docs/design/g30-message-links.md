# Link to a message, G-30 (design note)

- **Status:** design only, no code.
- **Reviews:**
  - UX: what people see, wording, and the highlight;
  - Security Lead: the deep-link parsing and what a link from outside may do (§3, §6);
  - dev-identity: the core contract (§4).
- **Owner:** dev-ui (the UI half). The core half is dev-identity's, or whoever the manager assigns.
- **Gap:** G-30 in `docs/ux/GAPS.md` ("copy a link to a message, and jump to it from a link"). It's in 0.5.0 "Conversation".

## 1. What it is

1. **Copy:** "Copy link" on any message (the message menu and the toolbar's ⋯) puts an `mvs://` link on the clipboard.
2. **Open:** someone who receives that link and opens it, either from inside MVS (a link in a message) or from outside (a browser or chat, through the OS), lands on that message:
   - the right server and channel are selected;
   - the message is scrolled into view and highlighted for a moment.
3. **Nothing else.** A link never joins a server, never sends anything, and never fetches anything from the network that opening the channel wouldn't fetch anyway.

## 2. The link format

```
mvs://m/<server id>/<channel id>/<message id>
```

- **The IDs:** each is 64 lower-case hex characters, the IDs the core already uses. The total is 202 characters, under deeplink.js's `MAX_LEN` (256).
- **Strict shape:**
  - no query string or fragment, and no other fields;
  - one optional trailing `/`;
  - parsing is case-insensitive, then canonicalized to lower case, exactly like the invite link.
- **No https form, ever.** An `https://…` link would send the three IDs (and the fact that someone opened them) to whoever runs that web server. The IDs aren't secrets, but which message someone looks at, and when, is metadata we don't hand to a web server. If MVS isn't installed, the link just doesn't open, and that's accepted.
- **Why all three IDs, not just the message ID:**
  - The UI can tell "not a member of this server" apart from "not found" without asking the core (§5).
  - It can open the right channel even when the message itself hasn't reached this device yet.
  - The core checks that the three agree (§4), so a forged link can't present a message as being in a channel it isn't in.
- **What a link reveals:** that a server, channel and message with those IDs exist. It gives no names, no text and no access. An invite still needs the server secret (`mvs://join/…`), and this link never carries it.

## 3. Deep-link parsing (desktop `deeplink.js` and `main.js`)

- **The parser:** `parseMessageLink(raw)`, beside `parseInviteLink`, with the same rules:
  - the input is a string of at most `MAX_LEN` characters;
  - it's trimmed and lower-cased, then matched against
    `^mvs://m/([0-9a-f]{64})/([0-9a-f]{64})/([0-9a-f]{64})/?$`.
  - It returns the canonical link or null. Anything else in argv is ignored, as today.
- **`linkFromArgv`:** it replaces `inviteFromArgv` and accepts either kind. The first `mvs://` argument decides; if it's neither kind, it's ignored.
- **In main:** the same path as an invite. Restore and focus the window.
  - **Hold the link** until the UI is up and unlocked. Only the latest held link is kept, invite or message, per G-78 §5.
  - **Then send `link.open { link }`.** It's the same event, so the preload's kept-until-subscribed handling (`KEPT`) and the lock's holding work unchanged.
  - **Never log it.** The IDs are metadata.
- **In the UI:** guardCore's `link.open` cleaner accepts either exact form (`cleanInviteLink` or a new `cleanMessageLink`) and blanks everything else. Shell routes it as follows:
  - an invite opens the join dialog, as today;
  - a message link goes through §5.
  - **The join-dialog rule stays:** a link never replaces an open join dialog. A message link that arrives while the join dialog is open is dropped.
- **Links inside messages:** the message renderer (G-25 Markdown) linkifies an `mvs://m/…` link of the exact form.
  - A click is handled inside the app (§5), with no round trip through the OS.
  - Any other `mvs://` text stays plain text. An invite inside a message keeps today's behaviour.

## 4. Core contract (proposal, for dev-identity)

One new read-only command:

```
locateMessage(serverId: Id, channelId: Id, messageId: Id)
  → { index: number }            // its index in getMessages(channelId) order
  | error 'not-found'            // not on this device, or the three don't match
  | error 'not-allowed'          // I'm not a member of that server, or can't see that channel
  | error 'bad-request'          // malformed IDs (the UI never sends these)
```

- **Local only:** it looks in the local store. It never asks peers and never triggers a sync of its own.
- **The three IDs must agree:**
  - the message's own channel is `channelId`;
  - the channel belongs to `serverId`.
  - Otherwise it returns `not-found`. A mismatch never says which part was wrong.
- **`not-allowed`** means:
  - I'm not a member;
  - I've left or been removed;
  - or the channel isn't one `listChannels` gives me, whatever rule hid it (for example, if B7 ever hides 18+ channels from a minor). Whether such a channel exists isn't revealed beyond that.
- **The index** is the same one `getMessages` and `replyTo.index` use, so the UI jumps with the code that already handles a reply jump. It also covers rows that show something other than the message:
  - a deleted message returns its tombstone's index;
  - a message I can't open (the unreadable placeholder, dev-sync's contract) returns the placeholder's index;
  - a blocked author's message returns its index, and the row shows what blocked rows show.
  - Before-join history that isn't emitted at all is `not-found`.
- **Desktop allow-list:** `locateMessage: ['serverId', 'channelId', 'messageId']`. It's read-only and returns no text. While locked it's refused like everything else.
- **Mock:** MockCore implements it over its seeded channels, with a `?messageLink=` demo flag for screenshots.

There's no new event and no change to `Message`.

## 5. UI behaviour

### Copy
- **Where:** "העתקת קישור להודעה" / "Copy message link" goes in the message context menu, after "Copy text", and in the toolbar's ⋯ menu.
- **When it's hidden:**
  - on my own message that's still sending or failed (no final ID yet);
  - on held messages (#288);
  - on unreadable placeholders.
- **What it does:** `copyText(link)`, then a short toast: "הקישור הועתק" / "Link copied". It uses the existing clipboard path (`copyText`), which G-78 refuses while locked.

### Open
1. **Clean the link** (§3). If it's not an exact message link, nothing happens.
2. **Server:** it must be in my server list.
   - If not, show a dialog (not a toast, so it isn't missed): "הקישור הוא להודעה בשרת שאינו ברשימה שלך. כדי לראות אותה צריך הזמנה מחבר בשרת." / "This link is to a message in a server you're not in. To see it, you need an invite from a member."
   - The dialog has one button, "הבנתי" / "OK". No server name is shown, because we don't have one.
3. **Locate:** call `locateMessage`.
   - **`{ index }`:**
     - select the server and channel (on a phone, switch to the chat page);
     - scroll to the index (`align: 'center'`) and highlight (below).
   - **`not-found`:**
     - open the channel at the bottom, as a normal open;
     - toast: "ההודעה לא נמצאה במחשב הזה. ייתכן שהיא עוד לא הגיעה, או שנמחקה." / "That message isn't on this computer. It may not have arrived yet, or it was deleted."
     - Nothing waits for it to arrive. There's no hidden pending state.
   - **`not-allowed`:** the same dialog as step 2. Not being in the server and not being able to see the channel look the same from outside, and that's deliberate.
4. **Unread is unchanged.** A jump marks nothing as read beyond what the normal visible-rows rule already does.

### Highlight
- **The row:** it gets `.msg-target` for 2.5 s, a soft accent background plus a 2 px start-side bar, so it isn't colour alone.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, there's no fade. The highlight just switches off after 2.5 s.
- **Focus:** the row (`role="article"`, already focusable in the list's roving order) gets focus, so a screen reader reads it and keyboard users continue from there. There's no extra announcement.
- **Already loaded vs fetched:**
  - If the row is rendered, scroll and highlight at once.
  - If it isn't, `scrollToIndex` brings the virtual window there. The window fetches that range as it does for any scroll. The skeleton row shows first, and the highlight and focus apply when the real row mounts, at most 5 s later.
  - After 5 s it gives up silently: the place is right, so a missing highlight is cosmetic.
- **Same channel already open:** the same scroll and highlight. The composer draft is untouched.
- **A second link while one is being opened:** the newer one wins, so the first one's highlight is cancelled.

### Lock (G-78)
- Main holds the link while locked and sends it after unlock (§3).
- In path B (locked during a call), the content is unmounted, so the link is applied once content is back.

## 6. Security notes (for the SL)

- **What an outside link can do:** select a server and channel I'm already in, scroll, and highlight. That's all.
  - It cannot join, send, react or mark read.
  - It cannot make the app contact any host it wouldn't contact when I open that channel myself.
- **Parsing:** one exact regex at three layers (deeplink.js, guardCore, the in-message linkifier). There's no URL parser and no partial matches.
- **The not-member dialog** shows no data from the link besides the fact that it's a message link. The IDs are never rendered.
- **No logging** of message links in main, the UI or the core (debug log included).
- **Residual:** someone who can make me open a link can make the app show a channel I'm in, for example during a screen share. That's the same as a click inside the app, and acceptable.

## 7. Strings (for UX)

| Key | Hebrew | English |
| --- | --- | --- |
| `msglink.copy` | העתקת קישור להודעה | Copy message link |
| `msglink.copied` | הקישור הועתק | Link copied |
| `msglink.notMember.title` | הודעה בשרת אחר | A message in another server |
| `msglink.notMember.body` | הקישור הוא להודעה בשרת שאינו ברשימה שלך. כדי לראות אותה צריך הזמנה מחבר בשרת. | This link is to a message in a server you're not in. To see it, you need an invite from a member. |
| `msglink.notFound` | ההודעה לא נמצאה במחשב הזה. ייתכן שהיא עוד לא הגיעה, או שנמחקה. | That message isn't on this computer. It may not have arrived yet, or it was deleted. |

There's no gendered second person and no "מפתח". Shot range: UX to assign (480–489 is G-25). I suggest 490–499 if it's free.

## 8. Tests

- **deeplink.js:**
  - the exact form, upper case, a trailing `/`, and too long;
  - a fourth segment, a query, a fragment and `%`-escapes;
  - mixed args where only the first `mvs://` arg counts.
- **guardCore:** `link.open` with a message link, an invite, garbage, and a link with spaces or a newline.
- **UI:**
  - copy, plus the menu item hidden on pending, held and unreadable rows;
  - opening while loaded and while not loaded (skeleton, then highlight);
  - not a member, `not-found` and `not-allowed`;
  - same channel and a second link;
  - a link while the join dialog is open;
  - reduced motion.
- **Core:** a match; each mismatch returns `not-found`; a non-member and a hidden channel return `not-allowed`; the tombstone and placeholder indexes.

## 9. Order

1. The core `locateMessage`, plus the allow-list line (SL review).
2. deeplink.js and main.js (SL review).
3. The UI: the sanitizer, then copy, then open and highlight. It can land on the mock before step 1.
