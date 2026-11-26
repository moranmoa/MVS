// Captures the main screens into ./screenshots. Runs inside the Playwright
// container (see compose.yaml): `docker compose run --rm shots`.
// Each feature has its own file in ./shots (NN-name.mjs, run in name order);
// a new feature adds a file there instead of editing this one.
// `--only <text>` runs just the files whose name contains <text>.

import { readdirSync } from 'node:fs';
import { browser, problems, server } from './shots/lib.mjs';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const dir = new URL('./shots/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d+-.*\.mjs$/.test(f) && (!only || f.includes(only)))
  .sort();
for (const f of files) {
  const { default: run } = await import(new URL(f, dir).href);
  await run();
}

await browser.close();
await server.close();

if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const x of problems) console.error(`  ${x}`);
  process.exit(1);
}
console.log('no CSP violations, no page errors, no recovery words in storage');
