'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cleanCount, label, drawBadge, createBadge, SIZE, MAX, PER_SECOND } = require('../src/badge');

test('cleanCount takes whole numbers 0..MAX only', () => {
  for (const ok of [0, 1, 9, 10, MAX]) assert.equal(cleanCount(ok), ok);
  for (const bad of [-1, 1.5, MAX + 1, NaN, Infinity, '3', null, undefined, {}, [], true, 2n]) assert.equal(cleanCount(bad), null);
});

test('label is empty at 0, the digit up to 9, then 9+', () => {
  assert.equal(label(0), '');
  assert.equal(label(1), '1');
  assert.equal(label(9), '9');
  assert.equal(label(10), '9+');
  assert.equal(label(MAX), '9+');
});

const px = (buf, x, y) => [...buf.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4)];

test('drawBadge is a red disc with white glyphs, transparent corners', () => {
  for (const text of ['1', '8', '9+']) {
    const buf = drawBadge(text);
    assert.equal(buf.length, SIZE * SIZE * 4);
    assert.deepEqual(px(buf, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(px(buf, SIZE - 1, SIZE - 1), [0, 0, 0, 0]);
    // Some white, some solid red, and premultiplied: no channel above alpha.
    let white = 0;
    let red = 0;
    for (let i = 0; i < buf.length; i += 4) {
      assert.ok(buf[i] <= buf[i + 3] && buf[i + 1] <= buf[i + 3] && buf[i + 2] <= buf[i + 3]);
      if (buf[i] === 255 && buf[i + 1] === 255 && buf[i + 2] === 255) white++;
      if (buf[i + 2] === 0xda && buf[i + 3] === 255) red++;
    }
    assert.ok(white > 20, `${text}: glyph pixels`);
    assert.ok(red > 300, `${text}: disc pixels`);
  }
  assert.notDeepEqual(drawBadge('1'), drawBadge('7'));
});

function harness() {
  let t = 0;
  const applied = [];
  const timers = [];
  const b = createBadge({
    apply: (n) => applied.push(n),
    now: () => t,
    setTimer: (fn, ms) => timers.push({ fn, at: t + ms }),
  });
  const advance = (ms) => {
    t += ms;
    const due = timers.filter((x) => x.at <= t);
    for (const tm of due) timers.splice(timers.indexOf(tm), 1);
    for (const tm of due) tm.fn();
  };
  return { b, applied, timers, advance };
}

test('createBadge refuses bad values and skips repeats', () => {
  const { b, applied } = harness();
  assert.equal(b.set('5'), false);
  assert.equal(b.set(-2), false);
  assert.equal(b.set(0), true); // already 0: nothing to do
  assert.deepEqual(applied, []);
  b.set(3);
  b.set(3);
  assert.deepEqual(applied, [3]);
  assert.equal(b.current, 3);
});

test('createBadge applies at most PER_SECOND a second and the last value lands', () => {
  const { b, applied, advance } = harness();
  for (let n = 1; n <= 20; n++) b.set(n);
  assert.deepEqual(applied, [1, 2, 3, 4].slice(0, PER_SECOND));
  advance(999);
  assert.equal(applied.length, PER_SECOND);
  advance(1);
  assert.deepEqual(applied.at(-1), 20);
  assert.equal(applied.length, PER_SECOND + 1);
  assert.equal(b.current, 20);
});
