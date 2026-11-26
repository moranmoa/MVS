import { page, shot, PHONE_ROOMS, chat, ROOMS, sidebarShot } from './lib.mjs';

export default async function run() {
  // ---- voice rooms, 0.4.3 (380-389, docs/ux/specs/voice-rooms.md) ------------
  {
    const p = await chat(`${ROOMS}&voiceRooms=2`, 'x');
    await p.locator('.voice-room-row').nth(1).waitFor();
    await sidebarShot(p, '380-voice-rooms-two-he');
    await p.close();
  }
  {
    const p = await chat(`${ROOMS}&voiceRooms=2&roomFull=1`, 'x');
    await p.locator('.voice-room-count.full').waitFor();
    await p.locator('.voice-room-row').first().hover();
    await sidebarShot(p, '381-voice-room-full-he');
    await p.close();
  }
  {
    // The host's menu: open a room (IP notice first), then its menu.
    const p = await chat(`${ROOMS}&voiceRooms=1`, 'x');
    await p.locator('.voice-root').click();
    await p.getByRole('dialog').getByRole('button', { name: 'הבנתי' }).click();
    const mine = p.locator('.voice-room-row.in-room');
    await mine.waitFor();
    // The call bar slides in under the list; the speaking ring keeps the row from settling.
    await p.waitForTimeout(500);
    await mine.click({ button: 'right', force: true });
    await p.getByRole('menu').waitFor();
    await shot(p, '382-voice-room-menu-master-he');
    await p.getByRole('menuitem', { name: 'שינוי שם' }).click();
    const field = p.getByRole('textbox', { name: 'שינוי שם' });
    await field.fill('ערב משחקים');
    await sidebarShot(p, '383-voice-room-rename-he');
    await p.close();
  }
  {
    const p = await page('?demo=1&still=1&lang=he&theme=dark&update=999999&voiceRooms=2', { ...PHONE_ROOMS, colorScheme: 'dark' });
    const row = p.locator('.voice-room-row').nth(1);
    await row.waitFor();
    await p.locator('.voice-rooms').scrollIntoViewIfNeeded();
    await p.mouse.move(1, 1);
    await shot(p, '384-voice-rooms-phone-he');
    // Long-press (here: the context menu) opens the bottom sheet (B25 §5).
    await row.click({ button: 'right' });
    await p.getByRole('menu').waitFor();
    await p.waitForTimeout(300);
    await shot(p, '386-voice-room-sheet-phone-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=light&update=999999&voiceRooms=2', 'x');
    await p.locator('.voice-room-row').nth(1).waitFor();
    await sidebarShot(p, '385-voice-rooms-en-light');
    await p.close();
  }
  {
    // 10 rooms: the pinned row is off with the cap reason; 8 listed, "2 more rooms".
    const p = await chat(`${ROOMS}&voiceRooms=10`, 'x');
    await p.locator('.voice-rooms-more').waitFor();
    await p.locator('.voice-root').scrollIntoViewIfNeeded();
    await shot(p, '387-voice-rooms-cap-he');
    await p.close();
  }
}
