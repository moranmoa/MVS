// G-74: push-to-talk (docs/ux/specs/chat-and-voice-extras.md §6).
//
// v1 is focused-window only: main watches our own window's key events
// (webContents 'before-input-event', so it works with focus in a text box)
// for the one key the page configured, and tells the page `ptt.down` /
// `ptt.up`. No other key is ever reported, and nothing is reported when no
// key is set or when we're not in a call. Release waits 200 ms; losing focus
// counts as a release (the key-up may never arrive after Alt+Tab).
//
// Optional: a global "toggle mute" shortcut through Electron's globalShortcut
// (press only, no keyboard listener), registered only during a call. It
// needs two modifiers (or F13-F24), so neither a plain key nor a common
// shortcut like Ctrl+C or Alt+F4 is ever taken from every other app.
'use strict';

const RELEASE_MS = 200;

// KeyboardEvent.code values the push-to-talk key may be. Meta/OS keys are not
// on the list.
const KEY_CODE = new RegExp(
  '^(?:' +
    [
      'Key[A-Z]',
      'Digit[0-9]',
      'Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)',
      'F(?:[1-9]|1[0-9]|2[0-4])',
      '(?:Shift|Control|Alt)(?:Left|Right)',
      'Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash',
      'Space|CapsLock|Tab|Insert|Delete|Home|End|PageUp|PageDown|Pause|ScrollLock',
      'Arrow(?:Up|Down|Left|Right)',
    ].join('|') +
    ')$',
);

/** The push-to-talk key as a KeyboardEvent.code, null to switch off, undefined if refused. */
function cleanKey(v) {
  if (v === null) return null;
  return typeof v === 'string' && v.length <= 32 && KEY_CODE.test(v) ? v : undefined;
}

const MODIFIERS = ['CommandOrControl', 'Control', 'Alt', 'Shift'];

/**
 * A globalShortcut accelerator: F13-F24 (no keyboard uses them for anything
 * else) with 0-3 modifiers, or A-Z, 0-9, F1-F12 with 2-3 distinct modifiers,
 * so a page can never take a common one-modifier shortcut (Ctrl+C, Ctrl+V,
 * Alt+F4, Shift+F10…) from every other app. Null to switch off, undefined if
 * refused.
 */
function cleanAccelerator(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 64) return undefined;
  const parts = v.split('+');
  const key = parts.pop();
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key)) return undefined;
  const rare = /^F(?:1[3-9]|2[0-4])$/.test(key);
  if (parts.length === 0) return rare ? v : undefined;
  if (parts.length > 3 || new Set(parts).size !== parts.length) return undefined;
  if (!rare && parts.length < 2) return undefined;
  if (!parts.every((m) => MODIFIERS.includes(m))) return undefined;
  // CommandOrControl already is Control on Windows and Linux.
  if (parts.includes('CommandOrControl') && parts.includes('Control')) return undefined;
  return v;
}

/**
 * The key watch. `emit(name)` sends 'ptt.down' / 'ptt.up' to the page;
 * `active()` says whether we're in a call.
 */
function createPtt({ emit, active, setTimer = setTimeout, clearTimer = clearTimeout, releaseMs = RELEASE_MS }) {
  let key = null;
  let talking = false;
  let held = false;
  let release = null;

  const stopRelease = () => {
    if (release) clearTimer(release);
    release = null;
  };
  const up = () => {
    stopRelease();
    held = false;
    if (!talking) return;
    talking = false;
    emit('ptt.up');
  };
  const scheduleUp = () => {
    held = false;
    if (!talking || release) return;
    release = setTimer(() => {
      release = null;
      up();
    }, releaseMs);
  };

  return {
    /** Sets the key (a checked code or null). A change while talking releases at once. */
    setKey(code) {
      if (code !== key) up();
      key = code;
    },
    get key() {
      return key;
    },
    get talking() {
      return talking;
    },
    /** Electron's before-input-event `input`. Never stops the key reaching the page. */
    onInput(input) {
      if (!key || !input || input.code !== key) return;
      if (input.type === 'keyDown') {
        if (held) return; // auto-repeat
        held = true;
        if (talking) {
          stopRelease(); // pressed again within the release delay
          return;
        }
        if (!active()) return;
        talking = true;
        emit('ptt.down');
      } else if (input.type === 'keyUp') {
        scheduleUp();
      }
    },
    /** The window lost focus: the key-up may never come. */
    onBlur() {
      scheduleUp();
    },
    /** The call ended or the page is gone. */
    reset() {
      up();
    },
  };
}

/**
 * G-74 + G-78: the global "toggle mute" shortcut. It is registered with the
 * OS only while `allowed()` (in a call AND unlocked), and a press reaches the
 * page only then too, so nobody at a locked computer can unmute a call
 * behind the lock (path B). `register(accel, onPress)` / `unregister(accel)`
 * are Electron's globalShortcut; `onPress()` tells the page.
 */
function createGlobalMute({ register, unregister, allowed, onPress }) {
  let accel = null; // what the page chose (checked), or null
  let status = 'ok'; // what set() answered: 'ok' | 'shortcut-taken'
  let registered = null; // registered with the OS right now, or null

  const doRegister = () => {
    if (!accel || registered) return !!registered;
    let ok = false;
    try {
      ok = register(accel, () => {
        if (allowed()) onPress();
      });
    } catch {
      ok = false;
    }
    if (ok) registered = accel;
    return ok;
  };
  const off = () => {
    if (registered) unregister(registered);
    registered = null;
  };
  const api = {
    get registered() {
      return registered;
    },
    /** Registered exactly while allowed(). Call after every call or lock change. */
    sync() {
      if (allowed() && accel) doRegister();
      else off();
    },
    /**
     * The page's choice (already cleaned). Outside a call it is only tried
     * (register, then unregister in the same tick, never live) so the page
     * can say "taken"; it stays registered only while allowed().
     */
    set(next) {
      if (next === accel) return status;
      off();
      accel = next;
      status = 'ok';
      if (!accel) return 'ok';
      if (!doRegister()) status = 'shortcut-taken';
      api.sync();
      return status;
    },
    /** Sign-out: forget the choice and let go of the OS shortcut. */
    clear() {
      off();
      accel = null;
      status = 'ok';
    },
  };
  return api;
}

module.exports = { cleanKey, cleanAccelerator, createPtt, createGlobalMute, RELEASE_MS };
