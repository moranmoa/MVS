// Member relays, slice 3a: the metered-connection check (src/metered.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/metered');
const { toRequest } = require('../src/commands');

test('Windows: Fixed or Variable cost, roaming or over the data limit is metered', () => {
  // Real output on an unmetered Windows 11 machine.
  assert.equal(m.parseWindows('Unrestricted|False|False\r\n'), false);
  for (const out of ['Fixed|False|False', 'Variable|False|False\n', 'Unrestricted|True|False', 'Unrestricted|False|True', 'fixed|false|false']) {
    assert.equal(m.parseWindows(out), true, out);
  }
  // No internet profile, unknown cost, junk or an error text: not metered.
  for (const out of ['none', 'Unknown|False|False', '', 'Fixed', 'Fixed|False', 'Exception calling "GetConnectionCost"', null, undefined, 7]) {
    assert.equal(m.parseWindows(out), false, String(out));
  }
});

test('Linux: NetworkManager Metered yes (1) or guess-yes (3) is metered', () => {
  assert.equal(m.parseLinux('(<uint32 1>,)\n'), true);
  assert.equal(m.parseLinux('(<uint32 3>,)'), true);
  for (const out of ['(<uint32 0>,)', '(<uint32 2>,)', '(<uint32 4>,)', '(<uint32 13>,)', '(<uint32 1>,) junk', 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown', '', null]) {
    assert.equal(m.parseLinux(out), false, String(out));
  }
});

test('the query per platform: absolute paths, no shell; macOS never metered', () => {
  const PS = '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const win = m.queryFor('win32', { SystemRoot: 'D:\\Win' }, (p) => p === 'D:\\Win');
  assert.equal(win.file, 'D:\\Win' + PS);
  // A relative, missing or absent SystemRoot falls back to C:\Windows.
  for (const SystemRoot of ['Windows', 'Z:\\nope', undefined, '']) {
    assert.equal(m.queryFor('win32', { SystemRoot }, () => false).file, 'C:\\Windows' + PS, String(SystemRoot));
  }
  assert.deepEqual(win.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(win.parse, m.parseWindows);
  const linux = m.queryFor('linux', {}, (p) => p === '/usr/bin/gdbus');
  assert.equal(linux.file, '/usr/bin/gdbus');
  assert.equal(linux.parse, m.parseLinux);
  assert.equal(m.queryFor('linux', {}, () => false), null, 'no gdbus: not metered');
  assert.equal(m.queryFor('darwin'), null);
});

test('any failure is not metered', async () => {
  const query = { file: 'x', args: [], parse: m.parseWindows };
  assert.equal(await m.checkMetered({ query, exec: async () => 'Fixed|False|False' }), true);
  assert.equal(await m.checkMetered({ query, exec: async () => { throw new Error('timeout'); } }), false);
  assert.equal(await m.checkMetered({ query: null, exec: async () => 'Fixed|False|False' }), false);
  assert.equal(await m.checkMetered({ query: { ...query, parse: () => { throw new Error('x'); } }, exec: async () => '' }), false);
});

/** Manual timers: each setInterval callback can be fired by hand. */
function fakeTimers() {
  const list = [];
  return {
    list,
    timers: {
      setInterval: (fn, ms) => (list.push({ fn, ms, on: true }), list.length - 1),
      clearInterval: (i) => (list[i].on = false),
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the watch asks at start, every 60 s and on a network change; reports only changes', async () => {
  const answers = [false, false, true, true, false];
  let asked = 0;
  const changes = [];
  let ifaces = { eth0: [{ family: 'IPv4', address: '192.0.2.1', internal: false }] };
  const { list, timers } = fakeTimers();
  const w = m.watchMetered({ onChange: (v) => changes.push(v), check: async () => answers[asked++], interfaces: () => ifaces, timers });
  await tick();
  assert.equal(asked, 1, 'at start');
  assert.deepEqual(changes, [false], 'the first answer is reported');
  assert.equal(w.current(), false);
  const [every, poll] = list;
  assert.equal(every.ms, 60_000);
  every.fn();
  await tick();
  assert.equal(asked, 2);
  assert.deepEqual(changes, [false], 'same answer, no change');
  // The poll asks only when the network changed.
  poll.fn();
  await tick();
  assert.equal(asked, 2, 'no network change, no question');
  ifaces = { wlan0: [{ family: 'IPv4', address: '198.51.100.9', internal: false }] };
  poll.fn();
  await tick();
  assert.equal(asked, 3);
  assert.deepEqual(changes, [false, true]);
  assert.equal(w.current(), true);
  w.stop();
  assert.ok(!every.on && !poll.on);
});

test('the page cannot set the metered flag: setMetered is shell only', () => {
  assert.deepEqual(toRequest('setMetered', [false]), { error: 'not-allowed' });
});

test('the network key ignores loopback and changes with an address', () => {
  const lo = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  assert.equal(m.networkKey(lo), '');
  const a = m.networkKey({ ...lo, eth0: [{ family: 'IPv4', address: '192.0.2.1', internal: false }] });
  const b = m.networkKey({ ...lo, eth0: [{ family: 'IPv4', address: '192.0.2.2', internal: false }] });
  assert.notEqual(a, b);
  assert.equal(m.networkKey(null), '');
});
