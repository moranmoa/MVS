import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- #288: messages held for the channel key (280-289) ----------------------
  for (const [mode, name, wait] of [
    ['wait', '280-held-sending-he', '.send-state.held.pending'],
    ['fail', '281-held-failed-he', '.send-state.held.failed'],
  ]) {
    const p = await chat(`?demo=1&still=1&lang=he&theme=light&update=999999&keyPending=${mode}`, 'x');
    const box = p.getByRole('textbox', { name: /כתיבה ב/ });
    await box.fill('הצטרפתי עכשיו, שלום לכולם');
    await box.press('Enter');
    await p.locator(wait).waitFor();
    await p.waitForTimeout(300);
    await shot(p, name);
    await p.close();
  }
}
