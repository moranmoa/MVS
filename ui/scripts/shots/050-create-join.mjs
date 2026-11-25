import { page, shot } from './lib.mjs';

export default async function run() {
  // ---- create & join (demo account, words checked) ----------------------------
  {
    const p = await page('?demo=1&still=1&lang=he&theme=light&update=999999');
    await p.getByRole('button', { name: 'בית' }).click();
    await shot(p, '13-home-with-servers');
    await p.getByRole('button', { name: /יצירת שרת/ }).click();
    await p.getByLabel('שם השרת').fill('ערב משחקים');
    await p.getByRole('button', { name: 'יצירה' }).click();
    await shot(p, '14-create-server-age-required');
    await p.getByLabel('18 ומעלה').check();
    await p.getByRole('button', { name: 'יצירה' }).click();
    await p.getByRole('heading', { name: 'השרת מוכן' }).waitFor();
    await shot(p, '15-create-server-done');
    await p.getByRole('button', { name: 'מעבר לשרת' }).click();
    await p.getByRole('button', { name: 'בית' }).click();
    await p.getByRole('button', { name: /הצטרפות בלינק/ }).click();
    await p.getByLabel('לינק הזמנה').fill('mvp://join/valorant-7k2q');
    await p.getByRole('dialog').getByRole('button', { name: 'הצטרפות', exact: true }).click();
    await shot(p, '16-join-searching');
    await p.getByRole('button', { name: 'ביטול' }).click();
    await p.getByRole('button', { name: /הצטרפות בלינק/ }).click();
    await p.getByLabel('לינק הזמנה').fill('mvp://join/offline-crew');
    await p.getByRole('dialog').getByRole('button', { name: 'הצטרפות', exact: true }).click();
    await p.getByText('אף אחד מהשרת לא מחובר כרגע', { exact: false }).waitFor({ timeout: 5000 });
    await shot(p, '17-join-nobody-online');
    await p.close();
  }
}
