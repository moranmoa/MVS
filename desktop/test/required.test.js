// Required updates (#577): the read-only gate (src/required.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { COMMANDS } = require('../src/commands');
const { READ_ONLY, UPDATE, CALL, NOT_READ_ONLY, CALL_CAP_MS, CHECK_EVERY_MS, cleanRequired, createRequiredGate, createCheckThrottle } = require('../src/required');

test('every command in commands.js is classified exactly once', () => {
  const all = Object.keys(COMMANDS);
  const unclassified = all.filter((c) => !READ_ONLY.has(c) && !UPDATE.has(c) && !NOT_READ_ONLY.has(c));
  assert.deepEqual(unclassified, [], 'classify these in src/required.js');
  for (const c of all) {
    const n = [READ_ONLY, UPDATE, NOT_READ_ONLY].filter((s) => s.has(c)).length;
    assert.equal(n, 1, c);
  }
  // Nothing stale: every classified name is a real command.
  for (const c of [...READ_ONLY, ...UPDATE, ...NOT_READ_ONLY]) assert.ok(Object.hasOwn(COMMANDS, c), c);
  // checkForUpdate stays main/core only (B8 A2): the page reaches it through update:check.
  assert.equal(Object.hasOwn(COMMANDS, 'checkForUpdate'), false);
});

test('the read-only side never writes to or talks to the network', () => {
  for (const c of ['sendMessage', 'editMessage', 'deleteMessage', 'react', 'joinServer', 'createServer', 'createInvite', 'joinCall', 'sendSignal', 'kickMember', 'updateProfile', 'startDeviceLink', 'setTyping', 'restoreIdentity', 'setMemberRelay']) {
    assert.equal(READ_ONLY.has(c) || UPDATE.has(c), false, c);
  }
});

test('cleanRequired: { version } or null', () => {
  assert.deepEqual(cleanRequired({ version: '0.6.0' }), { version: '0.6.0' });
  assert.deepEqual(cleanRequired({ version: null }), { version: null }, 'revoked, nothing newer yet');
  assert.deepEqual(cleanRequired({ version: '<b>' }), { version: null });
  assert.equal(cleanRequired(null), null);
  assert.equal(cleanRequired(true), null);
});

function harness({ inCall = false } = {}) {
  const st = { inCall, t: 0, ended: 0 };
  const timers = [];
  const states = [];
  const gate = createRequiredGate({
    inCall: () => st.inCall,
    endCall: () => {
      st.ended++;
      st.inCall = false;
    },
    onChange: (s) => states.push(s),
    now: () => st.t,
    setTimer: (fn, ms) => {
      const tm = { fn, at: st.t + ms };
      timers.push(tm);
      return tm;
    },
    clearTimer: (tm) => timers.splice(timers.indexOf(tm), 1),
  });
  const advance = (ms) => {
    st.t += ms;
    for (const tm of timers.filter((x) => x.at <= st.t)) {
      timers.splice(timers.indexOf(tm), 1);
      tm.fn();
    }
  };
  return { gate, st, states, advance, timers };
}

test('not required: everything passes', () => {
  const { gate } = harness();
  assert.equal(gate.allows('sendMessage'), true);
  assert.equal(gate.state.active, false);
});

test('required: reads and update pass; writes and the network are refused; it never clears', () => {
  const { gate, states } = harness();
  assert.equal(gate.set({ version: '0.6.0' }), true);
  assert.equal(gate.state.active, true);
  for (const c of ['listServers', 'getMessages', 'exportDiagnostics', 'getAppInfo', 'restartToUpdate', 'leaveCall', 'signOut']) assert.equal(gate.allows(c), true, c);
  for (const c of ['sendMessage', 'joinServer', 'joinCall', 'sendSignal', 'updateProfile']) assert.equal(gate.allows(c), false, c);
  assert.equal(gate.allows('somethingNew'), false, 'unknown: refused');
  assert.equal(gate.set(null), false);
  assert.equal(gate.state.active, true, 'a null payload never clears it');
  assert.deepEqual(states.at(-1), { required: true, version: '0.6.0', active: true, phase: 'gated', callEndsAt: null });
});

test('in a call: only reads, the update and the call itself pass until the call ends (TL)', () => {
  const { gate, st } = harness({ inCall: true });
  gate.set({ version: '0.6.0' });
  assert.equal(gate.state.phase, 'call');
  assert.equal(gate.state.active, false);
  for (const c of [...CALL, 'getMessages', 'listServers', 'getAppInfo', 'restartToUpdate']) assert.equal(gate.allows(c), true, c);
  for (const c of ['sendMessage', 'joinServer', 'kickMember', 'createInvite', 'updateProfile', 'joinCall']) assert.equal(gate.allows(c), false, c);
  st.inCall = false;
  gate.callChanged();
  assert.equal(gate.state.phase, 'gated');
  assert.equal(gate.state.active, true);
  for (const c of ['sendSignal', 'setMuted', 'setDeafened']) assert.equal(gate.allows(c), false, c);
  assert.equal(gate.allows('leaveCall'), true);
  assert.equal(gate.allows('checkForUpdate'), false, 'Retry goes through main, not core:invoke');
});

test('Retry (update:check): main runs the check at most every 30 s; only a code goes back', async () => {
  let t = 0;
  const runs = [];
  let answer = { ok: { status: 'upToDate', secret: 'x' } };
  const check = createCheckThrottle({ run: async () => (runs.push(t), answer), now: () => t });
  assert.equal(await check(), 'ok');
  t = CHECK_EVERY_MS - 1;
  assert.equal(await check(), 'too-soon');
  t = CHECK_EVERY_MS;
  answer = { error: { code: 'offline', detail: 'x' } };
  assert.equal(await check(), 'offline');
  assert.deepEqual(runs, [0, CHECK_EVERY_MS]);
  // Two at once: the second waits its turn.
  t = 10 * CHECK_EVERY_MS;
  let release;
  const slow = createCheckThrottle({ run: () => new Promise((r) => (release = () => r({ ok: null }))), now: () => t });
  const first = slow();
  assert.equal(await slow(), 'too-soon');
  release();
  assert.equal(await first, 'ok');
  // Only a plain code goes back.
  for (const code of ['<b>x</b>', 'Offline', 'x'.repeat(41), 42, '']) {
    const odd = createCheckThrottle({ run: async () => ({ error: { code } }) });
    assert.equal(await odd(), 'internal', String(code));
  }
  // A throw is 'internal', never an exception to the page.
  const bad = createCheckThrottle({ run: async () => { throw new Error('no'); } });
  assert.equal(await bad(), 'internal');
});

test('the state for a page that asks: phase and version, never cleared', () => {
  const { gate } = harness();
  assert.deepEqual(gate.state, { required: false, version: null, active: false, phase: 'none', callEndsAt: null });
  gate.set({ version: '0.6.0' });
  assert.deepEqual(gate.state, { required: true, version: '0.6.0', active: true, phase: 'gated', callEndsAt: null });
});

test('in a call: at most 30 min, then main ends the call and the gate applies', () => {
  const { gate, st, advance, states } = harness({ inCall: true });
  gate.set({ version: '0.6.0' });
  assert.equal(gate.state.callEndsAt, CALL_CAP_MS);
  advance(CALL_CAP_MS - 1);
  assert.equal(st.ended, 0);
  assert.equal(gate.state.active, false);
  advance(1);
  assert.equal(st.ended, 1, 'main ended the call');
  assert.equal(gate.state.active, true);
  assert.equal(states.at(-1).active, true);
  // A new call can't lift it.
  st.inCall = true;
  gate.callChanged();
  assert.equal(gate.state.active, true);
});

test('a call that ends before the cap cancels the timer', () => {
  const { gate, st, advance, timers } = harness({ inCall: true });
  gate.set({ version: null });
  st.inCall = false;
  gate.callChanged();
  assert.equal(timers.length, 0);
  advance(CALL_CAP_MS * 2);
  assert.equal(st.ended, 0);
  assert.equal(gate.state.active, true);
});
