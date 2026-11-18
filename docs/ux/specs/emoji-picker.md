# Emoji picker, full set (G-27)

- **Builds on:** `chat-and-voice-extras.md` §3, which covers the compact picker already in `ui/src/components/EmojiPicker.tsx`: search, recent and a common set. This spec adds the full set and categories, and it replaces the "common set" grid.
- **Owner:** dev-ui. **Screenshots:** 450–459.
- **Used from:** the composer's smiley button (inserts at the cursor) and "הוספת אמוג'י" on a message (adds a reaction). It's one component with two modes.

## 1. Layout

```
 ┌──────────────────────────────────────┐
 │ 🔍 [חיפוש אמוג'י                  ] │  ← focus here on open
 ├──────────────────────────────────────┤
 │ אחרונים                              │  ← sticky section header
 │ 😂 👍 ❤️ 🔥 🎉 😭 🙏 👀              │
 │ סמיילים ורגשות                       │
 │ 😀 😃 😄 😁 😆 😅 🤣 😂              │
 │ …                                    │
 ├──────────────────────────────────────┤
 │ 😂  פרצוף צוחק עם דמעות              │  ← preview strip: hovered or focused cell
 ├──────────────────────────────────────┤
 │ 🕘 😀 🐶 🍔 ⚽ ✈️ 💡 🔣 🏳️            │  ← category tabs
 └──────────────────────────────────────┘
```

- **Size:** 8 columns of 40×40 cells (32px glyph), about 352 wide and 420 high. Below 40rem it's a bottom sheet, 60% of the height, with the same parts.
- **One scrolling list** with all the sections, in this order: recent, then the 9 Unicode groups. A tab scrolls to its section, and the tab of the section at the top is marked (`aria-selected`, plus an accent underline, so it isn't colour alone).
- **Preview strip:** the hovered or focused emoji, larger (24px), with its name in the UI language. Nothing else is in it in v1.
- **Placement:** above the composer button (the start side in each direction), or under the message's toolbar for reactions. It flips to stay inside the window.

## 2. Content

- **Data:** the CLDR emoji list for one Unicode version, bundled with the UI (no network): the glyph, the group, the English name and keywords, and Hebrew names and keywords from CLDR `he` where they exist. Pick the version the bundled Chromium renders, so no cell shows tofu.
- **Only what the core accepts:** filter the bundle through `normalizeEmoji` (`ui/src/core/emoji.ts`) at build time, so anything the picker offers can also be a reaction. Leave out subdivision flags (tag sequences), and leave out skin-tone variants (later, §5).
- **Groups and tab labels** (`aria-label` and `title` on each tab):

| Tab | Key | Hebrew | English |
| --- | --- | --- | --- |
| 🕘 | `emoji.cat.recent` | אחרונים | Recent |
| 😀 | `emoji.cat.smileys` | סמיילים ורגשות | Smileys & emotion |
| 👋 | `emoji.cat.people` | אנשים וגוף | People & body |
| 🐶 | `emoji.cat.nature` | בעלי חיים וטבע | Animals & nature |
| 🍔 | `emoji.cat.food` | אוכל ושתייה | Food & drink |
| ✈️ | `emoji.cat.travel` | נסיעות ומקומות | Travel & places |
| ⚽ | `emoji.cat.activities` | פעילויות | Activities |
| 💡 | `emoji.cat.objects` | חפצים | Objects |
| 🔣 | `emoji.cat.symbols` | סמלים | Symbols |
| 🏳️ | `emoji.cat.flags` | דגלים | Flags |

- **Recent:** unchanged: the 24 most recent, on this computer only. With none yet, the recent section and its tab are hidden, and the first section is smileys.

## 3. Search

- It matches the start of any word in the name or keywords, in both Hebrew and English, whatever the UI language. So "לב" finds ❤️ and "heart" finds ❤️ in either language. It ignores case and Hebrew niqqud.
- Results replace the sections: one flat grid, recent ones first, then in CLDR order. The tabs dim and don't respond while there's a query.
- No match: "לא נמצא אמוג'י" / "No emoji found" (unchanged), as a `role="status"` line.
- Enter in the search box picks the first result.

## 4. Keyboard and screen readers

- The grid is one `role="grid"` with rows of 8. Arrow keys move (← and → mirrored in RTL), Home and End go to the row's ends, and PageUp and PageDown move by a section. One cell has `tabindex=0` (roving).
- Tab order: search → grid → tabs. Esc closes and returns focus to the trigger.
- Each cell's accessible name is the emoji's name in the UI language, with the English name as the fallback when CLDR has no Hebrew name. Section headers are plain headings (`role="heading"`, `aria-level=3`) outside the grid rows, so screen readers can jump between them.
- **Composer mode:** a click inserts and closes. Shift+click or Shift+Enter inserts and keeps it open (unchanged).
- **Reaction mode:** a click adds the reaction and closes. An emoji I already reacted with shows selected (`aria-pressed=true` look, accent ring), and choosing it again removes my reaction, like the chip.

## 5. Not in v1

Skin tones, custom server emoji, frequently used ranked by count, and `:shortcode:` typing in the composer. Each would be its own gap.

## 6. Performance

- Render only the visible rows (a simple windowed list). Opening must stay under 100 ms on the test laptop.
- The data is loaded lazily on the first open, then kept.

## 7. Acceptance criteria

1. All 9 groups are present, and every emoji in them passes `normalizeEmoji`. A unit test covers the whole bundle.
2. Clicking a tab scrolls to its section, and scrolling marks the right tab.
3. "לב", "heart" and "Heart" all find ❤️, in both UI languages.
4. Keyboard only: open, search, move, pick and close, with focus back on the trigger. ← moves right-to-left in Hebrew.
5. Reaction mode: picking an emoji I already used removes my reaction.
6. On a 375px-wide window it opens as a bottom sheet.

**Screenshots:**

| # | Shot | What it shows |
| --- | --- | --- |
| 450 | `450-emoji-picker-he` | The picker in Hebrew, recent and smileys, with the preview strip |
| 451 | `451-emoji-picker-search-he` | Search "לב" with results |
| 452 | `452-emoji-picker-flags-en-dark` | The flags tab selected, English, dark |
| 453 | `453-emoji-picker-sheet-he` | The bottom sheet at 375px |
