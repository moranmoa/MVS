// Required updates (#577), end to end with the fake core: when the core says
// the running version is revoked, main lets the page read and update only.
// Needs a display: run in Docker with `docker compose run --rm test`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.js', import.meta.url));
const PROFILE = mkdtempSync(join(tmpdir(), 'mvs-e2e-required-'));
const CORE_DIR = join(PROFILE, 'core');

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
const invoke = (cmd, args = []) => page.evaluate(([c, a]) => window.mvs.invoke(c, a), [cmd, args]);

before(async () => {
  mkdirSync(CORE_DIR, { recursive: true });
  writeFileSync(join(CORE_DIR, 'fake-required.json'), JSON.stringify({ version: '9.9.9' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, MVS_CORE_PATH: FAKE_CORE, MVS_TEST_USER_DATA: PROFILE } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

after(async () => {
  await app?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('a revoked version: writes and the network are refused once main knows', async () => {
  assert.ok(
    await until(async () => (await invoke('sendMessage', ['c1', 'hi'])).error?.code === 'update-required'),
    'sendMessage refused with update-required',
  );
  for (const [cmd, args] of [
    ['joinServer', ['mvs://join/x']],
    ['joinCall', ['c'.repeat(64)]],
    ['updateProfile', [{}]],
  ]) {
    assert.deepEqual(await invoke(cmd, args), { error: { code: 'update-required' } }, cmd);
  }
});

test('a revoked version: local reads and the update still work', async () => {
  // (exportDiagnostics is allowed too, unit-tested; the fake core's answer to it is a deliberate over-size line.)
  for (const [cmd, args] of [
    ['listServers', []],
    ['getMessages', ['c1', 0, 10]],
    ['getAppInfo', []],
  ]) {
    const res = await invoke(cmd, args);
    assert.equal(res.error?.code, undefined, `${cmd}: ${JSON.stringify(res.error)}`);
  }
});

test('a reload stays read-only', async () => {
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  assert.ok(await until(async () => (await invoke('sendMessage', ['c1', 'hi'])).error?.code === 'update-required'));
});
