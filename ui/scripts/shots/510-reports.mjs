// G-48: report to the owners (shots 600-604). The report dialog, the staff
// Reports dialog from the rail menu, evidence behind a click, and the
// no-recipient abuse line.
import { chat, shot } from './lib.mjs';

/** Right-click someone else's message and choose "Report" (דיווח / Report). */
async function reportAMessage(p, reportLabel) {
  // The demo account is מורן in both languages: someone else's message.
  const others = p.getByRole('article').filter({ hasNotText: 'מורן' });
  await others.nth(2).dispatchEvent('contextmenu');
  await p.getByRole('menuitem', { name: reportLabel, exact: true }).dispatchEvent('click');
  return p.getByRole('dialog');
}

export default async function run() {
  // 600: the report dialog, reason 6 chosen (the 105 line shows).
  {
    const p = await chat('?demo=1&still=1&update=999999&lang=he&theme=light', 'x');
    const d = await reportAMessage(p, 'דיווח');
    await d.getByRole('radio', { name: 'מעורבים קטינים' }).check();
    await d.locator('.report-help').waitFor();
    await shot(p, '600-report-dialog-minor-he');
    await p.close();
  }
  // 601: the same in English, dark, with self-harm (the 101 / ERAN line).
  {
    const p = await chat('?demo=1&still=1&update=999999&lang=en&theme=dark', 'x', { colorScheme: 'dark' });
    const d = await reportAMessage(p, 'Report');
    await d.getByRole('radio', { name: 'Self-harm' }).check();
    await d.locator('.report-help').waitFor();
    await shot(p, '601-report-dialog-self-harm-en-dark');
    await p.close();
  }
  // 602: the staff Reports dialog, opened from the rail menu (the flag shows on the rail).
  // 603: a reason-5 report's "Show content", asking before it shows.
  {
    const p = await chat('?demo=1&still=1&update=999999&lang=he&theme=light', 'x');
    await p.locator('.rail-reports').first().waitFor();
    await p.locator('.rail button[data-server-id]').first().dispatchEvent('contextmenu');
    await p.getByRole('menuitem', { name: /^דיווחים/ }).dispatchEvent('click');
    const d = p.getByRole('dialog', { name: /^דיווחים – / });
    await d.locator('.report-item').first().waitFor();
    await p.waitForTimeout(200);
    await shot(p, '602-reports-staff-dialog-he');
    const sexual = d.locator('.report-item').filter({ hasText: 'תוכן מיני' });
    await sexual.getByRole('button', { name: 'הצגת התוכן' }).click();
    await sexual.getByRole('alertdialog').waitFor();
    await sexual.scrollIntoViewIfNeeded();
    await shot(p, '603-reports-evidence-warning-he');
    await p.close();
  }
  // 604: nobody can receive the report; the build's abuse address is offered.
  {
    const p = await chat('?demo=1&still=1&update=999999&lang=he&theme=light&noRecipient=1&abuse=1', 'x');
    const d = await reportAMessage(p, 'דיווח');
    await d.getByRole('radio', { name: 'ספאם' }).check();
    await d.getByRole('button', { name: 'שליחת הדיווח' }).click();
    await d.getByRole('alert').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '604-report-no-recipient-abuse-he');
    await p.close();
  }
}
