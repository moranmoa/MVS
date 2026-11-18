// T8-04: MVS_DEMO in a checkout runs the page on the UI's mock: no core is
// started (even with MVS_CORE_PATH set), `window.mvs.invoke` isn't there (so
// createCore() picks the mock), the app lock is off, and the shell's own
// helpers still work. (Main also refuses core:invoke in the demo.)
// Needs a display and a built UI: run in Docker with `docker compose run --rm test`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const PROFILE = mkdtempSync(join(tmpdir(), 'mvs-e2e-demo-'));

let app;
let page;

before(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, MVS_DEMO: '1', MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: PROFILE } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

after(async () => {
  await app?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the page opens on ?demo=1, unlocked, without invoke', async () => {
  const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  assert.ok(url.endsWith('/index.html?demo=1'), url);
  assert.equal(await page.evaluate(() => typeof window.mvs.invoke), 'undefined');
  for (const fn of ['onEvent', 'setUnreadCount', 'notify', 'copyText', 'setPushToTalk']) {
    assert.equal(await page.evaluate((f) => typeof window.mvs[f], fn), 'function', fn);
  }
  const st = await page.evaluate(() => window.mvs.lock.state());
  assert.equal(st.locked, false);
  assert.equal(st.pending, false);
});

test('the mock demo servers show (createCore fell through to the mock)', async () => {
  // The server rail shows icons; the name is in the page (label or text).
  const shown = await page
    .waitForFunction(() => document.body.innerHTML.includes('Minecraft IL'), null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  assert.ok(shown, await page.evaluate(() => document.body.innerText.slice(0, 500)));
});

test('no core is started, even with MVS_CORE_PATH set', async () => {
  // startCore makes <profile>/core before it spawns anything.
  assert.equal(existsSync(join(PROFILE, 'core')), false, 'no core data dir');
  // The shell helpers still answer; "retry the core" does nothing.
  assert.equal(await page.evaluate(() => window.mvs.setUnreadCount(2)), true);
  assert.equal(await page.evaluate(() => window.mvs.retryCore()), false);
});

test('without a test profile, the demo gets its own profile beside the real one', async () => {
  const config = mkdtempSync(join(tmpdir(), 'mvs-e2e-demo-xdg-'));
  const env = { ...process.env, MVS_DEMO: '1', XDG_CONFIG_HOME: config };
  delete env.MVS_TEST_USER_DATA;
  const other = await electron.launch({ args: ['.'], env });
  try {
    const userData = await other.evaluate(({ app }) => app.getPath('userData'));
    assert.ok(userData.endsWith('-demo'), userData);
    assert.ok(userData.startsWith(config), userData);
  } finally {
    await other.close().catch(() => {});
    rmSync(config, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
