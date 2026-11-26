// Required update during a call (TL decision, PO criteria): the call ends at
// once and cleanly (no error dialog), the others get a normal leave, the page
// isn't reloaded (a draft stays), and the banner is told the call ended.
// Needs a display: run in Docker with `docker compose run --rm test`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const PROFILE = mkdtempSync(join(tmpdir(), 'mvs-e2e-reqcall-'));
const CORE_DIR = join(PROFILE, 'core');
let app;

const until = async (cond, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};
const sent = () =>
  readFileSync(join(CORE_DIR, 'commands.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

after(async () => {
  await app?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('a required update mid-call: the call ends at once and cleanly; draft kept; banner told', async () => {
  mkdirSync(CORE_DIR, { recursive: true });
  writeFileSync(join(CORE_DIR, 'fake-required-on-call'), '');
  app = await electron.launch({ args: ['.'], env: { ...process.env, MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: PROFILE } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.mvs?.invoke === 'function');
  // Record what main sends to the page, and any dialog main would show.
  await app.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.__gate = [];
    globalThis.__dialogs = 0;
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const send = wc.send.bind(wc);
    wc.send = (channel, name, payload, ...rest) => {
      if (channel === 'core:event' && name === 'update.gate') globalThis.__gate.push(payload);
      return send(channel, name, payload, ...rest);
    };
    for (const k of ['showMessageBox', 'showErrorBox']) {
      const orig = dialog[k];
      dialog[k] = (...a) => ((globalThis.__dialogs += 1), orig.apply(dialog, a));
    }
  });
  // A draft and a marker in the page: a reload would wipe both.
  await page.evaluate(() => {
    window.__marker = 'draft: hello';
  });
  assert.ok((await page.evaluate(() => window.mvs.invoke('joinCall', ['c'.repeat(64)]))).ok);
  // (1) The update turns required mid-call: main ends the call at once.
  assert.ok(await until(async () => (await app.evaluate(() => globalThis.__gate)).some((g) => g.active && g.endedCall)), 'update.gate { endedCall } to the page');
  // (2) A normal leave for the others: main sent leaveCall to the core.
  assert.ok(await until(async () => sent().some((m) => m.cmd === 'leaveCall')), 'leaveCall sent');
  // (3) No reload: the draft is still there.
  assert.equal(await page.evaluate(() => window.__marker), 'draft: hello');
  // No error dialog, no countdown.
  assert.equal(await app.evaluate(() => globalThis.__dialogs), 0);
  const last = (await app.evaluate(() => globalThis.__gate)).at(-1);
  assert.equal(Object.hasOwn(last, 'callEndsAt'), false);
  // And the call can't be rejoined while required.
  assert.deepEqual(await page.evaluate(() => window.mvs.invoke('joinCall', ['c'.repeat(64)])), { error: { code: 'update-required' } });
});
