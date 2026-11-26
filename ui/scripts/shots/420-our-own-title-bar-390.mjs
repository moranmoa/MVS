import { BASE, browser, page, problems, shot, joinRoom } from './lib.mjs';

export default async function run() {
  // Our own title bar (docs/ux/specs/desktop-chrome.md): 390 (he, light), 391 (en, dark),
  // 392 (close during a call). A stand-in for the shell's window bridge, with
  // our own buttons as on Linux; on Windows the OS draws them on the overlay.
  for (const [lang, theme, name, query] of [
    ['he', 'light', '390-title-bar-he-light', ''],
    ['en', 'dark', '391-title-bar-en-dark', ''],
    ['he', 'light', '392-close-in-call-he', 'call'],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, colorScheme: theme, locale: lang === 'he' ? 'he-IL' : 'en-US' });
    await ctx.addInitScript(() => {
      window.mvs = { windowFrame: 'custom', windowControl: async () => true };
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await p.goto(`${BASE}?demo=1&still=1&lang=${lang}&theme=${theme}&update=999999`);
    await p.locator('.titlebar').waitFor();
    await p.getByRole('article').first().waitFor();
    if (query === 'call') {
      await joinRoom(p);
      await p.getByRole('region', { name: 'שיחה קולית' }).waitFor();
      await p.locator('.titlebar-button.close').click();
      await p.getByRole('dialog').waitFor();
    }
    await p.waitForTimeout(500);
    await shot(p, name);
    await p.close();
  }
}
