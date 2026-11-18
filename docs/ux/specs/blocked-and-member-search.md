# Blocked accounts and member search (G-47, G-41)

- **Owner:** voice-c. **Screenshots:** 470–479.
- **Today:** "חסימה" / "ביטול חסימה" exist only on the profile card (`profile.block`, `profile.unblock`), and `blockUser` toggles. Once a blocked person is in no shared server, there's no way to reach their card, so no way to unblock (G-47). The member list has no search, which hurts in servers of 30+ (G-41).

## 1. Blocked accounts (G-47): Settings → פרטיות → "חשבונות חסומים"

```
 חשבונות חסומים
 ההודעות של חשבונות חסומים מוסתרות אצלך. הם לא יודעים שחסמת אותם.

 ┌─────────────────────────────────────────────────────┐
 │ (ט) טל                 ⁨a1b2-c3d4⁩     [ביטול חסימה] │
 │ (?) חשבון שלא נראה לאחרונה ⁨9f8e-7d6c⁩ [ביטול חסימה] │
 └─────────────────────────────────────────────────────┘
```

- **Rows:** avatar (the last known picture or letter-on-colour), the last known name (`<bdi>`), the identity short code (`<bdi dir="ltr">`, in `--text-muted`), and "ביטול חסימה" as a secondary button at the end. No server names (they could reveal where we met).
- **Unknown name:** if the core has no name for them, the row says "חשבון לא מוכר" plus the code.
- **Order:** most recently blocked first.
- **Unblock:** no confirmation (it's easy to block again from their card). The row goes away with a toast "החסימה של ⁨{name}⁩ בוטלה." plus "ביטול" for 5 s, which blocks again. Focus moves to the next row's button, or to the page heading when the list is empty.
- **Empty:** "לא חסמת אף אחד." in `--text-muted`.
- **Over 20 rows:** a filter field on top (the same component as §2).
- **Where else:** the profile card's block hint (`profile.blockHint`) gains a link "לרשימת החסומים" that opens this page.

**Core need (TL):** today there's no list. Proposed:
- `listBlocked` → `[{ userId, displayName?, shortCode, avatar?, color?, blockedAt }]`, taking the last known profile from any server's member rows;
- `setBlocked { userId, blocked: boolean }` instead of the toggle, so a double click or a retry can't flip it back.

The UI fix doesn't depend on any wire change: blocking stays local.

**Wording:** the existing `chat.blocked` "הודעה ממשתמש חסום" is gendered. Change it to "הודעה מחשבון חסום" (en unchanged, "Message from a blocked account").

## 2. Member search (G-41)

```
 ┌ חברי השרת — 42 ───────────┐
 │ 🔍 [חיפוש                ✕]│  ← shown when the server has 15+ members
 │ מחוברים — 3               │
 │ (ט) טל                    │
 │ …                         │
 └───────────────────────────┘
```

- **When it's there:** the field sits at the top of the member list in servers with 15 or more members. Smaller lists don't need it.
- **Shortcut:** Ctrl+Shift+M focuses it (or opens the member list if it's hidden, then focuses).
- **What it matches:** the display name, by skeleton-insensitive prefix of any word (the same `nameSkeleton` the look-alike check uses, so "Αdmin" matches "admin"), and the identity short code from its start (with or without the dash). Case and Hebrew niqqud are ignored.
- **Results:** the list filters live as you type (no Enter needed), keeping the groups (owner, online, offline) and their headers with filtered counts. Empty groups are hidden. The match is not highlighted in v1 (highlighting inside `<bdi>` mixed text is fiddly; later).
- **Count:** a `role="status"` line, read politely: "⁨{count}⁩ תוצאות" / one / two plural forms, updated after typing stops for 300 ms.
- **No match:** "לא נמצאו חברים בשם הזה." with "ניקוי החיפוש" as a link button.
- **Clearing:** the ✕ button in the field, or Esc (first Esc clears, second Esc leaves the field). Switching server clears it.
- **Blocked people** still appear in results, marked as today.
- **Accessibility:** `role="searchbox"` with `aria-label` "חיפוש חברים", `aria-controls` on the list. The field is 32px high, its ✕ a 24px target.

## 3. Strings

| Key | Hebrew | English |
| --- | --- | --- |
| `settings.blocked.title` | `חשבונות חסומים` | `Blocked accounts` |
| `settings.blocked.hint` | `ההודעות של חשבונות חסומים מוסתרות אצלך. הם לא יודעים שחסמת אותם.` | `Messages from blocked accounts are hidden for you. They aren't told you blocked them.` |
| `settings.blocked.empty` | `לא חסמת אף אחד.` | `You haven't blocked anyone.` |
| `settings.blocked.unknown` | `חשבון לא מוכר` | `Unknown account` |
| `settings.blocked.unblocked` | `החסימה של ⁨{name}⁩ בוטלה.` | `You unblocked {name}.` |
| `settings.blocked.undo` | `ביטול` | `Undo` |
| `profile.blockedListLink` | `לרשימת החסומים` | `See blocked accounts` |
| `chat.blocked` (changed) | `הודעה מחשבון חסום` | `Message from a blocked account` |
| `members.search` | `חיפוש חברים` | `Search members` |
| `members.search.placeholder` | `חיפוש` | `Search` |
| `members.search.count` | `{count, plural, one {תוצאה אחת} two {שתי תוצאות} other {# תוצאות}}` | `{count, plural, one {1 result} other {# results}}` |
| `members.search.none` | `לא נמצאו חברים בשם הזה.` | `No members match.` |
| `members.search.clear` | `ניקוי החיפוש` | `Clear search` |


## 4. Acceptance criteria

1. Block someone, leave every shared server: they're still in "חשבונות חסומים", and unblocking works.
2. Unblock → toast → "ביטול" blocks again. Focus lands on the next row.
3. A double click on "ביטול חסימה" leaves them unblocked (no toggle flip).
4. In a 40-member server, typing "ta" shows Tal and Tamar in their groups, with the right count. A short code prefix finds its member.
5. A look-alike name ("Αdmin" with a Greek Alpha) is found by "admin".
6. Esc clears, then leaves the field. Switching server clears.
7. Servers under 15 members have no search field.

**Screenshots:**

| # | Shot | What it shows |
| --- | --- | --- |
| 470 | `470-blocked-list-he` | Two blocked accounts, one unknown |
| 471 | `471-blocked-empty-he` | The empty list |
| 472 | `472-blocked-undo-toast-he` | After unblocking, the toast with "ביטול" |
| 473 | `473-member-search-he` | Search "ta" in a 40-member server |
| 474 | `474-member-search-none-en-dark` | No match, English, dark |
