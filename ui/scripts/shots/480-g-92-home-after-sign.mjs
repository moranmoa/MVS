import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-92 Home after sign-up and the inline join field (510-512) ------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    // As if sign-up just finished (Onboarding sets this flag).
    await p.evaluate(() => localStorage.setItem('mvs.home.firstRun.v1', '1'));
    await p.getByRole('button', { name: 'בית', exact: true }).first().click();
    await p.locator('.home h1').waitFor();
    await p.mouse.move(1, 1);
    await shot(p, '510-home-first-run-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
    await p.getByRole('button', { name: 'Home', exact: true }).first().click();
    await p.getByRole('textbox', { name: 'Paste an invite link' }).fill('mvs://join/0f3a9c2e…');
    await p.mouse.move(1, 1);
    await shot(p, '511-home-join-paste-en-dark');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'בית', exact: true }).first().click();
    const field = p.getByRole('textbox', { name: 'הדבקת קישור הזמנה' });
    await field.fill('שלום, הנה הקישור');
    await field.press('Enter');
    await p.locator('#join-paste-error').waitFor();
    await p.mouse.move(1, 1);
    await shot(p, '512-home-join-invalid-he');
    await p.close();
  }
}
