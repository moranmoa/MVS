# Link to a message, G-30 (design note)

- **Status:** design only. The SL approved with R1, now folded into §4; UX's and dev-identity's changes are folded in too. The UI half is #528, on the mock.
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
  - **Then send `link.message { serverId, channelId, messageId }`**, the three IDs main already parsed, not the link string. Invites keep `link.open { link }`.
    - Add `link.message` to the preload's kept-until-subscribed set (`KEPT`) and to the lock's held-link slot (one slot for either kind).
    - Keeping the strict parse at the OS boundary means the UI never re-parses a URL from outside. Inside the app the IDs are handled like `notify.click`'s.
  - **Never log it.** The IDs are metadata.
- **In the UI:** guardCore's `link.message` cleaner keeps the three IDs (strings, all present) and drops the event otherwise. Shell then goes through §5.
  - **The join-dialog rule stays:** a link never replaces an open join dialog. A message link that arrives while the join dialog is open is dropped.
  - A newer link wins over one still being located.
- **Links inside messages:** the message renderer (G-25 Markdown) linkifies an `mvs://m/…` link of the exact form.
  - A click is handled inside the app (§5), with no round trip through the OS.
  - Any other `mvs://` text stays plain text. An invite inside a message keeps today's behaviour.

## 4. Core contract (for dev-identity; agreed in review)

One new read-only command:

```
locateMessage(serverId: Id, channelId: Id, messageId: Id)
  → { index: number }            // its index in getMessages(channelId) order, as of now
  | error 'not-found'            // anything I can't see (below)
  | error 'bad-request'          // an ID that isn't 64 hex (the UI never sends these)
```

- **Local only:** it looks in the local store. It never asks peers and never triggers a sync of its own. The cost is one decryption pass over the channel, like `getMessages`.
- **One answer for everything I can't see** (SL R1, dev-identity). There is no `not-allowed`, so a link can't confirm that something hidden exists. All of these return `not-found` and look the same:
  - not a member, including servers I left or was removed from (the store purges those);
  - no such channel, or a channel `listChannels` doesn't give me (for example, an 18+ channel hidden from a minor under B7 §4);
  - IDs that don't agree: the message isn't in `channelId`, or the channel isn't in `serverId`;
  - a message that isn't here, or doesn't open (unreadable). Today those are filtered out (TODO #21). Once #21 adds placeholders, a placeholder returns its index;
  - a message still waiting to send (`pending-…` IDs aren't records).
- **A closed server** (read-only, still listed) answers as its `getMessages` does. The keys go at the close, so its messages no longer open and are `not-found` (dev-identity, #533).
- **The index** is the one `getMessages` and `replyTo.index` use: messages sorted by (record ts, id). An edited message keeps its place, a deleted one keeps its place as a tombstone and returns that index, and a blocked author's message returns its index.
- **The index is a snapshot.** A message with an earlier ts can arrive by sync later and shift everything after it, so the UI checks it (§5).
- **Desktop allow-list:** `locateMessage: ['serverId', 'channelId', 'messageId']`. It's read-only and returns no text. While locked it's refused like everything else.
- **Mock:** MockCore implements it over its seeded channels.
- **Core tests:**
  - a match;
  - each mismatch, a non-member, a hidden channel and a random channel all answer exactly `not-found` (the SL's identical-answer test);
  - the tombstone index;
  - a pending ID;
  - a non-hex ID returns `bad-request`.

There's no change to `Message`. There's one new event, `link.message` (§3).

## 5. UI behaviour

### Copy
- **Where:** "העתקת קישור להודעה" / "Copy message link" goes in the message context menu, after "Copy text", and in the toolbar's ⋯ menu.
- **When it's hidden:**
  - on my own message that's still sending or failed (no final ID yet);
  - on held messages (#288);
  - on unreadable placeholders, once #21 adds them.
- **What it does:** `copyText(link)`, then a short toast: "הקישור הועתק" / "Link copied". It uses the existing clipboard path (`copyText`), which G-78 refuses while locked.

### Open
1. **The event:** a `link.message { serverId, channelId, messageId }` event comes from main (§3), or later from a click inside the app.
2. **Server:** the UI checks my own server list first, without asking the core.
   - If the server isn't there, show a dialog (not a toast, so it isn't missed): "הקישור הוא להודעה בשרת שאינו ברשימה שלך. כדי לראות אותה צריך הזמנה ממי שכבר בשרת." / "This link is to a message in a server you're not in. To see it, you need an invite from someone who's in it."
   - The dialog has one button, "הבנתי" / "OK". No server name is shown, because we don't have one.
3. **Locate:** call `locateMessage`.
   - **`{ index }`:**
     - fetch that one row (`getMessages(channelId, index, index + 1)`) and check that its ID is `messageId`;
     - if it isn't (sync moved it), locate once more. If it still doesn't match, treat it as `not-found`;
     - then select the server and channel (on a phone, switch to the chat page), scroll to the index (`align: 'center'`) and highlight (below).
   - **`not-found`:**
     - select the server. Open the channel only if it's in my channel list; otherwise stay on the server's current channel. A hidden channel and a missing one then look exactly the same.
     - toast: "ההודעה לא נמצאה במחשב הזה. ייתכן שהיא עוד לא הגיעה, או שנמחקה." / "That message isn't on this computer. It may not have arrived yet, or it was deleted."
     - Nothing waits for it to arrive. There's no hidden pending state.
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
- **No logging** of message links or argv in main, the UI or the core (debug log included).
- **Focus throttle** (SL, non-blocking): main focuses the window for a deep link at most once every 2 s, and the latest link wins.
- **Residual:** someone who can make me open a link can make the app show a channel I'm in, for example during a screen share. That's the same as a click inside the app, and acceptable.

## 7. Strings (for UX)

| Key | Hebrew | English |
| --- | --- | --- |
| `msglink.copy` | העתקת קישור להודעה | Copy message link |
| `msglink.copied` | הקישור הועתק | Link copied |
| `msglink.notMember.title` | הודעה בשרת אחר | A message in another server |
| `msglink.notMember.body` | הקישור הוא להודעה בשרת שאינו ברשימה שלך. כדי לראות אותה צריך הזמנה ממי שכבר בשרת. | This link is to a message in a server you're not in. To see it, you need an invite from someone who's in it. |
| `msglink.ok` | הבנתי | OK |
| `msglink.notFound` | ההודעה לא נמצאה במחשב הזה. ייתכן שהיא עוד לא הגיעה, או שנמחקה. | That message isn't on this computer. It may not have arrived yet, or it was deleted. |

There's no gendered second person and no "מפתח". There's no separate "no access" text, since that case is `not-found`.

**Shots** (UX assigned 490–499): 490 `490-msglink-highlight-he`, 491 `491-msglink-not-member-he`, 492 `492-msglink-not-found-en-dark`.

## 8. Tests

- **deeplink.js:**
  - the exact form, upper case, a trailing `/`, and too long;
  - a fourth segment, a query, a fragment and `%`-escapes;
  - mixed args where only the first `mvs://` arg counts.
- **guardCore:** `link.message` with all three IDs, a missing ID, extra fields, and non-strings.
- **UI:**
  - copy, plus the menu item hidden on pending, held and unreadable rows;
  - opening while loaded and while not loaded (skeleton, then highlight);
  - not a member (from the server list), `not-found` for a hidden and for a random channel (identical), and a moved index (re-locate);
  - same channel and a second link;
  - a link while the join dialog is open;
  - reduced motion.
- **Core:** see §4.

## 9. Order

1. The core `locateMessage`, plus the allow-list line (SL review).
2. deeplink.js and main.js (SL review).
3. The UI: the sanitizer, then copy, then open and highlight. It can land on the mock before step 1.
