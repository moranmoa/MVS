import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- B7 / #306: a birth-date correction waiting its 30 days (310-319) -------
  for (const [name, opts] of [
    ['310-account-dob-pending-he', {}],
    ['311-account-dob-pending-phone-he', { width: 375, height: 812, phone: true }],
  ]) {
    const query = '?demo=1&still=1&lang=he&theme=light&update=999999&pendingDob=1&settings=account';
    const p = opts.phone ? await page(query, opts) : await chat(query, 'x');
    if (opts.phone) await p.getByRole('button', { name: 'הגדרות' }).first().click();
    else await p.locator('.me-profile').click();
    const pending = p.locator('.dob-pending');
    await pending.waitFor();
    await pending.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await shot(p, name);
    await p.close();
  }
}
