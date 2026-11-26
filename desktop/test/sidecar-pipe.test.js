// The core exits under us: writing to its dead stdin must never crash main
// (it did on Windows: "Uncaught Exception: write EPIPE at Sidecar.request").
// A fake child, no real process.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
const { Sidecar } = require('../src/sidecar');

/** A child whose stdin fails every write with EPIPE (asynchronously, like a dead pipe). */
function deadPipeChild() {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _enc, cb) {
      const e = new Error('write EPIPE');
      e.code = 'EPIPE';
      setImmediate(() => cb(e));
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

function sidecarWith(child, logs = []) {
  return new Sidecar({
    exe: path.resolve('/x/mvs-core'),
    dataDir: path.resolve('/data'),
    onEvent() {},
    log: (l) => logs.push(l),
    backoffBase: 60_000, // no restart during the test
    spawnImpl: () => child,
  }).start();
}

test('a dead stdin fails the request with core-restarted, and nothing is thrown', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const child = deadPipeChild();
    const logs = [];
    const core = sidecarWith(child, logs);
    const res = await core.request('getAppInfo', {});
    assert.deepEqual(res, { error: { code: 'core-restarted' } });
    assert.equal(core.pending.size, 0);
    // The stream is now destroyed: the next request doesn't write at all.
    assert.deepEqual(await core.request('listServers', {}), { error: { code: 'core-restarted' } });
    assert.equal(core.send('voiceFrame', {}), false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(uncaught, []);
    assert.ok(logs.some((l) => l === 'core input closed: EPIPE'), logs.join('|'));
    core.stop();
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('the core exits while requests wait: they fail, and a later request writes nothing', async () => {
  const child = deadPipeChild();
  // A stdin that accepts writes until the exit, then is closed.
  child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
  const core = sidecarWith(child);
  const waiting = core.request('getMessages', {});
  child.stdin.destroy();
  child.emit('exit', 1, null);
  assert.deepEqual(await waiting, { error: { code: 'core-restarted' } });
  // Down now: no child, a clear error, no write.
  assert.equal((await core.request('getAppInfo', {})).error.code, 'core-unavailable');
  core.stop();
});

test('a write that throws synchronously fails only that request', async () => {
  const child = deadPipeChild();
  child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
  child.stdin.write = () => {
    throw new Error('boom');
  };
  const core = sidecarWith(child);
  assert.deepEqual(await core.request('getAppInfo', {}), { error: { code: 'core-restarted' } });
  assert.equal(core.pending.size, 0);
  assert.equal(core.send('voiceFrame', {}), false);
  core.stop();
});
