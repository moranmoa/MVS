import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-14 channel topic (500-503, UX on #546) ----------------------------------
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.locator('.chat-topic').waitFor();
    await p.mouse.move(1, 1);
    await shot(p, '500-topic-header-he');
    await p.locator('.chat-topic').click();
    await p.getByRole('dialog', { name: 'נושא הערוץ' }).waitFor();
    await p.waitForTimeout(200);
    await shot(p, '501-topic-dialog-he');
    await p.close();
  }
  {
    const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
    await p.locator('.chat-topic').click();
    const dialog = p.getByRole('dialog', { name: 'Channel topic' });
    await dialog.getByRole('button', { name: 'Edit topic' }).click();
    await dialog.getByRole('textbox').fill('Game night every Thursday at 21:00. Ranked queue opens at 20:30, so join the lobby early. '.repeat(3).slice(0, 230));
    await p.waitForTimeout(200);
    await shot(p, '502-topic-edit-counter-en-dark');
    await p.close();
  }
  {
    // An owned channel with no topic: "Add a topic" in the header.
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: /^clips/ }).first().click();
    await p.locator('.chat-topic.add').waitFor();
    await p.mouse.move(1, 1);
    await shot(p, '503-topic-add-empty-he');
    await p.close();
  }
}
