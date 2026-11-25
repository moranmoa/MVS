import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- blocked accounts (470-472, G-47) ----------------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    // Block two members from their profile cards.
    for (const i of [1, 2]) {
      await p.locator('.members button.member').nth(i).click();
      await p.getByRole('dialog').getByRole('button', { name: 'חסימה', exact: true }).click();
      await p.keyboard.press('Escape');
    }
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    await p.getByRole('button', { name: 'פרטיות' }).click();
    const list = p.locator('.blocked-list');
    await list.locator('.blocked-row').nth(1).waitFor();
    await list.scrollIntoViewIfNeeded();
    await p.waitForTimeout(200);
    await shot(p, '470-blocked-list-he');
    await list.locator('.blocked-row button').first().click();
    await list.locator('.blocked-undo').waitFor();
    await shot(p, '472-blocked-undo-toast-he');
    await list.locator('.blocked-row button').first().click();
    await list.getByText('לא חסמת אף אחד.').waitFor();
    await p.waitForTimeout(5200); // the Undo bar goes away
    await shot(p, '471-blocked-empty-he');
    await p.close();
  }
}
