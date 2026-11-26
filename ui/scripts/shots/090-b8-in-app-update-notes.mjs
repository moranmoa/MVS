import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- B8: in-app update notes (190-193) ------------------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&installed=1', 'x');
    await p.getByText(/עודכן לגרסה/).waitFor();
    await shot(p, '190-update-installed-notes-collapsed');
    await p.getByText('מה חדש').click();
    await shot(p, '191-update-installed-notes-expanded');
    await p.close();
  }

  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999&rolledBack=1', 'x');
    await p.getByText(/לא עלה כמו שצריך/).waitFor();
    await shot(p, '192-update-rolled-back');
    await p.close();
  }

  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=300&inCall=1', 'x');
    await p.getByRole('button', { name: /עדכון מוכן – הפעלה מחדש/ }).click();
    await p.getByText('עדכון מוכן – יותקן כשהשיחה תסתיים').waitFor();
    await shot(p, '193-update-pill-after-call');
    await p.close();
  }
}
