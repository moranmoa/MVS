# Changing a server's age limit (G-52)

- **Owner:** voice-c. **Screenshots:** 550–559.
- **Builds on:** B7 §6 (the three options and their wording), B11a–d §3.1 item 4, and B7-k (18+ channel keys).
- **The PO's rule, from G-77:** never open 18+ content to minors silently. Every change that lets 16–17-year-olds in, or locks them out, is an explicit, confirmed step with a plain explanation. A plain "שמירה" never does it on its own.

## 1. The setting

On the "כללי" page (see `server-icon-description.md`), the existing three options (`create.age.none`, `create.age.16`, `create.age.18`, with their hints) become editable. They replace `server.settings.ageReadOnly`.

- The app's minimum is 16, so **"ללא הגבלה" and "16+" let in the same people**. Moving between those two needs no confirmation.
- **An owner under 18** (effective age, from the core) sees "18+" disabled, with `server.age.ownerMinor`: "אפשר לבחור 18+ רק מגיל 18." / "You can choose 18+ only if you're 18 or older." The core refuses it anyway (the PO's owner rule from #512).
- The age change is saved with the page's "שמירה", but **only after its own confirmation dialog** (§2 and §3). If the dialog is cancelled, nothing on the page is saved.

## 2. Raising to 18+ (members aged 16–17 lose access)

Before saving, show a dialog:

- **title:** `server.age.raise.title` "להגביל את השרת לגיל 18 ומעלה?" / "Limit this server to 18 and over?"
- **body:** `server.age.raise.body` "מי שמתחת לגיל 18 לא יוכלו להמשיך לקרוא ולכתוב בשרת, ויקבלו על כך הודעה. ההודעות שכבר קיבלו נשארות אצלם." / "Members under 18 can no longer read or write in this server, and they're told why. Messages they already received stay on their devices."
- If the core can count them, add `server.age.raise.count`: `{count, plural, one {חשבון אחד יושפע.} two {שני חשבונות יושפעו.} other {# חשבונות יושפעו.}}` / `{count, plural, one {1 account is affected.} other {# accounts are affected.}}`. Show no names.
- **Buttons:** "הגבלה ל-18+" (primary) and "ביטול". The initial focus is on "ביטול".

## 3. Lowering from 18+ (16–17-year-olds can join)

This is the case the PO's rule is about, and it's never silent:

- **title:** `server.age.lower.title` "לפתוח את השרת גם לבני 16 ו-17?" / "Open this server to 16- and 17-year-olds too?"
- **body:** `server.age.lower.body` "מי שבגיל 16 ו-17 יוכלו להצטרף לשרת ולקרוא בו. ערוצים שמסומנים 18+ נשארים 18+, ורק מי שמגיל 18 רואים אותם. כדאי לבדוק שאין תוכן למבוגרים בערוצים הרגילים." / "16- and 17-year-olds will be able to join and read this server. Channels marked 18+ stay 18+, and only members 18 and over see them. Check that the regular channels have no adult content."
- **A checkbox the person must tick before the confirm button is enabled:** `server.age.lower.check` "בדקתי שהערוצים הרגילים מתאימים לבני 16 ומעלה." / "I've checked that the regular channels suit ages 16 and up."
- **Buttons:** "פתיחה לבני 16 ומעלה" (primary, `aria-disabled` until the box is ticked) and "ביטול". The initial focus is on "ביטול".
- **After saving:**
  - the invite preview and the server badge show the new limit;
  - existing members get no message, because nothing is taken away from them;
  - 18+ channels keep their own keys and membership (B7-k), so nothing in them opens up.

## 4. After saving, and errors

- Raising: members under 18 see the existing B7 removal notice for the server. Lowering: there's no notice.
- `update-needed`: the existing `server.updateNeeded` block, with nothing changed. This matters most here, because an old client could ignore the new limit.
- The badge in the rail tooltip, header and join preview updates from the saved record.

## 5. Accessibility

- The two dialogs are `role="alertdialog"` with focus trapped and the initial focus on "ביטול". Esc cancels.
- The checkbox in §3 is a real `<input type="checkbox">` with its label. The disabled confirm button keeps `aria-describedby` pointing at the checkbox.

## 6. Acceptance criteria

1. Moving between "ללא הגבלה" and "16+" saves with no dialog.
2. Moving to 18+ shows the raise dialog. "ביטול" saves nothing on the page.
3. Moving away from 18+ shows the lower dialog. The confirm button stays disabled until the box is ticked.
4. An owner under 18 sees 18+ disabled with the reason, and the core refuses it if forced.
5. After lowering, a 17-year-old can join, and can't see an 18+ channel (B7-k).
6. With an old-version member, `update-needed` shows, and the limit is unchanged.

**Screenshots:** 550 `550-age-raise-dialog-he`, 551 `551-age-lower-dialog-he` (the box unticked), 552 `552-age-lower-dialog-checked-en-dark`, 553 `553-age-owner-minor-he`.
