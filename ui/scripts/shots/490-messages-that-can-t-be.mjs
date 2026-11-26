import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- messages that can't be opened here (520-522, core #527) ---------------------
  for (const [query, name, opts, which] of [
    ['lang=he&theme=light', '520-unreadable-nokey-he', undefined, 'no-key'],
    ['lang=he&theme=light', '521-unreadable-untrusted-he', undefined, 'untrusted'],
    ['lang=en&theme=dark', '522-unreadable-both-en-dark', { colorScheme: 'dark' }, null],
  ]) {
    const p = await chat(`?demo=1&still=1&update=999999&unreadable=1&${query}`, 'x', opts);
    await p.locator(which ? `.msg.unreadable.${which}` : '.msg.unreadable.untrusted').waitFor();
    await p.mouse.move(1, 1);
    await shot(p, name);
    await p.close();
  }
}
