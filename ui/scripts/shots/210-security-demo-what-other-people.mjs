import { problems, shot, chat } from './lib.mjs';

export default async function run() {
  // ---- security demo: what other people could send ---------------------------
  {
    const p = await chat('?demo=1&hostile=1&still=1&lang=he&theme=light&update=999999', 'x');
    await shot(p, '40-hostile-input-chat');
    await p.getByRole('button', { name: /הפרופיל של \u2068?מודן/ }).click();
    await shot(p, '41-hostile-lookalike-profile');
    const leaked = await p.evaluate(() => ({
      images: document.querySelectorAll('.message-canvas img').length,
      links: document.querySelectorAll('.message-canvas a').length,
      tracker: document.documentElement.outerHTML.includes('tracker.invalid'),
    }));
    if (leaked.images || leaked.links || leaked.tracker) problems.push(`hostile input leaked: ${JSON.stringify(leaked)}`);
    await p.close();
  }
}
