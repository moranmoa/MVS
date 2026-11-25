import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-11: the owner reorders the channels (330-339) -------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const rows = p.locator('.channel-list li.channel-row');
    const third = rows.nth(2);
    await third.hover();
    const handle = await third.locator('.channel-handle').boundingBox();
    const first = await rows.nth(0).boundingBox();
    await p.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await p.mouse.down();
    await p.mouse.move(handle.x + handle.width / 2, handle.y - 10, { steps: 2 });
    await p.mouse.move(handle.x + 40, first.y + 6, { steps: 6 });
    await p.locator('.channel-row.drop-before').waitFor();
    await shot(p, '330-channel-order-drag-he');
    await p.mouse.up();
    await p.waitForTimeout(300);
    await shot(p, '331-channel-order-dropped-he');
    await p.close();
  }
  {
    const p = await page('?demo=1&still=1&lang=he&theme=light&update=999999', { width: 375, height: 812, phone: true });
    const row = p.locator('.channel-list li.channel-row button.channel').first();
    await row.waitFor();
    await row.dispatchEvent('contextmenu');
    await p.getByRole('menuitem', { name: 'שינוי סדר הערוצים' }).click();
    await p.locator('.channel-arrange').first().waitFor();
    await p.waitForTimeout(200);
    await shot(p, '332-channel-order-phone-he');
    await p.close();
  }
}
