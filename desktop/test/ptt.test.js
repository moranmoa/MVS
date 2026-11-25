'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cleanKey, cleanAccelerator, createPtt, createGlobalMute, RELEASE_MS } = require('../src/ptt');

/** createGlobalMute with a fake OS: what is registered right now, and the presses the page got. */
function globalMuteHarness({ taken = false } = {}) {
  const os = new Map();
  const st = { inCall: false, unlocked: true };
  const presses = [];
  const gm = createGlobalMute({
    register: (accel, cb) => {
      if (taken || os.has(accel)) return false;
      os.set(accel, cb);
      return true;
    },
    unregister: (accel) => os.delete(accel),
    allowed: () => st.inCall && st.unlocked,
    onPress: () => presses.push(1),
  });
  return { gm, os, st, presses };
}

test('G-78 global mute: registered only in a call and unlocked; lock, leave and sign-out let go', () => {
  const { gm, os, st, presses } = globalMuteHarness();
  const KEY = 'CommandOrControl+Shift+M';
  // Chosen outside a call (signed in, idle): tried, never left registered.
  assert.equal(gm.set(KEY), 'ok');
  assert.equal(os.size, 0, 'idle: not registered');
  // In a call, unlocked: registered.
  st.inCall = true;
  gm.sync();
  assert.deepEqual([...os.keys()], [KEY]);
  os.get(KEY)();
  assert.equal(presses.length, 1);
  // Lock (path B: still in the call): unregistered.
  st.unlocked = false;
  gm.sync();
  assert.equal(os.size, 0, 'locked in a call: not registered');
  // Unlock while still in the call: registered again.
  st.unlocked = true;
  gm.sync();
  assert.deepEqual([...os.keys()], [KEY]);
  // A press that arrives while locked (a race) never reaches the page.
  const cb = os.get(KEY);
  st.unlocked = false;
  cb();
  assert.equal(presses.length, 1);
  st.unlocked = true;
  // Leave: unregistered.
  st.inCall = false;
  gm.sync();
  assert.equal(os.size, 0, 'left the call: not registered');
  // Path A (locked, not in a call) stays off; a new call while locked stays off.
  st.unlocked = false;
  st.inCall = true;
  gm.sync();
  assert.equal(os.size, 0);
  // Sign-out: the choice is forgotten; a later call registers nothing.
  st.unlocked = true;
  gm.sync();
  assert.equal(os.size, 1);
  gm.clear();
  assert.equal(os.size, 0);
  gm.sync();
  assert.equal(os.size, 0, 'after sign-out: nothing');
});

test('G-74 global mute: a taken shortcut says so; null turns it off', () => {
  const taken = globalMuteHarness({ taken: true });
  assert.equal(taken.gm.set('Control+Alt+0'), 'shortcut-taken');
  assert.equal(taken.gm.set('Control+Alt+0'), 'shortcut-taken', 'the same again: same answer');
  const { gm, os, st } = globalMuteHarness();
  st.inCall = true;
  assert.equal(gm.set('F13'), 'ok');
  assert.equal(os.size, 1);
  assert.equal(gm.set(null), 'ok');
  assert.equal(os.size, 0);
});

test('cleanKey takes listed KeyboardEvent.code values only', () => {
  for (const ok of ['KeyV', 'Digit0', 'F13', 'F24', 'ControlLeft', 'AltRight', 'Backquote', 'Space', 'CapsLock', 'Numpad5', 'NumpadEnter', 'ArrowUp']) {
    assert.equal(cleanKey(ok), ok);
  }
  assert.equal(cleanKey(null), null);
  for (const bad of ['', 'v', 'Keyv', 'KeyAB', 'MetaLeft', 'OSLeft', 'F25', 'Escape', 'Enter', 'KeyV ', 7, {}, undefined, 'x'.repeat(100)]) {
    assert.equal(cleanKey(bad), undefined, String(bad));
  }
});

test('cleanAccelerator: two modifiers for common keys, F13-F24 as they are', () => {
  for (const ok of ['CommandOrControl+Shift+M', 'Control+Alt+0', 'Alt+Shift+F1', 'Control+Alt+Shift+9', 'F13', 'F24', 'Shift+F13', 'Alt+Shift+F20']) {
    assert.equal(cleanAccelerator(ok), ok);
  }
  assert.equal(cleanAccelerator(null), null);
  // Common one-modifier shortcuts are never taken from other apps.
  for (const bad of ['CommandOrControl+C', 'CommandOrControl+V', 'CommandOrControl+W', 'Control+C', 'Alt+F4', 'Shift+F10', 'Alt+Tab', 'Shift+F5', 'Alt+F1', 'Alt+M']) {
    assert.equal(cleanAccelerator(bad), undefined, bad);
  }
  for (const bad of ['M', 'F5', 'Shift+Shift+M', 'Super+M', 'Meta+M', 'CommandOrControl+Control+M', 'Ctrl+M', 'Alt+m', 'Alt+Space', 'Alt+Shift+Control+CommandOrControl+M', '+M', 'Alt+', '', 5, undefined]) {
    assert.equal(cleanAccelerator(bad), undefined, String(bad));
  }
});

function harness({ inCall = true } = {}) {
  let t = 0;
  const events = [];
  const timers = new Map();
  let nextId = 1;
  const state = { inCall };
  const p = createPtt({
    emit: (name) => events.push(name),
    active: () => state.inCall,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    t += ms;
    for (const [id, tm] of [...timers]) {
      if (tm.at <= t) {
        timers.delete(id);
        tm.fn();
      }
    }
  };
  const down = (code = 'KeyV') => p.onInput({ type: 'keyDown', code });
  const up = (code = 'KeyV') => p.onInput({ type: 'keyUp', code });
  return { p, events, advance, down, up, state };
}

test('hold to talk: down at once, up 200 ms after release', () => {
  const h = harness();
  h.p.setKey('KeyV');
  h.down();
  h.down(); // auto-repeat
  assert.deepEqual(h.events, ['ptt.down']);
  h.up();
  h.advance(RELEASE_MS - 1);
  assert.deepEqual(h.events, ['ptt.down']);
  h.advance(1);
  assert.deepEqual(h.events, ['ptt.down', 'ptt.up']);
  assert.equal(h.p.talking, false);
});

test('pressing again within the release delay keeps talking', () => {
  const h = harness();
  h.p.setKey('KeyV');
  h.down();
  h.up();
  h.advance(100);
  h.down();
  h.advance(500);
  assert.deepEqual(h.events, ['ptt.down']);
  h.up();
  h.advance(RELEASE_MS);
  assert.deepEqual(h.events, ['ptt.down', 'ptt.up']);
});

test('losing focus while holding releases after the delay (Alt+Tab)', () => {
  const h = harness();
  h.p.setKey('KeyV');
  h.down();
  h.p.onBlur(); // the key-up goes to another app
  h.advance(RELEASE_MS);
  assert.deepEqual(h.events, ['ptt.down', 'ptt.up']);
  // Back in the window, a fresh press talks again.
  h.down();
  assert.deepEqual(h.events, ['ptt.down', 'ptt.up', 'ptt.down']);
});

test('other keys, no key, or no call: nothing is reported', () => {
  const h = harness();
  h.down();
  h.up();
  h.p.setKey('KeyV');
  for (const code of ['KeyA', 'Enter', 'KeyB']) {
    h.down(code);
    h.up(code);
  }
  h.p.onInput(null);
  h.p.onInput({ type: 'char', code: 'KeyV' });
  h.state.inCall = false;
  h.down();
  h.up();
  h.advance(1000);
  assert.deepEqual(h.events, []);
});

test('changing the key or reset while talking releases at once', () => {
  const h = harness();
  h.p.setKey('KeyV');
  h.down();
  h.p.setKey('KeyB');
  assert.deepEqual(h.events, ['ptt.down', 'ptt.up']);
  h.down('KeyB');
  h.p.reset();
  assert.deepEqual(h.events, ['ptt.down', 'ptt.up', 'ptt.down', 'ptt.up']);
  h.p.reset();
  h.advance(1000);
  assert.equal(h.events.length, 4);
});
