import { shot, chat, joinRoom } from './lib.mjs';

export default async function run() {
  // ---- voice v1, pieces E and E2: the voice room and the call bar (240-249) -------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&voiceP2p', 'x'); // 243: the notice v3 (G-81 B on)
    await p.locator('.voice-room-people li').first().waitFor();
    await shot(p, '245-voice-room-he');
    await p.locator('.voice-room-row').first().click();
    await p.getByRole('dialog').waitFor();
    await shot(p, '243-call-ip-notice-he');
    await p.getByRole('dialog').getByRole('button', { name: 'הבנתי' }).click();
    const bar = p.getByRole('region', { name: 'שיחה קולית' });
    await bar.waitFor();
    await bar.getByRole('button', { name: 'השתקה' }).click();
    await bar.locator('button[aria-pressed="true"]').waitFor();
    await shot(p, '240-call-bar-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&callError=relay-only', 'x');
    await joinRoom(p);
    await p.locator('.voice-room-reason').waitFor();
    await shot(p, '241-call-relay-only-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&roomFull=1', 'x');
    await p.locator('.voice-room-count.full').waitFor();
    await shot(p, '242-call-full-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
    await p.locator('.voice-room-people li').first().waitFor();
    await shot(p, '246-voice-room-en-dark');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=light&update=999999&voiceP2p', 'x'); // 244: the notice v3 (G-81 B on)
    await p.locator('.voice-room-row').first().click();
    await p.getByRole('dialog').waitFor();
    await shot(p, '244-call-ip-notice-en-light');
    await p.close();
  }
  for (const [sim, name, wait] of [
    ['noMic', '247-call-no-mic-he', '.call-no-mic'],
    ['peerFailed', '248-call-peer-failed-he', '.call-peer-failed'],
    ['peerRefused', '249-call-peer-refused-he', '.call-peer-failed.refused'],
  ]) {
    const p = await chat(`?demo=1&still=1&lang=he&theme=light&update=999999&voiceSim=${sim}`, 'x');
    await joinRoom(p);
    await p.locator(wait).waitFor();
    await p.waitForTimeout(300);
    await shot(p, name);
    await p.close();
  }
}
