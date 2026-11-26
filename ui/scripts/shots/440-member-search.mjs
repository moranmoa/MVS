import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- member search (473-474, G-41) -------------------------------------------
  for (const [query, name, text, dark] of [
    ['lang=he&theme=light', '473-member-search-he', 'ta', false],
    ['lang=en&theme=dark', '474-member-search-none-en-dark', 'qqqq', true],
  ]) {
    const p = await chat('?demo=1&still=1&update=999999&' + query, 'x', dark ? { colorScheme: 'dark' } : undefined);
    await p.locator('.member-search-input').fill(text);
    await p.waitForTimeout(500);
    await shot(p, name);
    await p.close();
  }
}
