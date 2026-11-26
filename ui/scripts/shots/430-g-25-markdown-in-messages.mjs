import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- G-25 Markdown in messages (480-483, docs/ux/specs/markdown.md §6) -----------
  {
    const send = async (p, text) => {
      const box = p.getByRole('textbox', { name: /כתיבה ב|^Message / });
      await box.fill(text);
      await box.press('Enter');
      await p.waitForTimeout(300);
    };
    const lastRow = (p) => p.locator('[role=article]:has(.msg:not(.skeleton))').last();

    // 480: each marker in Hebrew messages.
    {
      const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
      await send(p, 'זה **מודגש**, זה *נטוי*, זה ~~מחוק~~ ומריצים `npm i` באמצע שורה');
      await send(p, '> צריך לסגור את הגרסה היום\nמסכימים, אני על זה');
      await send(p, 'הסוף של הפרק: ||הוא היה הרוח כל הזמן||');
      await p.mouse.move(1, 1);
      await shot(p, '480-markdown-he');
      // 483: the spoiler after reveal.
      await lastRow(p).locator('button.md-spoiler').click();
      await p.mouse.move(1, 1);
      await shot(p, '483-markdown-spoiler-revealed-he');
      await p.close();
    }

    // 481: a long code block with the copy button, English, dark.
    {
      const p = await chat('?demo=1&still=1&lang=en&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
      const long = 'docker compose run --rm shots && ' + 'echo "a very long line that keeps going past the edge of the message" && '.repeat(3) + 'true';
      await send(p, 'Run this from ui/:\n```sh\n' + long + '\nnpm run screenshots\n```');
      await lastRow(p).locator('.md-code-block').hover();
      await shot(p, '481-markdown-code-block-en-dark');
      await p.close();
    }

    // 482: an English quote in a Hebrew message, and code in a Hebrew line.
    {
      const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
      await send(p, 'תראו מה הוא כתב:\n> I think we should ship it today\nומריצים `npm run build` לפני ששולחים');
      await p.mouse.move(1, 1);
      await shot(p, '482-markdown-mixed-he');
      await p.close();
    }
  }
}
