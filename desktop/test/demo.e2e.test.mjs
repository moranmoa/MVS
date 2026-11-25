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
  // No core, no calls: no voice frames either (SL, #526).
  assert.equal(await page.evaluate(() => typeof window.mvs.voice), 'undefined');
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

// Linux: XDG_CONFIG_HOME moves the app-data folder into a temp dir. Windows
// and macOS ignore it (the OS gives the folder), so there the profile lands
// beside the real one in the real app-data folder: only on CI runners, and
// removed afterwards if this test created it. Never on a developer's machine.
const OWN_APPDATA = process.platform === 'linux';
test(
  'without a test profile, the demo gets its own profile beside the real one',
  { skip: !OWN_APPDATA && !process.env.CI ? 'would touch the real app-data folder outside CI' : false },
  async () => {
    const config = mkdtempSync(join(tmpdir(), 'mvs-e2e-demo-xdg-'));
    const env = { ...process.env, MVS_DEMO: '1', XDG_CONFIG_HOME: config };
    delete env.MVS_TEST_USER_DATA;
    const other = await electron.launch({ args: ['.'], env });
    let userData = null;
    try {
      const paths = await other.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData'), name: app.getName() }));
      userData = paths.userData;
      // A sibling of the real profile (<appData>/<name>), never inside it.
      assert.equal(userData, join(paths.appData, `${paths.name}-demo`));
      if (OWN_APPDATA) assert.ok(userData.startsWith(config), userData);
    } finally {
      await other.close().catch(() => {});
      rmSync(config, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // CI on Windows/macOS (a throwaway runner): the demo profile goes too.
      if (!OWN_APPDATA && userData && userData.endsWith('-demo')) rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
