import { page, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- #304: sign out on this computer (300-309) ------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.locator('.me-profile').click();
    const button = p.locator('.sign-out button.danger');
    await button.scrollIntoViewIfNeeded();
    await p.waitForTimeout(200);
    await shot(p, '300-sign-out-button-he');
    await button.click();
    const dialog = p.locator('.sign-out-dialog');
    await dialog.locator('.sign-out-facts').waitFor();
    await shot(p, '301-sign-out-confirm-he');
    await dialog.getByRole('button', { name: 'המשך' }).click();
    await dialog.locator('.word-inputs').waitFor();
    await shot(p, '302-sign-out-words-he');
    await dialog.getByRole('button', { name: 'אין לי את המילים' }).click();
    await dialog.locator('.field input').fill('יציאה בלי מילים');
    await shot(p, '303-sign-out-no-words-he');
    await dialog.getByRole('button', { name: 'יציאה בלי מילים' }).click();
    await p.getByText('כבר יש לי חשבון').waitFor();
    await p.waitForTimeout(300);
    await shot(p, '305-after-sign-out-he');
    await p.close();
  }
  {
    const p = await page('?demo=1&still=1&lang=he&theme=light&update=999999&settings=account', { width: 375, height: 812, phone: true });
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    const button = p.locator('.sign-out button.danger');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await p.locator('.sign-out-dialog .sign-out-facts').waitFor();
    await p.waitForTimeout(300);
    await shot(p, '304-sign-out-confirm-phone-he');
    await p.close();
  }
}
