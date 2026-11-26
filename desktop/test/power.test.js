// Relay-in-app R1 (RR2): the power-source watch (src/power.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { readOnBattery, watchPower } = require('../src/power');
const { COMMANDS, toRequest } = require('../src/commands');

/** A powerMonitor stand-in: emits on-battery / on-ac; isOnBatteryPower() as set. */
function fakeMonitor(onBattery = false) {
  const m = new EventEmitter();
  m.state = onBattery;
  m.isOnBatteryPower = () => m.state;
  return m;
}
const fakeTimers = () => {
  const t = { fns: [], setInterval: (fn) => (t.fns.push(fn), t.fns.length), clearInterval: (id) => (t.fns[id - 1] = null) };
  t.tick = () => t.fns.forEach((fn) => fn && fn());
  return t;
};

test('readOnBattery: the OS answer; an error counts as on battery (fail closed)', () => {
  assert.equal(readOnBattery(fakeMonitor(false)), false);
  assert.equal(readOnBattery(fakeMonitor(true)), true);
  assert.equal(readOnBattery({ isOnBatteryPower: () => { throw new Error('no'); } }), true);
  assert.equal(readOnBattery({}), true, 'no such method');
  assert.equal(readOnBattery({ isOnBatteryPower: () => undefined }), true, 'not a clear "no"');
});

test('watchPower: the first answer at once, then only changes, from the events', () => {
  const m = fakeMonitor(false);
  const seen = [];
  const w = watchPower({ powerMonitor: m, onChange: (v) => seen.push(v), timers: fakeTimers() });
  assert.deepEqual(seen, [false]);
  assert.equal(w.current(), false);
  m.state = true;
  m.emit('on-battery');
  m.emit('on-battery'); // the same again: no call
  assert.deepEqual(seen, [false, true]);
  assert.equal(w.current(), true);
  m.state = false;
  m.emit('on-ac');
  assert.deepEqual(seen, [false, true, false]);
});

test('watchPower: a missed event is caught by the periodic read', () => {
  const m = fakeMonitor(false);
  const t = fakeTimers();
  const seen = [];
  watchPower({ powerMonitor: m, onChange: (v) => seen.push(v), timers: t });
  m.state = true; // unplugged, no event
  t.tick();
  assert.deepEqual(seen, [false, true]);
});

test('watchPower: stop removes the listeners and the timer', () => {
  const m = fakeMonitor(false);
  const t = fakeTimers();
  const seen = [];
  const w = watchPower({ powerMonitor: m, onChange: (v) => seen.push(v), timers: t });
  w.stop();
  assert.equal(m.listenerCount('on-battery'), 0);
  assert.equal(m.listenerCount('on-ac'), 0);
  m.state = true;
  m.emit('on-battery');
  t.tick();
  assert.deepEqual(seen, [false]);
});

test('setOnBattery is shell-only: never through core:invoke', () => {
  assert.equal(Object.hasOwn(COMMANDS, 'setOnBattery'), false);
  assert.deepEqual(toRequest('setOnBattery', [false]), { error: 'not-allowed' });
});
