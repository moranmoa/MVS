import { page, shot, chat, PHONE } from './lib.mjs';

export default async function run() {
  // ---- B11 server settings and B25 context menus ---------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const channels = p.getByRole('navigation', { name: 'ערוצים' });
    await shot(p, '180-sidebar-settings-button-he');
    await channels.getByRole('button', { name: /^clips/ }).click({ button: 'right' });
    await p.getByRole('menu').waitFor();
    await shot(p, '172-menu-channel-owner-he');
    await p.keyboard.press('Escape');
    await channels.getByRole('button', { name: /^כללי/ }).click({ button: 'right' });
    await shot(p, '173-menu-general-owner-he');
    await p.keyboard.press('Escape');
    const members = p.getByRole('complementary', { name: 'חברי השרת' });
    const other = members.getByRole('button').filter({ hasNotText: 'בעלים' }).filter({ hasNotText: '(אני)' }).first();
    await other.click({ button: 'right' });
    await shot(p, '174-menu-member-owner-he');
    await p.keyboard.press('Escape');
    await p.getByRole('button', { name: 'הגדרות השרת' }).click();
    await p.getByRole('tab', { name: 'כללי' }).waitFor();
    await shot(p, '181-server-settings-general-he');
    await p.getByRole('tab', { name: 'ערוצים' }).click();
    await shot(p, '182-server-settings-channels-he');
    await p.getByRole('tab', { name: 'חברים' }).click();
    await shot(p, '183b-server-settings-members-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'Server settings' }).click();
    await p.getByRole('tab', { name: 'General' }).waitFor();
    await shot(p, '186-server-settings-en-light');
    await p.close();
  }
  // Invites (#214). The B11 spec's 183–185 (removed accounts, unsaved changes,
  // phone list) wait for core support, so the invite page takes those numbers.
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: 'הגדרות השרת' }).click();
    await p.getByRole('tab', { name: 'לינק הזמנה' }).click();
    const panel = p.getByRole('tabpanel');
    await panel.getByText(/^3 שימושים/).waitFor();
    await shot(p, '183-server-settings-invites-he');
    await panel.getByLabel('תוקף').selectOption('day');
    await panel.getByLabel('מספר שימושים').selectOption('5');
    await panel.getByRole('button', { name: 'יצירת לינק' }).click();
    await panel.getByText(/0 מתוך 5 שימושים/).waitFor();
    await shot(p, '184-server-settings-invite-created-he');
    await panel.getByRole('button', { name: 'ביטול הלינק' }).first().click();
    await panel.getByRole('group').waitFor();
    await shot(p, '185-server-settings-invite-revoke-he');
    await p.close();
  }
  // B25 §5: on a phone the menu is a bottom sheet.
  {
    const p = await page('?demo=1&still=1&lang=he&theme=light&update=999999', PHONE);
    await p.getByRole('button', { name: /^clips/ }).click({ button: 'right' });
    await p.getByRole('menu').waitFor();
    await shot(p, '176-menu-sheet-phone-he');
    await p.close();
  }
}
