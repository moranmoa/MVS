import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-29 typing (440, chat-and-voice-extras.md) --------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&typing=1', 'x');
    await p.locator('.typing-text').waitFor();
    await p.waitForTimeout(200);
    await shot(p, '440-typing-he');
    await p.close();
  }
}
