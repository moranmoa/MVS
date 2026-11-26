import { shot, chat, joinRoom } from './lib.mjs';

export default async function run() {
  // G-72 voice settings (UX spec #427 §4): 443 (Settings → קול outside a call),
  // 447 (the in-call Voice settings dialog).
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    await p.getByRole('button', { name: 'קול', exact: true }).click();
    await p.getByRole('combobox', { name: 'רמקולים' }).waitFor();
    await shot(p, '443-voice-settings-he');
    await p.keyboard.press('Escape');
    await joinRoom(p);
    const bar = p.getByRole('region', { name: 'שיחה קולית' });
    await bar.waitFor();
    await bar.getByRole('button', { name: 'הגדרות קול' }).click();
    await p.getByRole('dialog', { name: 'הגדרות קול' }).waitFor();
    await shot(p, '447-voice-dialog-he');
    await p.close();
  }
}
