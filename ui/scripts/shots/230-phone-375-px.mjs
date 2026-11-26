import { page, shot, chat, PHONE } from './lib.mjs';

export default async function run() {
  // ---- phone, 375 px ------------------------------------------------------------
  {
    const p = await page('?fresh=1&lang=he&theme=light', PHONE);
    await p.getByRole('heading', { name: 'בחירת שפה' }).waitFor();
    await shot(p, '50-phone-he-onboarding-language');
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('checkbox').check();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByLabel('יום').fill('12');
    await p.getByLabel('חודש').fill('4');
    await p.getByLabel('שנה').fill('2001');
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('heading', { name: 'מילות השחזור שלך' }).waitFor();
    await p.getByRole('button', { name: 'הצגת המילים' }).click();
    await shot(p, '51-phone-he-recovery-words');
    await p.close();
  }

  for (const [lang, t] of [
    ['he', { general: /^כללי/, members: 'רשימת החברים', back: 'חזרה לערוצים', close: 'סגירת רשימת החברים', settings: 'הגדרות', home: 'בית' }],
    ['en', { general: /^כללי/, members: 'Member list', back: 'Back to channels', close: 'Close the member list', settings: 'Settings', home: 'Home' }],
  ]) {
    const n = lang === 'he' ? 52 : 60;
    const p = await page(`?demo=unchecked&still=1&lang=${lang}&theme=light&update=999999`, PHONE);
    await p.getByRole('button', { name: t.general }).waitFor();
    await shot(p, `${n}-phone-${lang}-channels`);
    await p.getByRole('button', { name: t.general }).click();
    await p.getByRole('article').first().waitFor();
    await p.mouse.move(1, 1); // no leftover hover from the tap
    await p.waitForTimeout(600);
    await shot(p, `${n + 1}-phone-${lang}-chat`);
    await p.getByRole('button', { name: t.members }).click();
    await shot(p, `${n + 2}-phone-${lang}-members`);
    await p.getByRole('button', { name: t.close }).click();
    await p.getByRole('button', { name: t.back }).click();
    await p.getByRole('button', { name: t.settings }).first().click();
    await shot(p, `${n + 3}-phone-${lang}-settings`);
    await p.keyboard.press('Escape');
    await p.getByRole('button', { name: t.home, exact: true }).click();
    await shot(p, `${n + 4}-phone-${lang}-home`);
    await p.close();
  }

  {
    const p = await page('?demo=1&still=1&lang=he&theme=dark&update=999999', { ...PHONE, colorScheme: 'dark' });
    await p.getByRole('button', { name: /^כללי/ }).click();
    await p.getByRole('article').first().waitFor();
    await p.mouse.move(1, 1);
    await p.waitForTimeout(600);
    await shot(p, '57-phone-he-chat-dark');
    await p.close();
  }
}
