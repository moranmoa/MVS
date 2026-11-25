// G-78: the app lock, main's side (docs/design/app-lock.md): the page starts
// locked when the core says the lock is on, everything but the lock screen's
// needs is refused, keys can't get around it, path B keeps the page (and
// the call) with the mic forced off, and the call ending reloads into A.
// Needs a display: run in Docker with `docker compose run --rm test`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const PROFILE = mkdtempSync(join(tmpdir(), 'mvs-e2e-lock-'));
const CORE_DIR = join(PROFILE, 'core');

let app;
let page;

// A reload (path A) destroys the page's context mid-call: a check that throws
// then just isn't true yet. 15 s: CI runners under load are slow to reload.
const until = async (cond, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};
/** After a reload: the new page answers, with the lock state wanted. */
const settled = (want) => until(async () => (await page.evaluate(() => document.readyState)) !== 'loading' && want(await lockState()));
const url = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
const lockState = () => page.evaluate(() => window.mvs.lock.state());
const invoke = (cmd, args = []) => page.evaluate(([c, a]) => window.mvs.invoke(c, a), [cmd, args]);
const key = (keyCode, modifiers = []) =>
  app.evaluate(({ BrowserWindow }, [k, m]) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m }), [keyCode, modifiers]);
const sent = () =>
  readFileSync(join(CORE_DIR, 'commands.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

before(async () => {
  mkdirSync(CORE_DIR, { recursive: true });
  writeFileSync(join(CORE_DIR, 'fake-applock.json'), JSON.stringify({ enabled: true, idleMinutes: 5, lockOnSleep: true }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: PROFILE } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

after(async () => {
  await app?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('starts locked (path A) when the core says the lock is on', async () => {
  assert.ok((await url()).endsWith('/index.html?locked'), await url());
  const st = await lockState();
  assert.equal(st.locked, true);
  assert.equal(st.path, 'A');
  assert.equal(st.pending, false);
});

test('locked: only getAppInfo reaches the core; shell calls are refused', async () => {
  assert.ok((await invoke('getAppInfo')).ok);
  for (const cmd of ['listServers', 'leaveCall', 'exportDiagnostics']) {
    assert.deepEqual(await invoke(cmd), { error: { code: 'locked' } }, cmd);
  }
  assert.deepEqual(await invoke('setMuted', [true]), { error: { code: 'locked' } });
  assert.equal(await page.evaluate(() => window.mvs.setUnreadCount(3)), false);
  assert.equal(await page.evaluate(() => window.mvs.copyText('x')), false);
  assert.equal(await page.evaluate(() => window.mvs.notify({ title: 'a', body: 'b', channelId: 'c1' })), false);
  assert.equal(await page.evaluate(() => window.mvs.setPushToTalk({ key: 'KeyV', globalMute: null })), 'invalid');
});

test('locked: reload and DevTools keys do nothing', async () => {
  await page.evaluate(() => {
    window.__marker = 1;
  });
  await key('R', ['control']);
  await key('F5');
  await key('I', ['control', 'shift']);
  await key('P', ['control']);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await page.evaluate(() => window.__marker), 1, 'not reloaded');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()), false);
});

test('unlock: bad input and a wrong passcode stay locked; the right one reloads unlocked', async () => {
  assert.equal(await page.evaluate(() => window.mvs.lock.unlock({ passcode: '12' })), 'invalid');
  assert.equal(await page.evaluate(() => window.mvs.lock.unlock('2468')), 'invalid');
  assert.equal(await page.evaluate(() => window.mvs.lock.unlock({ passcode: '1357' })), 'wrong');
  assert.equal((await lockState()).locked, true);
  // Main reloads the page on 'ok', which can destroy this call's context
  // before its answer gets back: that counts as the reload we want.
  const answer = await page.evaluate(() => window.mvs.lock.unlock({ passcode: '2468' })).catch(() => 'reloaded');
  assert.ok(answer === 'ok' || answer === 'reloaded', String(answer));
  assert.ok(await until(async () => !(await url()).includes('locked')), await url());
  assert.ok(await settled((st) => st.locked === false), 'unlocked after the reload');
  assert.ok((await invoke('listServers')).ok !== undefined);
  // The passcode reached the core, and nothing else carries it.
  assert.ok(sent().some((m) => m.cmd === 'verifyAppLock' && m.args.passcode === '2468'));
});

test('Ctrl+L locks; a call keeps the page (path B) with the mic off and only call commands', async () => {
  assert.ok((await invoke('joinCall', ['c'.repeat(64)])).ok);
  await page.evaluate(() => {
    window.__marker = 2;
  });
  await key('L', ['control']);
  assert.ok(await until(async () => (await lockState()).locked));
  const st = await lockState();
  assert.equal(st.path, 'B');
  assert.equal(st.inCall, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.__marker), 2, 'no reload in a call');
  // Main muted me in the core.
  assert.ok(await until(async () => sent().some((m) => m.cmd === 'setMuted' && m.args.muted === true)));
  assert.deepEqual(await invoke('setMuted', [false]), { error: { code: 'locked' } });
  assert.ok((await invoke('setMuted', [true])).ok);
  assert.ok((await invoke('sendSignal', ['a'.repeat(64), 'ice', '{}'])).ok);
  assert.deepEqual(await invoke('listServers'), { error: { code: 'locked' } });
  await key('R', ['control']);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.__marker), 2, 'reload key still dead');
  // Leaving ends the call: path A, the page reloads into ?locked.
  // The call ending reloads the page (path A), possibly before this answer returns.
  const left = await invoke('leaveCall').catch(() => ({ ok: 'reloaded' }));
  assert.ok(left.ok !== undefined, JSON.stringify(left));
  assert.ok(await until(async () => (await url()).endsWith('?locked')), await url());
  assert.ok(await settled((st) => st.locked && st.path === 'A'), 'path A after the reload');
  // V-C3: the lock's reloads keep the WebRTC IP policy (no local adapters).
  const policy = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getWebRTCIPHandlingPolicy());
  assert.equal(policy, 'default_public_and_private_interfaces');
});
