import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-01: reorder my servers in the rail (320-329) --------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const items = p.locator('.rail li[data-server-li]');
    const third = await items.nth(2).locator('button.rail-button').boundingBox();
    const first = await items.nth(0).locator('button.rail-button').boundingBox();
    await p.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
    await p.mouse.down();
    await p.mouse.move(third.x + third.width / 2, third.y + third.height / 2 - 10, { steps: 2 });
    await p.mouse.move(first.x + first.width / 2 + 6, first.y + 6, { steps: 6 });
    await p.locator('.rail li.drop-before').waitFor();
    await shot(p, '320-server-order-drag-he');
    await p.mouse.up();
    await p.waitForTimeout(200);
    await shot(p, '321-server-order-dropped-he');
    await p.close();
  }
  {
    const p = await page('?demo=1&still=1&lang=he&theme=light&update=999999', { width: 375, height: 812, phone: true });
    const rail = p.locator('.rail');
    await rail.locator('button[data-server-id]').first().waitFor();
    await rail.locator('button[data-server-id]').first().dispatchEvent('contextmenu');
    await p.getByRole('menuitem', { name: 'שינוי סדר השרתים' }).click();
    await rail.locator('.rail-arrange').first().waitFor();
    await p.waitForTimeout(200);
    await shot(p, '322-server-order-phone-he');
    await p.close();
  }
  // G-05 / G-06 in the rail: the mention count apart from the pip, and the tooltip
  // with the full server name (hover).
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.locator('.rail button[data-server-id]').first().hover();
    await p.locator('.rail-tip').waitFor();
    await p.waitForTimeout(150);
    await shot(p, '323-rail-tooltip-he');
    await p.close();
  }
}
