import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-24: mentions (370-379) -------------------------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const box = p.getByRole('textbox', { name: /כתיבה ב/ });
    await box.fill('');
    await box.pressSequentially('מי בא הערב @א');
    await p.locator('.mention-suggestions').waitFor();
    await shot(p, '370-mention-suggestions-he');
    await box.press('Enter');
    await box.pressSequentially('?');
    await box.press('Enter');
    await box.fill(`תודה ל-<@${'b'.repeat(64)}> על המפה`);
    await box.press('Enter');
    await p.locator('.mention-chip.former').waitFor();
    await p.waitForTimeout(400);
    await shot(p, '371-mention-chips-he');
    await p.close();
  }
}
