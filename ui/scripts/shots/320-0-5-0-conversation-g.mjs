import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- 0.5.0 conversation (440-449): G-23 date divider, 448 ---------------------------
  for (const [query, name, opts] of [
    ['lang=he&theme=light', '448-date-divider-he', undefined],
  ]) {
    // Ten hours between messages, so the last screen crosses days.
    const p = await chat(`?demo=1&still=1&update=999999&gapHours=10&${query}`, 'x', opts);
    await p.locator('.date-divider').first().waitFor();
    await p.waitForTimeout(300);
    await shot(p, name);
    await p.close();
  }
}
