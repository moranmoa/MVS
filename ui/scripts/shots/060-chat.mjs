import { problems, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- chat -------------------------------------------------------------------

  {
    const p = await chat('?demo=1&still=1&lang=he&theme=dark&update=300', 'x', { colorScheme: 'dark' });
    const box = p.getByRole('textbox', { name: /כתיבה ב/ });
    // Reply to the last message.
    const last = p.getByRole('article').last();
    await last.hover();
    await last.getByRole('button', { name: 'תגובה' }).click();
    await box.fill('אני בפנים! מי מארח?');
    await box.press('Enter');
    await box.fill('this one will fail /fail');
    await box.press('Enter');
    await box.fill('ערכתי את ההודעה הזו');
    await box.press('Enter');
    await p.waitForTimeout(1500);
    await box.press('ArrowUp');
    await box.fill('ערכתי את ההודעה הזו – עכשיו עם תיקון');
    await box.press('Enter');
    await p.waitForTimeout(600);
    await shot(p, '20-chat-hebrew-dark-send-states');
    await p.getByRole('article').last().hover();
    await shot(p, '21-chat-message-actions');
    await p.getByRole('button', { name: /^החבר׳ה/ }).click();
    await box.fill('מישהו פה?');
    await box.press('Enter');
    await p.waitForTimeout(500);
    await shot(p, '22-chat-nobody-online-pending');
    await p.close();
  }

  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=300', 'x');
    await shot(p, '23-chat-hebrew-light');
    await p.getByRole('button', { name: /הפרופיל של/ }).nth(3).click();
    await shot(p, '24-profile-card');
    await p.getByRole('button', { name: 'הרחקה מהשרת' }).click();
    await shot(p, '25-profile-kick-confirm');
    await p.getByRole('button', { name: 'הרחקה', exact: true }).click();
    await p.waitForTimeout(400);
    await shot(p, '26-kick-encryption-notice');
    await p.close();
  }

  {
    const p = await chat('?demo=1&still=1&lang=en&theme=light&update=300', 'x');
    await shot(p, '27-chat-english-ltr');
    // QA-10: a paste over the limit stays whole, the counter shows, sending stops.
    await p.getByRole('textbox', { name: /^Message / }).fill('word '.repeat(840));
    await shot(p, '29-chat-composer-too-long');
    if (!(await p.getByRole('button', { name: 'Send' }).isDisabled())) problems.push('send enabled past the length limit');
    await p.getByRole('textbox', { name: /^Message / }).fill('');
    await p.getByRole('button', { name: 'Member list' }).click();
    await shot(p, '28-chat-english-members-collapsed');
    await p.close();
  }
}
