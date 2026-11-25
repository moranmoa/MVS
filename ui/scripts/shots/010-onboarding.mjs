import { page, problems, shot } from './lib.mjs';

export default async function run() {
  // ---- onboarding (Hebrew) ----------------------------------------------------
  {
    const p = await page('?fresh=1&lang=he&theme=light');
    await p.getByRole('heading', { name: 'בחירת שפה' }).waitFor();
    await shot(p, '01-onboarding-language');
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('checkbox').check();
    await shot(p, '02-onboarding-agreement');
    await p.getByRole('button', { name: 'המשך' }).click();
    await shot(p, '03-onboarding-country');
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByLabel('יום').fill('12');
    await p.getByLabel('חודש').fill('4');
    await p.getByLabel('שנה').fill('2001');
    await shot(p, '04-onboarding-birth-date');
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.waitForTimeout(700);
    await shot(p, '05-onboarding-preparing');
    await p.getByRole('heading', { name: 'מילות השחזור שלך' }).waitFor();
    await shot(p, '80-words-hidden-he');
    // Hidden words must not be in the page at all, and "I wrote them" waits for the reveal.
    if ((await p.locator('.word-grid .word:not(.word-mask)').count()) > 0) problems.push('recovery words in the page before reveal');
    if ((await p.getByRole('button', { name: 'כתבתי אותן' }).getAttribute('aria-disabled')) !== 'true') problems.push('"I wrote them" enabled before reveal');
    await p.getByRole('button', { name: 'הצגת המילים' }).click();
    await shot(p, '81-words-shown-he');
    const shownWords = await p.locator('.word-grid .word').allTextContents();
    await p.getByRole('button', { name: 'כתבתי אותן' }).click();
    await shot(p, '07-onboarding-check-words');
    // One right word, two wrong: only the wrong ones are marked (B19), and nothing is checked yet.
    const asked = (await p.locator('.check-fields label span').allTextContents()).map((s) => Number(s.match(/\d+/)[0]));
    const fields = p.locator('.check-fields input');
    await fields.nth(0).fill(shownWords[asked[0] - 1]);
    await fields.nth(1).fill('wrong');
    await fields.nth(2).fill('wrong');
    await p.getByRole('button', { name: 'בדיקה', exact: true }).click();
    await p.getByRole('alert').waitFor();
    await shot(p, '83-check-one-wrong-he');
    const invalid = await fields.evaluateAll((els) => els.map((e) => e.getAttribute('aria-invalid') === 'true'));
    if (invalid.join() !== 'false,true,true') problems.push(`check marks the wrong fields: ${invalid.join()}`);
    await p.getByRole('button', { name: 'אעשה את זה אחר כך' }).click();
    await p.getByLabel('שם תצוגה').fill('מורן');
    await shot(p, '08-onboarding-profile');
    await p.getByRole('button', { name: 'סיום' }).click();
    // G-92: a new account's first Home says it's ready.
    await p.getByRole('heading', { name: 'החשבון מוכן. מה עכשיו?' }).waitFor();
    await shot(p, '09-home-no-servers-reminder-banner');
    // The recovery words must not be anywhere in the page's storage.
    const stored = await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    const storedWords = new Set(stored.toLowerCase().split(/[^a-z]+/));
    for (const w of shownWords) if (storedWords.has(w)) problems.push(`recovery word "${w}" found in storage`);
    if (shownWords.length !== 12) problems.push(`expected 12 recovery words on screen, saw ${shownWords.length}`);
    await p.getByRole('button', { name: /יצירת שרת/ }).click();
    await shot(p, '10-create-server-needs-word-check');
    await p.close();
  }
}
