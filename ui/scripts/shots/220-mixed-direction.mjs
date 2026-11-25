import { OUT, page, problems, shot, chat, checkBidi } from './lib.mjs';

export default async function run() {
  // ---- mixed direction (B17, spec docs/ux/specs/B17-mixed-direction.md §12) ---

  {
    const p = await chat('?demo=1&bidi=1&still=1&lang=he&theme=dark&update=999999', 'x', { colorScheme: 'dark' });
    await checkBidi(p, '70-bidi-he-dark', 'he');
    await shot(p, '70-bidi-he-dark');
    await p.close();
  }

  {
    const p = await chat('?demo=1&bidi=1&still=1&lang=en&theme=light&update=999999', 'x');
    await checkBidi(p, '71-bidi-en-light', 'en');
    await shot(p, '71-bidi-en-light');
    await p.close();
  }

  {
    const p = await chat('?demo=1&still=1&lang=he&theme=light&update=999999', 'x');
    await p.getByRole('button', { name: /^clips/ }).click();
    const box = p.getByRole('textbox', { name: /כתיבה ב/ });
    await box.waitFor();
    const placeholder = await box.getAttribute('placeholder');
    if (placeholder !== 'כתיבה ב-\u2068#clips\u2069') problems.push(`72: composer placeholder is "${placeholder}"`);
    await shot(p, '72-composer-he-latin-channel');
    await box.fill('GG על המשחק');
    if ((await box.getAttribute('dir')) !== 'rtl') problems.push('73: composer with "GG על המשחק" is not RTL');
    await shot(p, '73-composer-he-typing');
    await p.close();
  }

  for (const [section, name] of [
    ['appearance', '74-settings-zoom-hint-he'],
    ['storage', '75-settings-storage-he'],
  ]) {
    const p = await chat(`?demo=1&still=1&lang=he&theme=light&update=999999&settings=${section}`, 'x');
    await p.getByRole('button', { name: 'הגדרות' }).first().click();
    if (section === 'appearance') {
      const keys = await p.locator('kbd').allTextContents();
      if (keys.join(' ') !== 'Ctrl+= Ctrl+- Ctrl+0') problems.push(`74: shortcut keys are ${JSON.stringify(keys)}`);
      await p.locator('kbd').first().scrollIntoViewIfNeeded();
    }
    await shot(p, name);
    await p.close();
  }

  {
    const p = await page('?demo=1&bidi=1&still=1&lang=he&theme=light&update=999999', { height: 768 });
    await p.evaluate(() => localStorage.setItem('mvp.settings.v1', JSON.stringify({ uiScale: 2, fontSize: 24 })));
    await p.reload();
    await p.getByRole('article').first().waitFor();
    await p.waitForTimeout(800);
    await checkBidi(p, '76-bidi-he-200', 'he', true);
    // B12: at 200% the window lays out like 683px, so the member list is closed and the chat keeps its room.
    const room = await p.evaluate(() => ({ main: document.querySelector('.main')?.clientWidth ?? 0, members: !!document.querySelector('.members') }));
    if (room.main < 600 || room.members) problems.push(`76: chat is ${room.main}px wide, member list open: ${room.members}`);
    await shot(p, '76-bidi-he-200');
    await p.evaluate(() => localStorage.removeItem('mvp.settings.v1'));
    await p.close();
  }

  {
    const p = await page('?demo=1&bidi=1&still=1&lang=he&theme=dark&update=999999', { width: 375, height: 812, phone: true, colorScheme: 'dark' });
    await p.getByRole('button', { name: /^כללי/ }).click();
    await p.getByRole('article').first().waitFor();
    await p.mouse.move(1, 1);
    await p.waitForTimeout(600);
    await checkBidi(p, '77-bidi-he-phone', 'he', true);
    await shot(p, '77-bidi-he-phone');
    await p.close();
  }

  {
    const p = await chat('?demo=1&bidi=1&still=1&lang=he&theme=light&update=999999', 'x');
    const heads = p.locator('.msg-head').last();
    await heads.scrollIntoViewIfNeeded();
    const box = await p.locator('.message-scroll').boundingBox();
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${OUT}/78-message-head-code.png`, clip: { x: box.x, y: Math.max(box.y, box.y + box.height - 420), width: box.width, height: Math.min(420, box.height) } });
    console.log('saved', '78-message-head-code');
    await p.close();
  }
}
