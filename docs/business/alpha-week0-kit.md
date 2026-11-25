# Closed alpha: week-0 kit

Nov 25, 2026 · business agent · week 0 of `docs/business/alpha-testers.md` (#576), for v0.5.0 ([pre-release](https://github.com/moranmoa/MVS/releases/tag/v0.5.0)). This kit is preparation only. **No invite goes out until the owner says go and the abuse address is set** (the wave 1 condition).

Tester-facing texts are in Hebrew, gender-neutral; everything else is in English. Placeholders in `<angle brackets>` are filled in by the owner and never committed.

## 1. Go checklist

| # | Item | Who | Status |
| --- | --- | --- | --- |
| 1 | Abuse-report address and privacy-contact address chosen (a project address, not a personal one) | owner | open |
| 2 | Testers' server created in MVS (§2), kept reachable by the owner's PC plus two wave-0 testers | owner | open (#576 point 2, with the manager) |
| 3 | Sign-up form created from §3 and its link ready | owner or business | open |
| 4 | Welcome message (§4) filled in: release link, testers'-server invite, both addresses | owner | open |
| 5 | Links checked (§5) | business | done for 0.5.0, see §5 |
| 6 | **Member relays in 0.5.0:** the setting exists (#368 slice 1) and defaults to `auto`, so a reachable adult tester may relay for fellow members. The product owner ruled that member relays stay off for testers until R2 and notice v3 (#576, point 4). **Decided (product owner):** accept slice 1. It relays only for server owners and admins, and only after the disclosure is acknowledged (test `member_relay_follows_my_role_and_is_forced_off`). #576 point 4 is about R2. Condition: the welcome message says so (§4, item 5) | product owner | done |
| 7 | The owner says go | owner | open |

## 2. Testers' server

Name: **בודקי MVS**. Channels and topics (paste them as the channel topic):

| Channel | Topic |
| --- | --- |
| `#הכרזות` | גרסאות חדשות, מה השתנה ומה לבדוק. רק הצוות כותב כאן. |
| `#באגים` | מה עשיתם, מה ציפיתם שיקרה, מה קרה, מערכת הפעלה וגרסה. מצרפים קובץ אבחון (הגדרות ← אבחון ← "ייצוא קובץ אבחון"). הקובץ כולל רק מספרים וגרסאות, בלי כתובות IP ובלי מזהים. **אף פעם לא מצלמים או מעתיקים את 12 המילים.** |
| `#רעיונות` | מה חסר לכם, מה הייתם משנים. |
| `#עזרה` | התקנה, הצטרפות, כל שאלה. |

The diagnostics file in 0.5.0 holds the app version, update channel, relay-only flag, export time, whether an identity exists, the number of servers and the storage size. That's counts and versions only: no IPs, peer IDs, names or words (`export_diagnostics`, `core/api/src/service.rs`). When the path-type counters task lands, the topic stays true only if that task keeps the no-IP/no-peer-ID test (#576 condition 2).

## 3. Sign-up form

**Header (privacy, before the questions):**

> **הרשמה לאלפא הסגורה של MVS**
> אנחנו שואלים רק מה שצריך כדי להזמין אתכם: כינוי, מערכת הפעלה, האם יש לכם קבוצה, ודרך קשר אחת. לא שם מלא, לא טלפון (אלא אם בחרתם אותו כדרך הקשר) ולא תאריך לידה. רק צוות הפרויקט רואה את התשובות, והן נמחקות בסוף האלפא. שאלות או בקשה למחיקה: `<privacy-contact>`.

**Questions:**

| # | Question | Answer type | Required |
| --- | --- | --- | --- |
| 1 | כינוי (לא צריך שם אמיתי) | short text | yes |
| 2 | גילי 16 ומעלה | yes / no (no ends the form) | yes |
| 3 | מקום המגורים שלי בישראל | yes / no (no ends the form) | yes |
| 4 | מערכת הפעלה | Windows / Linux / macOS (רוצים לבדוק על Mac בהמשך) / אחר | yes |
| 5 | מאיפה תתחברו בדרך כלל? | רשת ביתית / סלולר / רשת עבודה או לימודים / לא יודעים | no |
| 6 | יש לכם קבוצת חברים שתעבור איתכם? כמה אנשים? | לבד / 2–3 / 4–8 / יותר | yes |
| 7 | דרך קשר אחת לשליחת ההזמנה | short text (Discord, Telegram, WhatsApp or email) | yes |
| 8 | הערות (לא חובה) | long text | no |

Answering no to 2 or 3 ends the form with: "תודה! האלפא הסגורה פתוחה כרגע רק לבני 16 ומעלה שגרים בישראל."

Host: any form tool with no tracking add-ons. Export to a private sheet only the owner and business can open. Delete the form and the answers at the end of the alpha (plan-1 §1.5).

## 4. Welcome message (wave 0 and 1)

This replaces plan-1 §1.4 (c) for 0.5.0. Send it privately to each tester.

> ברוכים הבאים לאלפא הסגורה של MVS! 🎉
>
> 1. **הורדה:** הגרסה כאן: `<release-link>`. מדריך התקנה קצר (כ-15 דקות): `<quickstart-link>`. ב-Windows תופיע אזהרת SmartScreen כי הגרסה עוד לא חתומה. המדריך מסביר איך לאשר.
> 2. **12 מילות השחזור הן החשבון שלכם.** רושמים אותן על נייר. אין לנו עותק, ואי אפשר לשחזר אותן.
> 3. **שרת הבודקים:** מצטרפים כאן: `<testers-server-invite>`. שם מדווחים, שואלים ומקבלים עדכונים.
> 4. **משהו נשבר?** הגדרות ← אבחון ← "ייצוא קובץ אבחון", ומצרפים לדיווח ב-#באגים. הקובץ כולל רק מספרים וגרסאות, בלי כתובות IP ובלי מזהים.
> 5. **פרטיות:** מה נשמר איפה ומי רואה מה: `<privacy-note-link>`. בקצרה: אין שרת מרכזי ששומר הודעות, ואין איסוף נתוני שימוש. **ממסר דרך חברים:** בעלים ומנהלים של שרת, בני 18 ומעלה, שהמחשב שלהם נגיש מהאינטרנט, יכולים להעביר חיבורים של חברי השרת שלהם. זה קורה רק אחרי שאישרו הודעה באפליקציה, ואפשר לכבות את זה בהגדרות. מי שמעביר חיבור רואה את כתובת ה-IP של מי שעובר דרכו, אבל לא את התוכן, שנשאר מוצפן.
> 6. **דיווח על פגיעה או תוכן לא חוקי:** `<abuse-contact>`.
>
> זו גרסת בדיקה: לא להעביר את קובץ ההתקנה הלאה, ועדיף לא לשמור בה מידע רגיש. אפשר לעזוב בכל רגע.

Before wave 2, B24a must be in the app (the About screen with both addresses and the privacy link), per #576 condition 1.

## 5. Link check (0.5.0)

| Link | Target | Checked |
| --- | --- | --- |
| `<release-link>` | `https://github.com/moranmoa/MVS/releases/tag/v0.5.0` (pre-release) | yes, exists |
| `<quickstart-link>` | `docs/release/ALPHA-QUICKSTART.md` on `main` | yes, exists. It's in Hebrew and covers Windows and Linux; its bug-report section points to "the channel where you got the invite", so add the testers' server there (QA/devops follow-up) |
| `<privacy-note-link>` | §4 of `docs/business/alpha-invite-pack.md` on `main`, until B24a shows it in the app | yes, exists |
| Invite text, "What is MVS", survey | `docs/business/alpha-invite-pack.md` §1–3 | yes |

## 6. Wave 1 recruiting post

Use plan-1 §1.4 (a), with two changes:
- the age line reads "גיל 16 ומעלה, ומקום מגורים בישראל";
- "מה יש כבר" adds "שיחות קול בסיסיות (בינתיים רק באותה רשת)".

Post only with each community admin's OK.
