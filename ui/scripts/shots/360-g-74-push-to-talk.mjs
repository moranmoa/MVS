import { BASE, browser, page, problems, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-74 push to talk (446, chat-and-voice-extras.md §6) ----------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, colorScheme: 'light', locale: 'he-IL' });
    await ctx.addInitScript(() => {
      window.mvs = { setPushToTalk: async () => 'ok', onPushToTalk: () => () => {} };
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await p.goto(BASE + '?demo=1&still=1&lang=he&theme=light&update=999999');
    await p.getByRole('textbox', { name: /^כתיבה ב/ }).waitFor();
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    await p.getByRole('button', { name: 'קול' }).click();
    await p.getByRole('radio', { name: 'לחיצה לדיבור' }).check();
    const key = p.getByRole('button', { name: 'מקש לדיבור' });
    await key.click();
    await key.press('v');
    await p.locator('.voice-settings').scrollIntoViewIfNeeded();
    await shot(p, '446-push-to-talk-he');
    await p.close();
  }
}
