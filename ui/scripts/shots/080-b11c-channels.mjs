import { problems, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- B11c: channels (owner) ----------------------------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    const list = p.getByRole('navigation', { name: 'ערוצים' });
    await list.getByRole('button', { name: 'יצירת ערוץ' }).click();
    await p.getByLabel('שם הערוץ').fill('חדשות משחקים');
    const typed = await p.getByLabel('שם הערוץ').inputValue();
    if (typed !== 'חדשות-משחקים') problems.push(`116: channel name is "${typed}", expected spaces as dashes`);
    await shot(p, '116-channel-create-he');
    await p.getByRole('button', { name: 'ביטול' }).click();
    await list.getByRole('button', { name: 'עריכת הערוץ: כללי' }).click();
    if (await p.getByRole('button', { name: 'מחיקת הערוץ' }).count()) problems.push('117: #general offers delete');
    await shot(p, '117-channel-edit-general-he');
    await p.getByRole('button', { name: 'ביטול' }).click();
    await list.getByRole('button', { name: 'עריכת הערוץ: clips' }).click({ force: true });
    await p.getByRole('button', { name: 'מחיקת הערוץ' }).click();
    await shot(p, '118-channel-delete-confirm-he');
    await p.close();
  }
}
