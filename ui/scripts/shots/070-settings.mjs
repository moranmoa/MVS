import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- settings ---------------------------------------------------------------
  for (const [section, name] of [
    ['appearance', '30-settings-appearance'],
    ['language', '31-settings-language'],
    ['storage', '32-settings-storage'],
    ['diagnostics', '33-settings-diagnostics'],
    ['about', '34-settings-about'],
    ['notifications', '361-settings-notifications-he'],
  ]) {
    const p = await chat(`?demo=unchecked&still=1&lang=he&theme=light&settings=${section}`, 'x');
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    if (section === 'appearance') {
      await p.getByRole('slider').nth(1).fill('20');
    }
    await shot(p, name);
    await p.close();
  }

  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light', 'x');
    await p.keyboard.press('Control+=');
    await p.keyboard.press('Control+=');
    await p.keyboard.press('Control+=');
    await shot(p, '35-ui-scale-130');
    await p.close();
  }

  {
    const p = await chat('?demo=unchecked&still=1&lang=he&theme=dark', 'x', { colorScheme: 'dark' });
    await shot(p, '36-chat-recovery-reminder-banner');
    await p.close();
  }
}
