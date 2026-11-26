import { chat, joinRoom, shot } from './lib.mjs';

export default async function run() {
  // ---- #622: a required update ends the call at once, with a toast (564, update-required.md §4) ----
  {
    // update=300: the update is already staged, so the toast carries "Restart and update".
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=300&requiredInCall=600', 'x');
    await p.getByRole('button', { name: /עדכון/ }).first().waitFor();
    await joinRoom(p);
    await p.getByRole('alert').filter({ hasText: 'השיחה הסתיימה' }).waitFor();
    await p.waitForTimeout(200);
    await shot(p, '564-update-required-call-ended-he');
    await p.close();
  }
}
