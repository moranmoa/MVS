import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- device link (420-429, device-link-slice.md) -----------------------------
  for (const [query, name, wait] of [
    ['lang=he&theme=light', '420-device-link-waiting-he', '.qr-code'],
    ['lang=he&theme=light&deviceLink=confirm', '421-device-link-digits-he', '.device-link-sas'],
    ['lang=he&theme=light&deviceLink=expired', '422-device-link-expired-he', '.device-link .error'],
    ['lang=en&theme=light', '425-device-link-waiting-en-light', '.qr-code'],
  ]) {
    const p = await page(`?fresh=1&${query}`);
    await p.locator('.onb-card .actions .link').last().click();
    await p.locator(wait).waitFor();
    await p.waitForTimeout(200);
    await shot(p, name);
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    await p.getByRole('button', { name: 'מכשירים' }).click();
    await p.getByRole('button', { name: 'הוספת מכשיר' }).click();
    const input = p.locator('.device-code-input');
    await input.fill('K7QX2 MZRF4');
    await shot(p, '423-devices-code-he');
    await p.locator('.devices form button[type=submit]').click();
    await p.locator('.device-compare').waitFor();
    await shot(p, '424-devices-compare-he');
    await p.close();
  }
}
