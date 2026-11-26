import { chat, shot } from './lib.mjs';

/** A 256×256 PNG drawn in the page (a coloured square with a mark), as a file buffer. */
async function samplePng(p) {
  const b64 = await p.evaluate(async () => {
    const c = new OffscreenCanvas(256, 256);
    const g = c.getContext('2d');
    g.fillStyle = '#2b6cb0';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f6e05e';
    g.beginPath();
    g.arc(128, 128, 70, 0, Math.PI * 2);
    g.fill();
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  return { name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

async function openGeneral(p, label) {
  await p.getByRole('button', { name: label }).first().click();
  const panel = p.getByRole('tabpanel');
  await panel.waitFor();
  return panel;
}

export default async function run() {
  // ---- G-51 server icon and description (540-543, server-icon-description.md) ----
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const panel = await openGeneral(p, 'הגדרות השרת');
    await panel.getByRole('textbox', { name: 'תיאור' }).fill('ערב משחקים כל חמישי ב-21:00.\nמי שמחפש קבוצה מוזמן לערוץ מחפשים-קבוצה.');
    await panel.locator('input[type="file"]').setInputFiles(await samplePng(p));
    await panel.locator('.server-icon-preview img').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '540-server-general-edit-he');
    await shot(p, '541-server-icon-crop-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
    const panel = await openGeneral(p, 'Server settings');
    await panel.locator('input[type="file"]').setInputFiles(await samplePng(p));
    await panel.locator('.server-icon-preview img').waitFor();
    await panel.getByRole('textbox', { name: 'Description' }).fill('Game night every Thursday at 21:00.');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByText('Changes saved').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '542-server-general-saved-en-dark');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&serverIconRateLimited=1', 'x');
    const panel = await openGeneral(p, 'הגדרות השרת');
    await panel.locator('input[type="file"]').setInputFiles(await samplePng(p));
    await panel.locator('.server-icon-preview img').waitFor();
    await panel.getByRole('button', { name: 'שמירה', exact: true }).click();
    await panel.getByRole('alert').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '543-server-icon-error-he');
    await p.close();
  }
}
