import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- "a new device was added" (430-439) --------------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&deviceLinked=Windows', 'x');
    await p.locator('.device-notice').waitFor();
    await shot(p, '430-device-notice-he');
    await p.locator('.device-notice .danger').click();
    await p.locator('.device-notice-help').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '431-device-notice-help-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999&deviceLinked=', 'x', { colorScheme: 'dark' });
    await p.locator('.device-notice').waitFor();
    await shot(p, '432-device-notice-unknown-en-dark');
    await p.close();
  }
}
