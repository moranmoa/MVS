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
// (press only, no keyboard listener). It must carry a modifier (or be
// F13-F24), so a plain key is never taken from every other app.
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
 * A globalShortcut accelerator: 1-3 distinct modifiers + A-Z, 0-9 or F1-F24,
 * or a bare F13-F24. Null to switch off, undefined if refused.
 */
function cleanAccelerator(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 64) return undefined;
  const parts = v.split('+');
  const key = parts.pop();
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key)) return undefined;
  if (parts.length === 0) return /^F(?:1[3-9]|2[0-4])$/.test(key) ? v : undefined;
  if (parts.length > 3 || new Set(parts).size !== parts.length) return undefined;
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

module.exports = { cleanKey, cleanAccelerator, createPtt, RELEASE_MS };
