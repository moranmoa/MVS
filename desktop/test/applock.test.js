'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAppLock, cleanPasscode, cleanWords, predatesLock, START_TIMEOUT_MS } = require('../src/applock');

function harness({ config = { enabled: true, idleMinutes: 5, lockOnSleep: true }, verify = () => ({ result: 'ok' }), getDelay = 0 } = {}) {
  const calls = [];
  const states = [];
  const timers = [];
  const call = { in: false };
  let t = 0;
  const lock = createAppLock({
    request: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'getAppLock') {
        if (getDelay === Infinity) return new Promise(() => {});
        return { ok: config };
      }
      if (cmd === 'verifyAppLock' || cmd === 'clearAppLockWithWords') return { ok: verify(args) };
      return { error: { code: 'not-allowed' } };
    },
    inCall: () => call.in,
    onChange: (s) => states.push(s),
    now: () => t,
    setTimer: (fn, ms) => {
      const tm = { fn, at: t + ms };
      timers.push(tm);
      return tm;
    },
    clearTimer: (tm) => {
      const i = timers.indexOf(tm);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms) => {
    t += ms;
    for (const tm of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(tm), 1);
      tm.fn();
    }
  };
  return { lock, calls, states, call, advance };
}

test('cleanPasscode: 4-64 characters, NFC; nothing else', () => {
  assert.equal(cleanPasscode('1234'), '1234');
  assert.equal(cleanPasscode('était'), 'était');
  assert.equal(cleanPasscode('x'.repeat(64)), 'x'.repeat(64));
  for (const bad of ['123', 'x'.repeat(65), 1234, null, undefined, {}]) assert.equal(cleanPasscode(bad), null);
  assert.equal(cleanWords('  a b c '), 'a b c');
  for (const bad of ['', '   ', 'x'.repeat(2000), 5]) assert.equal(cleanWords(bad), null);
});

test('start: pending (gated) until the core answers; lock off unlocks, lock on stays locked', async () => {
  const off = harness({ config: { enabled: false } });
  assert.deepEqual(off.lock.state, { enabled: true, locked: true, pending: true, path: 'A' });
  assert.equal(off.lock.allows('getMessages', {}), false);
  assert.equal(off.lock.forwards('message.new'), false);
  await off.lock.start();
  assert.equal(off.lock.state.locked, false);
  assert.equal(off.lock.allows('getMessages', {}), true);
  assert.equal(off.lock.forwards('message.new'), true);

  const on = harness();
  await on.lock.start();
  assert.deepEqual(on.lock.state, { enabled: true, locked: true, pending: false, path: 'A' });
});

test('predatesLock: only a plain version below 0.4.8', () => {
  for (const v of ['0.4.7', '0.4.7-beta.1', '0.3.9', '0.1.0', '0.0.1+abc']) assert.equal(predatesLock(v), true, v);
  for (const v of ['0.4.8', '0.4.8-beta.1', '0.4.10', '0.5.0', '1.0.0', '10.0.0']) assert.equal(predatesLock(v), false, v);
  for (const v of [undefined, null, 4, '', 'v0.4.7', '0.4', '0.4.7.1', ' 0.4.7', '0.4.7 ', '0.4.7\n', 'x'.repeat(65), '0.4.x']) {
    assert.equal(predatesLock(v), false, String(v));
  }
});

test('start: bad-request / not-implemented means off only from a core older than 0.4.8', async () => {
  const run = async (code, info) => {
    const calls = [];
    const lock = createAppLock({
      request: async (cmd) => {
        calls.push(cmd);
        if (cmd === 'getAppLock') return { error: { code } };
        if (typeof info === 'function') return info();
        return info;
      },
      inCall: () => false,
      onChange: () => {},
    });
    await lock.start();
    return { lock, calls };
  };
  for (const code of ['bad-request', 'not-implemented']) {
    const { lock, calls } = await run(code, { ok: { version: '0.4.7' } });
    assert.equal(lock.state.locked, false, code);
    assert.equal(lock.state.enabled, false, code);
    assert.deepEqual(calls, ['getAppLock', 'getAppInfo']);
    // A core with the lock that still says "no such command": a fault, locked.
    for (const info of [
      { ok: { version: '0.4.8' } },
      { ok: { version: '0.5.0-beta.1' } },
      { ok: { version: 'garbage' } },
      { ok: {} },
      { ok: null },
      { error: { code: 'internal' } },
      null,
      () => {
        throw new Error('down');
      },
    ]) {
      const r = await run(code, info);
      assert.equal(r.lock.state.locked, true, `${code} ${JSON.stringify(info)}`);
      assert.equal(r.lock.state.pending, false);
      assert.equal(r.lock.allows('getMessages', {}), false);
    }
  }
  // Other errors never ask for the version.
  const { calls } = await run('internal', { ok: { version: '0.4.7' } });
  assert.deepEqual(calls, ['getAppLock']);
});

test('start: a lock-era core refusing getAppLock stays locked, and a later good answer still counts', async () => {
  let answer = { error: { code: 'bad-request' } };
  const lock = createAppLock({
    request: async (cmd) => (cmd === 'getAppLock' ? answer : { ok: { version: '0.4.8' } }),
    inCall: () => false,
    onChange: () => {},
  });
  await lock.start();
  assert.equal(lock.state.locked, true);
  answer = { ok: { enabled: false } };
  await lock.coreUp();
  assert.equal(lock.state.locked, false);
});

test('start: down / timeout / internal stays locked', async () => {
  for (const code of ['core-unavailable', 'timeout', 'internal']) {
    const lock = createAppLock({ request: async () => ({ error: { code } }), inCall: () => false, onChange: () => {} });
    await lock.start();
    assert.equal(lock.state.locked, true, code);
  }
  // The core comes up later and says the lock is off: unlocked then.
  let up = false;
  const lock = createAppLock({
    request: async () => (up ? { ok: { enabled: false } } : { error: { code: 'core-unavailable' } }),
    inCall: () => false,
    onChange: () => {},
  });
  await lock.start();
  assert.equal(lock.state.locked, true);
  up = true;
  await lock.coreUp();
  assert.equal(lock.state.locked, false);
});

test('start: no answer in 10 s shows the lock screen (fail closed)', () => {
  const h = harness({ getDelay: Infinity });
  void h.lock.start();
  h.advance(START_TIMEOUT_MS - 1);
  assert.equal(h.lock.state.pending, true);
  h.advance(1);
  assert.deepEqual(h.lock.state, { enabled: true, locked: true, pending: false, path: 'A' });
  assert.equal(h.lock.allows('getMessages', {}), false);
});

test('path A: only getAppInfo and status events while locked', async () => {
  const h = harness();
  await h.lock.start();
  assert.equal(h.lock.allows('getAppInfo', {}), true);
  for (const cmd of ['getMessages', 'leaveCall', 'setMuted', 'sendSignal', 'exportDiagnostics', 'setAppLock', 'clearAppLock']) {
    assert.equal(h.lock.allows(cmd, { muted: true }), false, cmd);
  }
  assert.equal(h.lock.forwards('core.status'), true);
  assert.equal(h.lock.forwards('call.state'), false);
  assert.equal(h.lock.forwards('message.new'), false);
});

test('path B (locked in a call): only leaveCall, setMuted(true) and sendSignal in a call', async () => {
  // Unlock, then lock again during a call.
  const on = harness();
  await on.lock.start();
  await on.lock.unlock({ passcode: '1234' });
  on.call.in = true;
  assert.equal(on.lock.lock(), true);
  assert.equal(on.lock.state.path, 'B');
  assert.equal(on.lock.allows('leaveCall', {}), true);
  assert.equal(on.lock.allows('setMuted', { muted: true }), true);
  assert.equal(on.lock.allows('setMuted', { muted: false }), false);
  assert.equal(on.lock.allows('setMuted', { muted: true, x: 1 }), false);
  assert.equal(on.lock.allows('setMuted', {}), false);
  assert.equal(on.lock.allows('sendSignal', { to: 'a', kind: 'ice', payload: '' }), true);
  assert.equal(on.lock.allows('getMessages', {}), false);
  assert.equal(on.lock.allows('exportDiagnostics', {}), false);
  assert.equal(on.lock.forwards('call.signal'), true);
  assert.equal(on.lock.forwards('call.state'), true);
  assert.equal(on.lock.forwards('message.new'), false);
  // sendSignal only while in a call.
  on.call.in = false;
  assert.equal(on.lock.allows('sendSignal', { to: 'a', kind: 'ice', payload: '' }), false);
  // The call ended: path A (reload).
  on.lock.callEnded();
  assert.equal(on.lock.state.path, 'A');
  assert.equal(on.lock.forwards('call.signal'), false);
});

test('idle locks after N minutes, never during a call; sleep locks', async () => {
  const h = harness({ config: { enabled: true, idleMinutes: 15, lockOnSleep: true } });
  await h.lock.start();
  await h.lock.unlock({ passcode: '1234' });
  assert.equal(h.lock.idleTick(15 * 60 - 1), false);
  h.call.in = true;
  assert.equal(h.lock.idleTick(3600), false);
  assert.equal(h.lock.state.locked, false);
  h.call.in = false;
  assert.equal(h.lock.idleTick(15 * 60), true);
  assert.equal(h.lock.state.locked, true);
  await h.lock.unlock({ passcode: '1234' });
  assert.equal(h.lock.onSleep(), true);
  assert.equal(h.lock.state.locked, true);
});

test('lock off: lock(), idle and sleep do nothing', async () => {
  const h = harness({ config: { enabled: false } });
  await h.lock.start();
  assert.equal(h.lock.lock(), false);
  assert.equal(h.lock.idleTick(99999), false);
  assert.equal(h.lock.onSleep(), false);
  assert.equal(h.lock.state.locked, false);
});

test('unlock: passcode goes to the core NFC-normalised; wrong and rate-limited stay locked', async () => {
  let answer = { result: 'wrong', retryAfter: 0 };
  const h = harness({ verify: () => answer });
  await h.lock.start();
  assert.equal(await h.lock.unlock({ passcode: '12' }), 'invalid');
  assert.equal(await h.lock.unlock({}), 'invalid');
  assert.equal(await h.lock.unlock('1234'), 'invalid');
  assert.equal(h.calls.filter(([c]) => c === 'verifyAppLock').length, 0, 'bad input never reaches the core');
  assert.equal(await h.lock.unlock({ passcode: 'était' }), 'wrong');
  assert.deepEqual(h.calls.at(-1), ['verifyAppLock', { passcode: 'était' }]);
  answer = { result: 'rate-limited', retryAfter: 30 };
  assert.equal(await h.lock.unlock({ passcode: '1234' }), 'rate-limited');
  assert.equal(h.lock.state.retryAfter, 30);
  assert.equal(h.lock.state.locked, true);
  answer = { result: 'ok' };
  assert.equal(await h.lock.unlock({ passcode: '1234' }), 'ok');
  assert.equal(h.lock.state.locked, false);
  assert.equal(h.lock.state.retryAfter, undefined);
  // The passcode is never in any state main hands on.
  assert.ok(!JSON.stringify(h.states).includes('1234'));
});

test('settings: config while unlocked only, never the verifier or attempts', async () => {
  const h = harness({ config: { enabled: true, idleMinutes: 15, lockOnSleep: false, method: 'passcode', verifier: 'x', attempts: 3 } });
  await h.lock.start();
  assert.equal(h.lock.config(), null, 'locked: nothing');
  await h.lock.unlock({ passcode: '1234' });
  assert.deepEqual(h.lock.config(), { enabled: true, idleMinutes: 15, lockOnSleep: false, method: 'passcode' });
});

test('settings: set / clear are checked by main, then by the core; main never fills current', async () => {
  const sent = [];
  let answer = { result: 'ok' };
  let cfg = { enabled: false };
  const lock = createAppLock({
    request: async (cmd, args) => {
      sent.push([cmd, args]);
      if (cmd === 'getAppLock') return { ok: cfg };
      if (cmd === 'setAppLock' || cmd === 'clearAppLock') return { ok: answer };
      return { error: { code: 'bad-request' } };
    },
    inCall: () => false,
    onChange: () => {},
  });
  await lock.start();
  assert.equal(lock.state.locked, false);
  // Shapes main refuses before the core sees them.
  for (const bad of [
    null,
    'x',
    [],
    { passcode: '12', idleMinutes: 5, lockOnSleep: true },
    { passcode: '1234', idleMinutes: 0, lockOnSleep: true },
    { passcode: '1234', idleMinutes: 61, lockOnSleep: true },
    { passcode: '1234', idleMinutes: 5.5, lockOnSleep: true },
    { passcode: '1234', idleMinutes: 5, lockOnSleep: 'yes' },
    { passcode: '1234', idleMinutes: 5, lockOnSleep: true, current: '1' },
    { passcode: '1234', idleMinutes: 5, lockOnSleep: true, method: 'os' },
    { passcode: '1234', idleMinutes: 5, lockOnSleep: true, verifier: 'x' },
  ]) {
    assert.deepEqual(await lock.set(bad), { result: 'invalid' }, JSON.stringify(bad));
  }
  assert.equal(sent.filter(([c]) => c === 'setAppLock').length, 0);
  // Turning it on: no current (none is set); the core re-reads after ok.
  cfg = { enabled: true, idleMinutes: 5, lockOnSleep: true };
  assert.deepEqual(await lock.set({ passcode: 'était1', idleMinutes: 5, lockOnSleep: true }), { result: 'ok' });
  assert.deepEqual(sent.find(([c]) => c === 'setAppLock')[1], { passcode: 'était1', method: 'passcode', idleMinutes: 5, lockOnSleep: true });
  assert.equal(lock.state.enabled, true, 'refreshed');
  // A wrong current counts (core) and comes back as wrong, with the delay.
  answer = { result: 'wrong', retryAfter: 30 };
  assert.deepEqual(await lock.clear({ current: '9999' }), { result: 'wrong', retryAfter: 30 });
  assert.deepEqual(sent.at(-1), ['clearAppLock', { current: '9999' }]);
  assert.deepEqual(await lock.clear({}), { result: 'invalid' });
  assert.deepEqual(await lock.clear({ current: '12' }), { result: 'invalid' });
  // Nothing main hands on carries a passcode.
  assert.ok(!JSON.stringify(lock.state).includes('9999'));
});

test('settings: one change at a time; refused while locked', async () => {
  let release;
  const lock = createAppLock({
    request: async (cmd) => {
      if (cmd === 'getAppLock') return { ok: { enabled: true } };
      if (cmd === 'verifyAppLock') return { ok: { result: 'ok' } };
      if (cmd === 'setAppLock') return new Promise((r) => (release = () => r({ ok: { result: 'ok' } })));
      return { error: { code: 'bad-request' } };
    },
    inCall: () => false,
    onChange: () => {},
  });
  await lock.start();
  const input = { current: '1234', passcode: '5678', idleMinutes: 5, lockOnSleep: true };
  assert.deepEqual(await lock.set(input), { result: 'locked' });
  assert.deepEqual(await lock.clear({ current: '1234' }), { result: 'locked' });
  await lock.unlock({ passcode: '1234' });
  const first = lock.set(input);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await lock.set(input), { result: 'busy' });
  assert.deepEqual(await lock.clear({ current: '1234' }), { result: 'busy' });
  release();
  assert.deepEqual(await first, { result: 'ok' });
});

test('start: a running delay (retryAfter from getAppLock) shows at once and survives a restart', async () => {
  const h = harness({ config: { enabled: true, idleMinutes: 5, lockOnSleep: true, retryAfter: 42.2 } });
  await h.lock.start();
  assert.equal(h.lock.state.retryAfter, 43);
});

test('forgot: the words clear the lock (core-checked, same counter)', async () => {
  const h = harness();
  await h.lock.start();
  assert.equal(await h.lock.unlock({ words: 'one two three' }), 'ok');
  assert.deepEqual(h.calls.at(-1), ['clearAppLockWithWords', { words: 'one two three' }]);
  assert.equal(h.lock.state.enabled, false);
  assert.equal(h.lock.lock(), false);
});
