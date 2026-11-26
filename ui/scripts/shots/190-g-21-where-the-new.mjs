import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-21: where the new messages start (340-349) ----------------------------
  for (const [channel, name, wait] of [
    [/^מחפשים-קבוצה/, '340-new-messages-divider-he', '.unread-divider'],
    [/^clips/, '341-new-messages-bar-he', '.unread-bar'],
  ]) {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('navigation', { name: 'ערוצים' }).getByRole('button', { name: channel }).click();
    await p.locator(wait).waitFor();
    await p.waitForTimeout(400);
    await shot(p, name);
    await p.close();
  }
}
