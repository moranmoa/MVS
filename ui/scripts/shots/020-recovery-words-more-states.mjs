import { page, problems, shot } from './lib.mjs';

export default async function run() {
  // ---- recovery words, more states (B19 spec §9) --------------------------------
  {
    const p = await page('?demo=unchecked&still=1&lang=en&theme=light&update=999999');
    await p.getByRole('button', { name: 'Check now' }).click();
    await p.getByRole('button', { name: 'Show the words again' }).click();
    await p.getByRole('button', { name: 'Show the words' }).click();
    await p.locator('.word-grid .word:not(.word-mask)').first().waitFor();
    await shot(p, '82-words-shown-en-light');
    await p.close();
  }

  {
    const p = await page('?demo=unchecked&still=1&lang=he&theme=light&update=999999', { width: 375, height: 812, phone: true });
    await p.getByRole('button', { name: 'לבדיקה עכשיו' }).click();
    await p.getByRole('button', { name: 'להציג את המילים שוב' }).click();
    await p.getByRole('button', { name: 'הצגת המילים' }).click();
    await p.locator('.word-grid .word:not(.word-mask)').first().waitFor();
    await p.locator('.word-grid').scrollIntoViewIfNeeded();
    await shot(p, '84-words-phone-he');
    await p.close();
  }

  {
    const p = await page('?demo=unchecked&still=1&lang=he&theme=light&update=999999', { height: 768 });
    await p.evaluate(() => localStorage.setItem('mvp.settings.v1', JSON.stringify({ uiScale: 2, fontSize: 24 })));
    await p.reload();
    await p.getByRole('button', { name: 'לבדיקה עכשיו' }).click();
    const fields = p.getByLabel(/^מילה /);
    await fields.first().waitFor();
    const xs = await fields.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    if (new Set(xs).size !== 1) problems.push(`85: check fields are not in one column at 200%: ${xs.join()}`);
    await shot(p, '85-check-200-he');
    await p.evaluate(() => localStorage.removeItem('mvp.settings.v1'));
    await p.close();
  }

  {
    const p = await page('?demo=unchecked&still=1&lang=he&theme=light&update=999999');
    await p.getByRole('button', { name: 'לבדיקה עכשיו' }).click();
    await p.getByRole('button', { name: 'להציג את המילים שוב' }).click();
    await p.getByRole('button', { name: 'הצגת המילים' }).waitFor();
    await shot(p, '86-check-dialog-show-words');
    await p.close();
  }

  {
    const p = await page('?demo=unchecked&wordsError=1&still=1&lang=he&theme=light&update=999999');
    await p.getByRole('button', { name: 'לבדיקה עכשיו' }).click();
    await p.getByRole('button', { name: 'להציג את המילים שוב' }).click();
    await p.getByRole('button', { name: 'הצגת המילים' }).click();
    await p.getByRole('button', { name: 'לנסות שוב' }).waitFor();
    await shot(p, '87-words-load-error-he');
    await p.close();
  }
}
