import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-26 reactions (441-442, chat-and-voice-extras.md §2-3) -----------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const row = p.locator('[role=article]:has(.msg:not(.skeleton))').last();
    // G-27: the full picker renders only visible rows, so pick through search.
    for (const name of ['אגודל למעלה', 'אש', 'פרצוף עם דמעות שמחה']) {
      await row.hover();
      await row.getByRole('button', { name: "הוספת אמוג'י" }).first().click();
      await p.getByRole('dialog').getByRole('searchbox').fill(name);
      await p.getByRole('dialog').getByRole('gridcell', { name, exact: true }).click();
      await p.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await row.locator('.reactions').waitFor();
    await p.mouse.move(1, 1);
    await shot(p, '441-reactions-he');
    await row.hover();
    await row.getByRole('button', { name: "הוספת אמוג'י" }).first().click();
    await p.getByRole('dialog').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '442-emoji-picker-he');
    await p.close();
  }
}
