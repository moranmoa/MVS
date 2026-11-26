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

test('the list is the reviewed one', () => {
  assert.deepEqual([...STATE_EVENTS].sort(), ['memberRelay.changed', 'update.ready', 'update.required']);
});
