import { page, shot } from './lib.mjs';

export default async function run() {
  // ---- T8-01: the core is not answering (220-222) -----------------------------------
  for (const [detail, name] of [
    ['crash-loop', '220-core-down-crash-loop-he'],
    ['missing', '221-core-down-missing-he'],
    ['keyring', '222-core-down-keyring-he'],
  ]) {
    const p = await page(`?demo=1&still=1&lang=he&theme=light&update=999999&coreDown=${detail}`);
    await p.getByRole('heading', { name: 'MVS לא מצליחה לפעול כרגע' }).waitFor();
    await shot(p, name);
    await p.close();
  }
}
