import { shot, chat } from './lib.mjs';

export default async function run() {
  // Notifications and mute (G-61, G-03, G-17) and mark all as read (G-04): 360, 351.
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const channels = p.getByRole('navigation', { name: 'ערוצים' });
    await channels.getByRole('button', { name: /^clips/ }).click({ button: 'right' });
    await p.getByRole('menuitem', { name: 'התראות' }).click();
    await p.getByRole('dialog', { name: /^התראות של/ }).waitFor();
    await shot(p, '360-notify-dialog-channel-he');
    await p.getByRole('button', { name: 'עד שאבטל' }).click();
    await p.keyboard.press('Escape');
    await p.getByRole('button', { name: /^Minecraft IL/ }).click({ button: 'right' });
    await p.getByRole('menuitem', { name: 'התראות' }).click();
    await p.getByRole('button', { name: 'ל-8 שעות' }).click();
    await p.keyboard.press('Escape');
    await p.mouse.move(1, 1);
    await shot(p, '351-muted-server-and-channel-he');
    await p.evaluate(() => localStorage.removeItem('mvs.mute.v1'));
    await p.close();
  }
}
