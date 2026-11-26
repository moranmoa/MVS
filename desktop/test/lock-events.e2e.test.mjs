// QA MR.1 (after #513): do live core events still reach the page after the
// app lock's reloads? (1) unlock with a passcode (reload); (2) a fresh
// profile whose getAppLock answers late: lock screen first, then "off" and a
// reload. In both, a core event sent after that must reach the page.
// Needs a display: run in Docker with `docker compose run --rm test`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const profiles = [];
const apps = [];

const until = async (cond, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

async function launch(setup) {
  const profile = mkdtempSync(join(tmpdir(), 'mvs-e2e-lockev-'));
  profiles.push(profile);
  const coreDir = join(profile, 'core');
  mkdirSync(coreDir, { recursive: true });
  setup(coreDir);
  const app = await electron.launch({ args: ['.'], env: { ...process.env, MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: profile } });
  apps.push(app);
  const page = await app.firstWindow();
  const url = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  return { app, page, url };
}

/** Subscribes in the page, triggers a core event (joinServer → join.status), and says whether it arrived. */
async function eventArrives(page) {
  await page.evaluate(() => {
    window.__seen = [];
    window.mvs.onEvent((name) => window.__seen.push(name));
  });
  await page.evaluate(() => window.mvs.invoke('joinServer', ['mvs://join/x']));
  return until(async () => (await page.evaluate(() => window.__seen)).includes('join.status'), 10_000);
}

after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  for (const p of profiles) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('after unlocking with the passcode (a reload), core events reach the page', async () => {
  const { page, url } = await launch((dir) => writeFileSync(join(dir, 'fake-applock.json'), JSON.stringify({ enabled: true, passcode: '2468' })));
  assert.ok(await until(async () => (await url()).endsWith('?locked')), 'locked first');
  await page.evaluate(() => window.mvs.lock.unlock({ passcode: '2468' })).catch(() => 'reloaded');
  assert.ok(await until(async () => !(await url()).includes('locked')), 'unlocked');
  assert.ok(await until(async () => (await page.evaluate(() => window.mvs.lock.state())).locked === false));
  assert.ok(await eventArrives(page), 'join.status reached the page');
});

test('a fresh profile with a slow lock check: lock screen, then off and a reload; core events reach the page', async () => {
  // No lock set, but the core answers getAppLock after 13 s (past the 10 s fail-closed timeout).
  const { page, url } = await launch((dir) => writeFileSync(join(dir, 'fake-applock-delay'), '13000'));
  assert.ok(await until(async () => (await url()).endsWith('?locked'), 20_000), 'the lock screen while waiting');
  assert.ok(await until(async () => !(await url()).includes('locked'), 30_000), 'the late "off" reloads unlocked');
  assert.ok(await until(async () => (await page.evaluate(() => window.mvs.lock.state())).locked === false));
  assert.ok(await eventArrives(page), 'join.status reached the page');
});
