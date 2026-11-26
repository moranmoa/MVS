// G-81: the voice frame channel (src/voiceframe.js, design g81-p2p-calls.md §2.3).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { MAX_PAYLOAD, FRAMES_PER_SEC, BURST, cleanOutgoing, cleanIncoming, createVoiceFrames, payloadBytes, sendAllowed } = require('../src/voiceframe');
const { createRequiredGate } = require('../src/required');
const { Sidecar } = require('../src/sidecar');
const { COMMANDS, toRequest } = require('../src/commands');

const CALL = 'a'.repeat(32);
const FROM = 'b'.repeat(64);
const b64 = (n) => Buffer.alloc(n, 7).toString('base64');
const frame = (o = {}) => ({ callId: CALL, seq: 1, ts: 960, data: b64(108), ...o });

test('payloadBytes: well-formed base64 only, decoded size', () => {
  assert.equal(payloadBytes(''), 0);
  assert.equal(payloadBytes(b64(1)), 1);
  assert.equal(payloadBytes(b64(2)), 2);
  assert.equal(payloadBytes(b64(MAX_PAYLOAD)), MAX_PAYLOAD);
  for (const bad of ['a', 'abc', 'ab=c', '====', 'a b=', '-_-_', 5, null, b64(MAX_PAYLOAD + 3)]) assert.equal(payloadBytes(bad), -1, String(bad));
});

test('outgoing frames: exactly { callId, seq, ts, data } within the §2.3 limits', () => {
  assert.deepEqual(cleanOutgoing(frame()), frame());
  assert.deepEqual(cleanOutgoing(frame({ data: '' })), frame({ data: '' }), 'DTX: an empty frame');
  assert.deepEqual(cleanOutgoing(frame({ data: b64(400), seq: 0xffffffff, ts: 0 })), frame({ data: b64(400), seq: 0xffffffff, ts: 0 }));
  for (const bad of [
    null,
    [],
    'x',
    frame({ data: b64(401) }),
    frame({ callId: 'A'.repeat(32) }),
    frame({ callId: 'a'.repeat(31) }),
    frame({ callId: 'a'.repeat(64) }),
    frame({ seq: -1 }),
    frame({ seq: 2 ** 32 }),
    frame({ seq: 1.5 }),
    frame({ ts: '960' }),
    frame({ data: 'not base64!' }),
    { ...frame(), to: FROM }, // the page names no target
    { callId: CALL, seq: 1, ts: 1 },
  ]) {
    assert.equal(cleanOutgoing(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('incoming frames: exactly { callId, from, seq, ts, data }', () => {
  assert.deepEqual(cleanIncoming({ ...frame(), from: FROM }), { ...frame(), from: FROM });
  for (const bad of [{ ...frame() }, { ...frame(), from: 'b'.repeat(63) }, { ...frame(), from: FROM, extra: 1 }, { ...frame({ data: b64(500) }), from: FROM }, null]) {
    assert.equal(cleanIncoming(bad), null);
  }
});

function harness({ inCall = true, unlocked = true, pathB = false } = {}) {
  const st = { inCall, unlocked, pathB, t: 0, sendOk: true };
  const sent = [];
  const delivered = [];
  const vf = createVoiceFrames({
    canSend: () => st.inCall && st.unlocked,
    canReceive: () => st.inCall && (st.unlocked || st.pathB),
    send: (f) => (st.sendOk ? (sent.push(f), true) : false),
    deliver: (f) => delivered.push(f),
    now: () => st.t,
  });
  return { vf, st, sent, delivered };
}

test('send: only in a call and unlocked; nothing while locked (the mic is forced off)', () => {
  const h = harness({ inCall: false });
  assert.equal(h.vf.fromPage(frame()), false, 'no call');
  h.st.inCall = true;
  assert.equal(h.vf.fromPage(frame()), true);
  h.st.unlocked = false;
  h.st.pathB = true;
  assert.equal(h.vf.fromPage(frame({ seq: 2 })), false, 'locked (path B): nothing goes out');
  assert.equal(h.sent.length, 1);
  assert.equal(h.vf.fromPage({ ...frame(), extra: 1 }), false, 'malformed');
});

test('receive: in a call, unlocked or behind a path B lock; never in path A or out of a call', () => {
  const h = harness();
  const f = { ...frame(), from: FROM };
  assert.equal(h.vf.fromCore(f), true);
  h.st.unlocked = false;
  h.st.pathB = true;
  assert.equal(h.vf.fromCore(f), true, 'path B: the call is still heard');
  h.st.pathB = false;
  assert.equal(h.vf.fromCore(f), false, 'path A');
  h.st.unlocked = true;
  h.st.inCall = false;
  assert.equal(h.vf.fromCore(f), false, 'no call');
  assert.equal(h.delivered.length, 2);
});

test('the global cap: 480 frames/s with a burst, each direction on its own', () => {
  const h = harness();
  let ok = 0;
  for (let i = 0; i < 1000; i++) ok += h.vf.fromPage(frame({ seq: i })) ? 1 : 0;
  assert.equal(ok, BURST, 'a burst, then nothing in the same instant');
  // The other direction has its own budget.
  assert.equal(h.vf.fromCore({ ...frame(), from: FROM }), true);
  // Over one second at a steady pace: ~480 more.
  ok = 0;
  for (let i = 0; i < 2000; i++) {
    h.st.t += 0.5; // 2000 tries over 1 s
    ok += h.vf.fromPage(frame({ seq: 1000 + i })) ? 1 : 0;
  }
  assert.ok(ok >= FRAMES_PER_SEC - 1 && ok <= FRAMES_PER_SEC + 1, String(ok));
  assert.ok(h.vf.counts.dropped > 0);
});

test('a backed-up pipe drops the frame (it never queues)', () => {
  const h = harness();
  h.st.sendOk = false;
  assert.equal(h.vf.fromPage(frame()), false);
  assert.equal(h.vf.counts.dropped, 1);
});

test('Sidecar.send: one { cmd, args } line, no id; dropped when down, too long or backed up', () => {
  const sc = new Sidecar({ exe: path.resolve('/x/mvs-core'), dataDir: path.resolve('/data'), onEvent() {} });
  assert.equal(sc.send('voiceFrame', frame()), false, 'no core');
  const lines = [];
  const stdin = { writable: true, writableLength: 0, write: (l) => lines.push(l) };
  sc.child = { stdin };
  assert.equal(sc.send('voiceFrame', frame()), true);
  const msg = JSON.parse(lines[0]);
  assert.deepEqual(msg, { cmd: 'voiceFrame', args: frame() });
  assert.ok(lines[0].endsWith('\n'));
  assert.equal(sc.pending.size, 0, 'nothing waits for a reply');
  assert.equal(sc.send('voiceFrame', { data: 'x'.repeat(5000) }), false, 'too long');
  stdin.writableLength = 70 * 1024;
  assert.equal(sc.send('voiceFrame', frame()), false, 'backed up');
  assert.equal(lines.length, 1);
});

test('sendAllowed: a call, unlocked, and no required update (#586, SL; TL: no grace)', () => {
  let inCall = true;
  const gate = createRequiredGate({ inCall: () => inCall, endCall: () => (inCall = false) });
  // No required update: the call and the lock decide.
  assert.equal(sendAllowed({ inCall: true, unlocked: true, requiredGate: gate }), true);
  assert.equal(sendAllowed({ inCall: false, unlocked: true, requiredGate: gate }), false);
  assert.equal(sendAllowed({ inCall: true, unlocked: false, requiredGate: gate }), false, 'G-78 lock');
  // Required: the call is ended at once, and frames stop, even with a call forced on.
  gate.set({ version: '0.6.0' });
  assert.equal(inCall, false, 'the call ended');
  assert.equal(gate.state.phase, 'gated');
  assert.equal(sendAllowed({ inCall: true, unlocked: true, requiredGate: gate }), false, 'gated + forced inCall');
  // Fails closed on a missing gate.
  assert.equal(sendAllowed({ inCall: true, unlocked: true, requiredGate: null }), false);
});

test('voiceFrame never goes through core:invoke', () => {
  assert.equal(Object.hasOwn(COMMANDS, 'voiceFrame'), false);
  assert.deepEqual(toRequest('voiceFrame', [CALL, 1, 960, b64(10)]), { error: 'not-allowed' });
});
