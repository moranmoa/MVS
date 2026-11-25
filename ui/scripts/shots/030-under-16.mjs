import { page, shot } from './lib.mjs';

export default async function run() {
  // ---- under 16 ---------------------------------------------------------------
  {
    const p = await page('?fresh=1&lang=he&theme=dark', { colorScheme: 'dark' });
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('checkbox').check();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByLabel('יום').fill('1');
    await p.getByLabel('חודש').fill('1');
    await p.getByLabel('שנה').fill(String(new Date().getFullYear() - 13));
    await p.getByRole('button', { name: 'המשך' }).click();
    await shot(p, '11-onboarding-under-16-dark');
    await p.close();
  }
}
