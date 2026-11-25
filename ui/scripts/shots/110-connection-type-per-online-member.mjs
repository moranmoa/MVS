import { OUT, problems, chat } from './lib.mjs';

export default async function run() {
  // ---- connection type per online member (#196, T20) --------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const list = p.locator('.members');
    if ((await list.locator('.connection-icon').count()) === 0) problems.push('230: no connection icons in the member list');
    const box = await list.boundingBox();
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${OUT}/230-member-connection-he.png`, clip: box });
    console.log('saved', '230-member-connection-he');
    await p.close();
  }
}
