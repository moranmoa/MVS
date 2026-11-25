import { shot, chat, joinRoom } from './lib.mjs';

export default async function run() {
  // G-84b: a deafened member in the room roster (crossed headphones instead of the mic): 449.
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await joinRoom(p);
    const bar = p.getByRole('region', { name: 'שיחה קולית' });
    await bar.waitFor();
    await bar.getByRole('button', { name: 'השתקת השמע' }).click();
    await p.getByRole('img', { name: 'השמע כבוי' }).first().waitFor();
    await p.mouse.move(1, 1);
    await shot(p, '449-roster-deafened-he');
    await p.close();
  }
}
