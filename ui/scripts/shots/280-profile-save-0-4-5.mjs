import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- profile save, 0.4.5 (400-409, docs/ux/specs/profile-save.md) ----------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.locator('.me-profile').click();
    const dialog = p.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'ורוד' }).click();
    await p.waitForTimeout(200);
    // A draft: only the preview card has the new colour.
    await shot(p, '401-profile-draft-preview-only-he');
    await dialog.locator('.profile-actions .primary').click();
    await dialog.locator('.profile-actions .success').waitFor();
    await shot(p, '400-profile-saved-everywhere-he');
    await p.close();
  }
}
