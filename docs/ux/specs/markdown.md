# Markdown in messages (G-25)

- **Owner:** voice-d. **Screenshots:** 480–489.
- **Scope:** display only. The message stays plain text on the wire and in the store; the receiving app renders it. Nothing changes in the protocol, and an older app shows the raw characters, which still read fine.
- **Builds on:** B17 (mixed direction), mentions (`mention-chip`), and the existing link handling in `MessageList.tsx`.

## 1. What's supported (v1)

| Write | Shows | Notes |
| --- | --- | --- |
| `**text**` | **bold** | weight 600 (not 700: Hebrew at 700 gets heavy) |
| `*text*` or `_text_` | *italic* | Hebrew fonts often have no real italic. Use the font's italic if it has one; never a faked slant over 8° |
| `~~text~~` | ~~strikethrough~~ | |
| `` `code` `` | `code` inline | |
| ```` ``` ```` block | code block | a language tag after the fence is ignored in v1 (no highlighting) |
| `> text` at the start of a line | quote | one level only; `>>` shows as a quote starting with `>` |
| `\|\|text\|\|` | spoiler | §4 |
| `\*` | a literal `*` | backslash escapes for `* _ ~ \` \| > \` |

**Not in v1:** headings, lists, tables, images, raw HTML, link text `[a](b)` (a link always shows its real URL), underline. Typing them shows the characters as written.

**Rules:**
- An emphasis marker needs text right after the opener and right before the closer (`* not italic *`), so maths like `2*3*4` stays plain. Inside a word, `_` doesn't count (`snake_case_name`), `*` does.
- Nothing is parsed inside code (inline or block), including mentions and links.
- Mentions and links work inside bold, italic, strike, quote and spoiler.
- The whole message is one isolate per B17. Each formatted run is its own `<bdi>` only when it starts with a different strong direction than the line; let the browser handle the rest.

## 2. The look

| Element | Style |
| --- | --- |
| Inline code | `font-family: var(--font-mono)`, 0.9em, padding 0 4px, radius 4px, background `--bg-input`. Always `dir="ltr"` inside a `<bdi>`, so `` `npm i` `` sits right in a Hebrew line |
| Code block | Full message width (max 100%), `--bg-input`, 1px `--border`, radius 6px, padding 8px 12px, `dir="ltr"` and `text-align: left` in both languages. `white-space: pre`, scrolls sideways inside (never the page). A "העתקה" icon button on the block's top end corner, shown on hover and on focus (24px target), copying the block's text with a 2 s "הועתק" status |
| Quote | An inline-start bar, 3px `--text-faint`, padding-inline-start 10px, text in `--text-muted`. The bar sits on the **start** side of the quote's own direction: on the right for a Hebrew quote, even inside an English message (use `dir="auto"` on the block) |
| Strike | `text-decoration: line-through`, colour unchanged |
| Spoiler | §4 |

- **Line height** stays the message's. Code blocks use 1.45.
- **Edited, pending and failed messages** (B6) render the same way.
- **Notifications and reply previews** (one line) strip the markers and show plain text, with spoilers replaced by "▮▮▮▮" (four blocks, whatever the length), so a spoiler never leaks into a notification, preview or the taskbar.

## 3. The composer

- **v1 is plain text:** the composer shows the characters as typed. No live preview, no toolbar.
- **Shortcuts** that wrap the selection (or insert a pair and put the cursor between): Ctrl+B `**`, Ctrl+I `*`, Ctrl+E `` ` ``, Ctrl+Shift+X `~~`. Undo restores in one step.
- **Paste** of rich text (from a web page or Word) pastes the plain text only.
- Typing ```` ``` ```` and Enter inside a fence adds a newline instead of sending, until the fence is closed. Shift+Enter is unchanged.
- A one-time hint, under the composer the first time someone types `*` or `` ` `` twice: "אפשר לעצב: ‎**מודגש**‎, ‎*נטוי*‎, ‎`קוד`‎, ‎||ספוילר||‎". Dismissed with ✕, never shown again on this computer.

## 4. Spoiler

- Hidden: the text's box filled with `--text-faint` at full opacity (no blur, so nothing is readable through it), radius 3px, the text `color: transparent` and `user-select: none`.
- Reveal: click or Enter/Space. It's a `button` with `aria-label` "ספוילר, לחיצה לחשיפה" and `aria-expanded=false`; after reveal, a plain background `--bg-hover` and normal text. It stays revealed for this message until the channel is left.
- Screen readers don't get the text until it's revealed.
- Copying a message with a hidden spoiler copies "▮▮▮▮" in its place.

## 5. Strings

| Key | Hebrew | English |
| --- | --- | --- |
| `md.copyCode` | `העתקה` | `Copy` |
| `md.copied` | `הועתק` | `Copied` |
| `md.spoiler` | `ספוילר, לחיצה לחשיפה` | `Spoiler, click to reveal` |
| `md.hint` | see below | see below |

`md.hint`, exactly (he, then en):

```
אפשר לעצב: ‎**מודגש**‎, ‎*נטוי*‎, ‎`קוד`‎, ‎||ספוילר||‎
You can format: **bold**, *italic*, `code`, ||spoiler||
```

The LRMs (U+200E) in the Hebrew keep each marker pair attached to its word in RTL.

## 6. Acceptance criteria

1. Each row of §1 renders as shown, in Hebrew and English messages; the "not in v1" syntax shows raw.
2. `2*3*4`, `snake_case_name` and `* x *` stay plain.
3. A mention and a link inside `**…**` still work; inside `` `…` `` they don't.
4. A code block with a 200-character line scrolls inside the block; the page never scrolls sideways. Copy copies exactly the block text.
5. A Hebrew quote inside an English message has its bar on the right.
6. A spoiler is hidden in the message, the reply preview, the notification and copied text, until revealed.
7. Ctrl+B with a selection wraps it in `**`; one Ctrl+Z undoes it.
8. Rendering a 4,000-character message with 50 markers takes under 5 ms (unit benchmark), and the parser never throws on any input (a fuzz test).

**Security:** the renderer builds React elements from tokens. It never uses `dangerouslySetInnerHTML`, and no Markdown library that outputs HTML.

**Screenshots:**

| # | Shot | What it shows |
| --- | --- | --- |
| 480 | `480-markdown-he` | Bold, italic, strike, inline code, a quote and a spoiler in Hebrew messages |
| 481 | `481-markdown-code-block-en-dark` | A long code block with the copy button, English, dark |
| 482 | `482-markdown-mixed-he` | An English quote in a Hebrew message, and `code` in a Hebrew line |
| 483 | `483-markdown-spoiler-revealed-he` | The spoiler after reveal |
