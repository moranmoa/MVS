import { page, shot } from './lib.mjs';

export default async function run() {
  // Restore (#290): 290–291. The restore asks the agreement, country and birth date
  // first, then the words, the name, and ends on the servers notice.
  {
    const p = await page('?fresh=1&lang=he&theme=light');
    await p.getByRole('button', { name: 'כבר יש לי חשבון' }).click();
    await p.getByRole('checkbox').check();
    await shot(p, '290-restore-agreement-he');
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByRole('button', { name: 'המשך' }).click();
    await p.getByLabel('יום').fill('12');
    await p.getByLabel('חודש').fill('4');
    await p.getByLabel('שנה').fill('2001');
    await p.getByRole('button', { name: 'המשך' }).click();
    const words = 'apple river stone cloud tiger piano lemon rocket forest candle silver garden';
    await p.getByLabel('מילה 1', { exact: true }).focus();
    await p.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text', text);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, words);
    await p.getByRole('button', { name: 'שחזור' }).click();
    await p.getByLabel('שם תצוגה').fill('מורן');
    await p.getByRole('button', { name: 'סיום' }).click();
    await p.getByRole('heading', { name: 'החשבון שוחזר' }).waitFor();
    await shot(p, '291-restore-servers-notice-he');
    await p.close();
  }
}
