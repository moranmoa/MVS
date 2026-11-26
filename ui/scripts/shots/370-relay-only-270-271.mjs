import { shot, chat } from './lib.mjs';

export default async function run() {
  // Relay-only (#272): 270–271.
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&relayOnly=1&settings=privacy', 'x');
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    await p.getByRole('switch', { name: 'ממסר בלבד' }).waitFor();
    await shot(p, '270-settings-privacy-relay-only-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&relayOnly=1', 'x');
    await p.locator('.voice-room-reason').waitFor();
    await shot(p, '271-voice-room-relay-only-he');
    await p.close();
  }
}
