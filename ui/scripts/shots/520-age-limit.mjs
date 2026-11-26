// G-52: the server's age limit (shots 550-552, 554-555; 553 has no demo option).
import { chat, shot } from './lib.mjs';

/** G-51n: General's one "Save" (שמירה / Save). */
async function pageSave(p) {
  await p.getByRole('tabpanel').getByRole('button', { name: /^(שמירה|Save)$/ }).click();
}

export default async function run() {
async function ageSettings(query, opts) {
  const p = await chat('?demo=1&still=1&update=999999&' + query, 'x', opts);
  await p.getByRole('button', { name: /הגדרות השרת|Server settings/ }).first().click();
  await p.locator('.age-limit').waitFor();
  return p;
}
{
  // 550: from the demo's limit to 18+.
  const p = await ageSettings('lang=he&theme=light');
  await p.locator('.age-limit input[value="18+"]').check();
  await pageSave(p);
  await p.getByRole('dialog', { name: 'להגביל את השרת לגיל 18 ומעלה?' }).waitFor();
  await p.waitForTimeout(200);
  await shot(p, '550-age-raise-dialog-he');
  // Confirm, then lower again: 551 (unticked).
  await p.getByRole('button', { name: 'הגבלה ל-18+' }).click();
  await p.locator('.general-actions .success').waitFor();
  await p.locator('.age-limit input[value="16+"]').check();
  await pageSave(p);
  await p.getByRole('dialog', { name: 'לפתוח את השרת גם לבני 16 ו-17?' }).waitFor();
  await p.waitForTimeout(200);
  await shot(p, '551-age-lower-dialog-he');
  await p.close();
}
{
  const p = await ageSettings('lang=en&theme=dark', { colorScheme: 'dark' });
  await p.locator('.age-limit input[value="18+"]').check();
  await pageSave(p);
  await p.getByRole('button', { name: 'Limit to 18+' }).click();
  await p.locator('.general-actions .success').waitFor();
  await p.locator('.age-limit input[value="16+"]').check();
  await pageSave(p);
  const d = p.getByRole('dialog', { name: 'Open this server to 16- and 17-year-olds too?' });
  await d.getByRole('checkbox').check();
  await p.waitForTimeout(200);
  await shot(p, '552-age-lower-dialog-checked-en-dark');
  await p.close();
}
{
  // 554: after raising to 18+, the owner sees who has no 18+ claim in the member list.
  const p = await ageSettings('lang=he&theme=light');
  await p.locator('.age-limit input[value="18+"]').check();
  await pageSave(p);
  await p.getByRole('button', { name: 'הגבלה ל-18+' }).click();
  await p.locator('.general-actions .success').waitFor();
  await p.keyboard.press('Escape');
  await p.getByText('ללא אישור 18+').first().waitFor();
  await p.mouse.move(0, 0);
  await p.waitForTimeout(200);
  await shot(p, '554-age-not-adult-tag-he');
  await p.close();
}
{
  // 555: a minor's server was raised to 18+: the toast says why it's gone.
  const p = await chat('?demo=1&still=1&update=999999&lang=he&theme=light&ageRemoved=1', 'x');
  await p.getByText('מוגבל עכשיו לגיל 18 ומעלה').waitFor();
  await p.mouse.move(0, 0);
  await p.waitForTimeout(200);
  await shot(p, '555-age-removed-toast-he');
  await p.close();
}
}
