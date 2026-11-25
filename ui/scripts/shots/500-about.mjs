import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- About (B24a: 140, 144) ---------------------------------------------------
  for (const [query, name] of [
    ['lang=he&theme=light', '140-about-he'],
    ['lang=he&theme=light&abuse=1', '144-about-abuse-address-he'],
  ]) {
    const p = await chat('?demo=1&still=1&update=999999&' + query, 'x');
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    await p.getByRole('button', { name: 'אודות' }).click();
    await p.locator('.about-report').waitFor();
    await p.waitForTimeout(200);
    await shot(p, name);
    await p.close();
  }
}
