import { shot, chat } from './lib.mjs';

export default async function run() {
  // Server lifecycle (#261): 250–256.
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'הגדרות השרת' }).click();
    await p.getByRole('tab', { name: 'כללי' }).waitFor();
    await p.getByLabel('שם השרת').fill('גיימרים ישראל HQ');
    await shot(p, '250-server-rename-he');
    await p.getByRole('tab', { name: 'אזור מסוכן' }).click();
    await shot(p, '251-server-danger-zone-he');
    await p.getByRole('button', { name: 'סגירת השרת…' }).click();
    await p.getByRole('dialog', { name: /^לסגור את/ }).getByRole('textbox').fill('גיימרים ישראל');
    await shot(p, '252-server-close-confirm-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: /^Minecraft IL/ }).click({ button: 'right' });
    await p.getByRole('menu').waitFor();
    await shot(p, '253-server-menu-leave-he');
    await p.getByRole('menuitem', { name: 'עזיבת השרת' }).click();
    await p.getByRole('dialog', { name: /^לעזוב את/ }).waitFor();
    await shot(p, '254-server-leave-confirm-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&outdated=1', 'x');
    await p.getByRole('button', { name: 'הגדרות השרת' }).click();
    const panel = p.getByRole('tabpanel');
    await panel.getByLabel('שם השרת').fill('גיימרים ישראל HQ');
    await panel.getByRole('button', { name: 'שמירת השם' }).click();
    await panel.getByRole('alert').getByRole('listitem').first().waitFor();
    await shot(p, '255-server-update-needed-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&closed=1', 'x');
    await p.getByRole('button', { name: /^Minecraft IL/ }).click();
    await p.locator('.closed-banner').waitFor();
    await p.waitForTimeout(600);
    await shot(p, '256-server-closed-he');
    await p.close();
  }
}
