// QA MR.1: state events kept while locked (src/held.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATE_EVENTS, createHeldEvents } = require('../src/held');

test('only state events are kept, the latest of each, in arrival order', () => {
  const h = createHeldEvents();
  assert.equal(h.hold('message.new', { body: 'secret' }), false, 'content stays dropped');
  assert.equal(h.hold('typing', {}), false);
  assert.equal(h.hold('memberRelay.changed', { effective: false }), true);
  assert.equal(h.hold('update.ready', { version: '0.6.0' }), true);
  assert.equal(h.hold('memberRelay.changed', { effective: true }), true);
  assert.equal(h.size, 2);
  assert.deepEqual(h.take(), [
    ['update.ready', { version: '0.6.0' }],
    ['memberRelay.changed', { effective: true }],
  ]);
  assert.deepEqual(h.take(), [], 'taken once');
});

test('server.updated (T17-pre updateNeeded, #604) is kept per server, the latest of each', () => {
  const h = createHeldEvents();
  assert.equal(h.hold('server.updated', { id: 's1', updateNeeded: null }), true);
  assert.equal(h.hold('server.updated', { id: 's2', updateNeeded: null }), true);
  assert.equal(h.hold('server.updated', { id: 's1', updateNeeded: { cap: 'x' } }), true);
  assert.equal(h.hold('server.updated', { name: 'no id' }), false);
  assert.deepEqual(h.take(), [
    ['server.updated', { id: 's2', updateNeeded: null }],
    ['server.updated', { id: 's1', updateNeeded: { cap: 'x' } }],
  ]);
});

test('the list is the reviewed one (SL, LR-1)', () => {
  assert.deepEqual([...STATE_EVENTS].sort(), ['memberRelay.changed', 'server.updated', 'update.ready', 'update.required']);
});
