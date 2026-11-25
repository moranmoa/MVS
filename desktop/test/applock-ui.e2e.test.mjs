// G-78 end to end with the real UI (ui/dist, the lock screens in
// ui/src/lock): path A (reload into ?locked, wrong / right passcode), the
// settings IPCs (lock:config / lock:set / lock:clear, never core:invoke),
// path B (the overlay during a call, the content unmounted, Leave reloads
// into A), and the delay surviving a restart.
// Needs a display and a fresh UI build: run in Docker with `docker compose run --rm test`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const PROFILE = mkdtempSync(join(tmpdir(), 'mvs-e2e-lockui-'));
const CORE_DIR = join(PROFILE, 'core');
const LOCK_FILE = join(CORE_DIR, 'fake-applock.json');

let app;
let page;

const until = async (cond, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};
const launch = async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, LANG: 'en_US.UTF-8', MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: PROFILE } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
};
const url = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
const lockState = () => page.evaluate(() => window.mvs.lock.state());
const invoke = (cmd, args = []) => page.evaluate(([c, a]) => window.mvs.invoke(c, a), [cmd, args]);
const key = (keyCode, modifiers = []) =>
  app.evaluate(({ BrowserWindow }, [k, m]) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m }), [keyCode, modifiers]);
const field = () => page.locator('input[autocomplete="current-password"]');
const submit = () => page.locator('button.lock-submit');
const lockFile = () => JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
const sent = () =>
  readFileSync(join(CORE_DIR, 'commands.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

before(async () => {
  mkdirSync(CORE_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify({ enabled: true, passcode: '2468', idleMinutes: 5, lockOnSleep: true }));
  await launch();
});

after(async () => {
  await app?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('path A: the lock screen, with nothing but the lock on it', async () => {
  assert.ok(await until(async () => (await url()).endsWith('?locked')), await url());
  await field().waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.lock-screen h1').count(), 1);
  // Nothing else on the page: its text is the lock screen's (and the title bar's "MVS").
  const texts = await page.evaluate(() => {
    const body = document.querySelector('.window-body') ?? document.getElementById('root');
    return { body: body.textContent.trim(), lock: document.querySelector('.lock-screen').textContent.trim() };
  });
  assert.equal(texts.body, texts.lock);
});

test('path A: a wrong passcode is said and cleared; the right one reloads unlocked', async () => {
  await field().fill('1357');
  await submit().click();
  await page.locator('.lock-error[role="alert"]').waitFor({ timeout: 5_000 });
  assert.equal(await field().inputValue(), '');
  assert.equal(await field().evaluate((el) => el === document.activeElement), true);
  await field().fill('2468');
  await submit().click();
  assert.ok(await until(async () => !(await url()).includes('locked')), await url());
  // The reload may still be under way: wait for the new page's answer.
  assert.ok(await until(async () => (await lockState()).locked === false), 'unlocked after the reload');
});

test('settings: lock:config shows only the settings; set/clear never go through core:invoke', async () => {
  const cfg = await page.evaluate(() => window.mvs.lock.config());
  assert.deepEqual(cfg, { enabled: true, idleMinutes: 5, lockOnSleep: true, method: 'passcode' });
  for (const cmd of ['setAppLock', 'clearAppLock', 'clearAppLockWithWords', 'getAppLock', 'verifyAppLock']) {
    assert.deepEqual(await invoke(cmd, [{ current: '2468', passcode: '1111' }]), { error: { code: 'not-allowed' } }, cmd);
  }
  // A wrong current is the core's call (it counts); main never fills it in.
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.set({ current: '0000', passcode: '135790', idleMinutes: 15, lockOnSleep: false })), { result: 'wrong' });
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.set({ passcode: '135790', idleMinutes: 15, lockOnSleep: false })), { result: 'wrong' });
  // Main's own checks, before the core.
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.set({ current: '2468', passcode: '135790', idleMinutes: 99, lockOnSleep: false })), { result: 'invalid' });
  // The right current: changed, and main re-read its config.
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.set({ current: '2468', passcode: '135790', idleMinutes: 15, lockOnSleep: false })), { result: 'ok' });
  assert.equal(lockFile().passcode, '135790');
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.config()), { enabled: true, idleMinutes: 15, lockOnSleep: false, method: 'passcode' });
  // What reached the core came from main (method set by main, current as typed).
  assert.deepEqual(sent().filter((m) => m.cmd === 'setAppLock').at(-1).args, { current: '2468', passcode: '135790', method: 'passcode', idleMinutes: 15, lockOnSleep: false });
});

test('path B: Ctrl+L in a call: the overlay, the content unmounted, set refused, Leave reloads into A', async () => {
  assert.ok((await invoke('joinCall', ['c'.repeat(64)])).ok);
  await key('L', ['control']);
  await page.locator('.lock-overlay').waitFor({ timeout: 5_000 });
  const st = await lockState();
  assert.equal(st.path, 'B');
  assert.equal(await page.locator('.lock-call').count(), 1);
  // Only the overlay is rendered: the page's text is the overlay's (and the title bar's "MVS").
  const texts = await page.evaluate(() => {
    const body = document.querySelector('.window-body') ?? document.getElementById('root');
    return { body: body.textContent.trim(), overlay: document.querySelector('.lock-overlay').textContent.trim() };
  });
  assert.equal(texts.body, texts.overlay);
  // Main muted me in the core; the settings are closed while locked.
  assert.ok(await until(async () => sent().some((m) => m.cmd === 'setMuted' && m.args.muted === true)));
  assert.equal(await page.evaluate(() => window.mvs.lock.config()), null);
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.set({ current: '135790', passcode: '111111', idleMinutes: 5, lockOnSleep: true })), { result: 'locked' });
  assert.deepEqual(await page.evaluate(() => window.mvs.lock.clear({ current: '135790' })), { result: 'locked' });
  // Leave: the call ends, main reloads into the plain lock screen.
  await page.locator('button.lock-leave').click();
  assert.ok(await until(async () => (await url()).endsWith('?locked')), await url());
  await field().waitFor({ timeout: 15_000 });
  assert.ok(await until(async () => (await lockState()).path === 'A'), 'path A after the reload');
  assert.equal(await page.locator('.lock-call').count(), 0);
});

test('five wrong: the countdown, which a restart keeps', async () => {
  for (let i = 0; i < 5; i++) {
    await field().fill('0000');
    await submit().click();
    // "Checking…" holds for at least 300 ms; then the field is back (or disabled for good).
    await new Promise((r) => setTimeout(r, 400));
    await until(async () => (await field().isDisabled()) || (await field().inputValue()) === '', 3_000);
  }
  assert.ok(await until(async () => field().isDisabled()), 'field disabled');
  assert.equal(await submit().isDisabled(), true);
  // Restart: the delay comes back from the core.
  await app.close();
  await launch();
  assert.ok(await until(async () => (await url()).endsWith('?locked')), await url());
  await field().waitFor({ timeout: 10_000 });
  assert.ok(await until(async () => field().isDisabled()), 'still disabled after a restart');
  assert.ok(((await lockState()).retryAfter ?? 0) > 0);
});
