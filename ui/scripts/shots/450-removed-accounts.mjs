import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- removed accounts (187, G-53, B11) ----------------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'הגדרות השרת' }).click();
    await p.getByRole('tab', { name: 'חברים' }).click();
    const panel = p.getByRole('tabpanel');
    // Remove two members (each from the list, then confirm on their card).
    for (let i = 0; i < 2; i++) {
      await panel.getByRole('button', { name: 'הרחקה מהשרת' }).nth(1).click();
      await p.getByRole('alertdialog').getByRole('button', { name: 'הרחקה', exact: true }).click();
      await p.getByRole('alertdialog').waitFor({ state: 'detached' });
    }
    await p.getByRole('tab', { name: 'חשבונות שהורחקו' }).click();
    await p.locator('.removed-accounts .removed-row').nth(1).waitFor();
    await p.waitForTimeout(250);
    await shot(p, '187-server-settings-removed-he');
    await p.close();
  }
}
