// QA MR.1: a state event the core sends while the app is locked reaches the
// page after unlock (main keeps the latest value, held.js). Message content
// stays dropped. Needs a display: run in Docker with `docker compose run --rm test`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const PROFILE = mkdtempSync(join(tmpdir(), 'mvs-e2e-held-'));
const CORE_DIR = join(PROFILE, 'core');
let app;

const until = async (cond, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

after(async () => {
  await app?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('memberRelay.changed sent while locked reaches the page once it is unlocked', async () => {
  mkdirSync(CORE_DIR, { recursive: true });
  writeFileSync(join(CORE_DIR, 'fake-applock.json'), JSON.stringify({ enabled: true, passcode: '2468' }));
  writeFileSync(join(CORE_DIR, 'fake-emit-memberrelay'), '');
  app = await electron.launch({ args: ['.'], env: { ...process.env, MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: PROFILE } });
  const page = await app.firstWindow();
  const url = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  // Record what main sends to the page (core:event names).
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__sent = [];
    const send = wc.send.bind(wc);
    wc.send = (channel, name, ...rest) => {
      if (channel === 'core:event') globalThis.__sent.push({ name, url: wc.getURL() });
      return send(channel, name, ...rest);
    };
  });
  assert.ok(await until(async () => (await url()).endsWith('?locked')), 'locked');
  // The core's event arrives while locked (1.5 s after start): not forwarded then.
  await new Promise((r) => setTimeout(r, 2500));
  const sentLocked = await app.evaluate(() => globalThis.__sent.filter((s) => s.name === 'memberRelay.changed'));
  assert.deepEqual(sentLocked, [], 'not sent to the lock screen');
  // Unlock: the page reloads, and main hands over the held value.
  await page.evaluate(() => window.mvs.lock.unlock({ passcode: '2468' })).catch(() => 'reloaded');
  assert.ok(await until(async () => !(await url()).includes('locked')), 'unlocked');
  assert.ok(
    await until(async () => (await app.evaluate(() => globalThis.__sent)).some((s) => s.name === 'memberRelay.changed' && !s.url.includes('locked'))),
    'memberRelay.changed delivered to the unlocked page',
  );
});
