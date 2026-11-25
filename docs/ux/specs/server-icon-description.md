# Server icon and description (G-51)

- **Owner:** dev-ui. **Screenshots:** 540–549.
- **Builds on:** B11a–d §3.1 (items 1, 3 and 6) and B11 (the "כללי" page). Today "כללי" is read-only (#208). This spec makes the icon and description editable and covers what the older text leaves open.

## 1. The "כללי" page

```
 ┌ כללי ───────────────────────────────────────────┐
 │  (●) 80px   [בחירת אייקון]  [הסרה]              │
 │  שם השרת    [גיימרים ישראל            ]  41/48  │
 │  תיאור      [ערב משחקים כל חמישי…      ]        │
 │             [                          ] 270/300│
 │  הגבלת גיל  → server-age-limit.md (G-52)        │
 │                       [ביטול שינויים] [שמירה]   │
 └─────────────────────────────────────────────────┘
```

- **One save for the page**, as in B11e (profile save): every change is a draft until "שמירה". The save bar becomes sticky and "כללי" gets a dot while there's a draft. Leaving with a draft shows the existing unsaved confirmation.
- **The icon:**
  - "בחירת אייקון" opens the file picker (PNG, JPEG, WebP), then the same crop circle as the profile picture (B11e §4): 256×256, at most 512 KB after encoding.
  - "הסרה" shows only when there is an icon. Without one, the initials on the server's colour show.
  - The preview updates at once; the rail and other members see it only after saving.
- **The description:**
  - plain text, 4 rows, up to 300 characters, with the counter from 260 (`dir="ltr"` on the counter, as in #546);
  - `dir="auto"` in the field;
  - line breaks are kept (at most 3 in a row);
  - no Markdown and no clickable links in v1.
- **Who sees it:** members in the server header's info and in the join preview (B11a–d §3.3). Add one line under the field: `server.desc.hint` "התיאור מוצג למי שמקבלים הזמנה, לפני שהם מצטרפים." / "People see the description in the invite preview, before they join."

## 2. After "שמירה"

- The button shows "שומרים…" and is disabled. Then: the toast `server.settings.saved`, the draft clears, and **the rail, header and settings title update at once** on this computer (the same rule as profile save: render from the saved record, not from a stale copy).
- **Other members** see it when the record syncs. If some members are offline, show the existing `server.settings.pendingSync` line.
- **Errors:**
  - an image that's too big or unreadable: `server.icon.error` "אי אפשר להשתמש בתמונה הזו. אפשר לבחור תמונה אחרת (PNG, JPEG או WebP)." / "This image can't be used. Choose another one (PNG, JPEG or WebP).", under the icon, with the draft kept;
  - `update-needed` (some members are on an older version): the existing `server.updateNeeded` block with its `.who` list and `.remedy`, with nothing saved;
  - any other failure: `error.generic` with "לנסות שוב", with the draft kept.

## 3. Strings (new)

| Key | Hebrew | English |
| --- | --- | --- |
| `server.icon.choose` | `בחירת אייקון` | `Choose icon` |
| `server.icon.remove` | `הסרה` | `Remove` |
| `server.icon.error` | (above) | (above) |
| `server.desc.label` | `תיאור` | `Description` |
| `server.desc.hint` | (above) | (above) |
| `server.desc.counter` | `⁨{n}⁩/300` | `{n}/300` |
| `server.settings.saved` | `השינויים נשמרו` | `Changes saved` |

## 4. Accessibility

- The icon button's accessible name is "בחירת אייקון לשרת" / "Choose a server icon", and the preview has `alt=""`, because the name is right beside it.
- The counters go live (`aria-live="polite"`) only from their threshold.
- The errors are `role="alert"`, linked to the field with `aria-describedby`.

## 5. Acceptance criteria

1. Change the icon, then "שמירה": the rail, header and settings title show the new icon at once, with no restart.
2. Before "שמירה", only the preview changes.
3. A 2 MB PNG is resized under 512 KB. A broken file shows `server.icon.error`, and the draft stays.
4. A description with a Hebrew paragraph and an English line keeps each line's direction, both in the field and in the join preview.
5. With an old-version member, `update-needed` shows the list, and nothing is saved.

**Screenshots:** 540 `540-server-general-edit-he` (a draft, with the dot), 541 `541-server-icon-crop-he`, 542 `542-server-general-saved-en-dark`, 543 `543-server-icon-error-he`.
