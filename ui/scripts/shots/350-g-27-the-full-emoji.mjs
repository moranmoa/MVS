import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-27 the full emoji picker (450-453, emoji-picker.md) -------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const dialog = p.getByRole('dialog', { name: "הכנסת אמוג'י" });
    // Two picks first, so the recent section shows.
    for (const name of ['אש', 'לב אדום']) {
      await p.getByRole('button', { name: "הכנסת אמוג'י" }).click();
      await dialog.getByRole('searchbox').fill(name);
      await dialog.getByRole('gridcell', { name, exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await p.getByRole('button', { name: "הכנסת אמוג'י" }).click();
    await dialog.getByRole('gridcell').nth(4).hover();
    await p.waitForTimeout(200);
    await shot(p, '450-emoji-picker-he');
    await dialog.getByRole('searchbox').fill('לב');
    await p.waitForTimeout(200);
    await shot(p, '451-emoji-picker-search-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
    const dialog = p.getByRole('dialog', { name: 'Insert emoji' });
    await p.getByRole('button', { name: 'Insert emoji' }).click();
    await dialog.getByRole('tab', { name: 'Flags' }).click();
    await p.waitForTimeout(300);
    await dialog.getByRole('gridcell').first().waitFor();
    await shot(p, '452-emoji-picker-flags-en-dark');
    await p.close();
  }
  {
    const p = await page('?demo=1&still=1&lang=he&theme=light&update=999999', { width: 375, height: 812, phone: true });
    await p.getByRole('button', { name: /^כללי/ }).click();
    await p.getByRole('article').first().waitFor();
    await p.getByRole('button', { name: "הכנסת אמוג'י" }).click();
    await p.locator('.emoji-picker.sheet [role=gridcell]').first().waitFor();
    await p.waitForTimeout(200);
    await shot(p, '453-emoji-picker-sheet-he');
    await p.close();
  }
}
