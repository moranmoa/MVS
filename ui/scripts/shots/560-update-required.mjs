import { chat, joinRoom, shot } from './lib.mjs';

/** The required banner in one state (update-required.md §1–2), waiting for its line. */
async function bannerShot(query, line, name, opts) {
  const p = await chat(`?demo=1&still=1&update=999999&${query}`, 'x', opts);
  await p.getByRole('region').filter({ hasText: line }).waitFor();
  await p.mouse.move(0, 0);
  await p.waitForTimeout(200);
  await shot(p, name);
  await p.close();
}

export default async function run() {
  // ---- #577 / #622: the required update, read-only with a banner (560-565) ----
  await bannerShot('lang=he&theme=light&required=downloading', 'מורידים את העדכון', '560-update-required-downloading-he');
  await bannerShot('lang=he&theme=light&required=ready', 'העדכון מוכן', '561-update-required-ready-he');
  await bannerShot('lang=en&theme=dark&required=offline', "Can't reach updates", '562-update-required-offline-en-dark', { colorScheme: 'dark' });
  await bannerShot('lang=he&theme=light&required=not-available', 'עדיין אין גרסה חדשה', '563-update-required-not-available-he');
  {
    // update=300: the update is already staged, so the toast carries "Restart and update".
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=300&requiredInCall=600', 'x');
    await p.getByRole('button', { name: /עדכון/ }).first().waitFor();
    await joinRoom(p);
    await p.getByRole('alert').filter({ hasText: 'השיחה הסתיימה' }).waitFor();
    await p.mouse.move(0, 0);
    await p.waitForTimeout(200);
    await shot(p, '564-update-required-call-ended-he');
    await p.close();
  }
  {
    // A draft typed before the requirement arrived stays, read-only (§4, AC 4a).
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&requiredInCall=2500', 'x');
    await joinRoom(p);
    await p.getByRole('textbox', { name: /^כתיבה ב/ }).fill('רגע, אני רק מסיים לכתוב את');
    await p.getByRole('region').filter({ hasText: 'צריך לעדכן את MVS' }).waitFor();
    await p.getByRole('textbox', { name: /^כתיבה ב/ }).focus();
    await p.mouse.move(0, 0);
    await p.waitForTimeout(8500);
    await shot(p, '565-update-required-composer-disabled-he');
    await p.close();
  }
}
