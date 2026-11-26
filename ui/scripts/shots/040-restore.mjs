import { page, shot } from './lib.mjs';

export default async function run() {
  // ---- restore ----------------------------------------------------------------
  {
    const p = await page('?fresh=1&lang=he&theme=light');
    await p.getByRole('button', { name: 'כבר יש לי חשבון' }).click();
    // Since #290 the restore asks the agreement, country and birth date first.
    await p.getByRole('checkbox').check();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByLabel('יום').fill('12');
    await p.getByLabel('חודש').fill('4');
    await p.getByLabel('שנה').fill('2001');
    await p.getByRole('button', { name: 'המשך' }).click();
    const words = 'apple river stone cloud tiger piano lemon rockett forest candle silver garden';
    await p.getByLabel('מילה 1', { exact: true }).focus();
    await p.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text', text);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, words);
    await p.getByRole('button', { name: 'שחזור' }).click();
    await p.getByRole('alert').waitFor();
    await shot(p, '12-restore-with-typo');
    await p.close();
  }
}
