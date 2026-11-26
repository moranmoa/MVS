// QA MR.1: while the app lock is pending or showing, main forwards only the
// lock's own events (applock.js EVENTS_A / EVENTS_B) and dropped the rest.
// A one-shot "current value" event the core sends only on a change (e.g.
// memberRelay.changed) was then lost for good. Main now keeps the LATEST
// value of each such state event while locked and hands it to the page once
// it is open. Message content and other events stay dropped (SL).
'use strict';

/**
 * State events: each payload is the whole current value, so only the latest
 * matters and replaying it is safe. (SL to confirm the list.)
 */
const STATE_EVENTS = Object.freeze(
  new Set([
    'memberRelay.changed', // { role, setting, effective, disclosureSeen, … }
    'update.ready', // the staged update
    'update.required', // also read again at core start (#577)
  ]),
);

function createHeldEvents({ names = STATE_EVENTS } = {}) {
  const held = new Map();
  return {
    /** A core event main didn't forward (locked): keep it if it's a state event. True if kept. */
    hold(name, payload) {
      if (!names.has(name)) return false;
      held.delete(name); // keep the arrival order of the latest values
      held.set(name, payload);
      return true;
    },
    /** Everything kept, oldest first, and forget it. */
    take() {
      const out = [...held.entries()];
      held.clear();
      return out;
    },
    get size() {
      return held.size;
    },
  };
}

module.exports = { STATE_EVENTS, createHeldEvents };
