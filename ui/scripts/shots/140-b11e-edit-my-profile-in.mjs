import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- B11e: edit my profile in Settings → Account (90-99) --------------------
  // 94 (onboarding, no Skip), 95 (profile card with bio and banner) and 96 (long
  // name at 200%) wait for the onboarding change and the banner.
  for (const [query, name, opts, steps] of [
    ['lang=he&theme=light', '90-account-he', {}, 'open'],
    ['lang=he&theme=light', '91-account-dirty-he', {}, 'dirty'],
    ['lang=en&theme=light', '92-account-en-light', {}, 'open'],
    ['lang=he&theme=light&profileError=1', '93-account-save-error-he', {}, 'error'],
    ['lang=he&theme=light', '97-account-phone-he', { width: 375, height: 812, phone: true }, 'dirty'],
    // #362: a light custom colour gets a dark letter; "צבע אחר" is ticked.
    ['lang=he&theme=dark', '98-account-color-custom-dark-he', { colorScheme: 'dark' }, 'custom'],
  ]) {
    const p = opts.phone
      ? await page(`?demo=1&still=1&update=999999&settings=account&${query}`, opts)
      : await chat(`?demo=1&still=1&update=999999&${query}`, 'x', opts);
    if (opts.phone) {
      await p.getByRole('button', { name: 'הגדרות' }).first().click();
    } else {
      await p.locator('.me-profile').click();
    }
    const dialog = p.getByRole('dialog');
    const field = dialog.locator('.profile-editor input:not([type=file]):not([type=color])');
    await field.waitFor();
    if (steps !== 'open') {
      await field.fill(name.includes('-en') ? 'Moran B' : 'מורן ב.');
      await dialog.locator('.profile-editor textarea').fill('גיימרית בלילות, מתכנתת בימים');
    }
    // #362: the palette is a radio group; dirty shots pick pink, custom picks a light yellow.
    if (steps === 'dirty') await dialog.getByRole('radio').nth(3).click();
    if (steps === 'custom') {
      await dialog.locator('.color-custom input').fill('#ffd43b');
      // Show the preview (dark letter on yellow) with the picker under it.
      await p.evaluate(() => (document.activeElement)?.blur());
      await dialog.locator('.profile-editor').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    }
    if (steps === 'error') {
      await dialog.locator('.profile-actions .primary').click();
      await dialog.locator('.profile-actions .error').waitFor();
    }
    await p.waitForTimeout(300);
    await shot(p, name);
    await p.close();
  }
}
