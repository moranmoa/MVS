// The only thing the page gets from the shell: `window.mvs.invoke` and
// `window.mvs.onEvent`. ipcRenderer itself is never exposed. The main
// process checks every call (sender, allow-list, size); see main.js.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
// Shell events can arrive before the UI has subscribed: `link.open` (an
// mvs:// invite, e.g. on the first launch) and `core.status` (sent at load).
// The latest of each is kept for the first subscriber.
const KEPT = new Set(['link.open', 'link.message', 'core.status']);
const pending = new Map();

ipcRenderer.on('core:event', (_e, name, payload) => {
  if (KEPT.has(name) && listeners.size === 0) {
    pending.set(name, payload);
    return;
  }
  for (const cb of listeners) cb(name, payload);
});

// G-81: voice frames from the core, on their own channel (one listener at a time).
let frameListener = null;
ipcRenderer.on('voice:frame', (_e, frame) => {
  if (frameListener) frameListener(frame);
});

// T8-04: in the checkout demo (main adds this argument only then) the page
// gets no `invoke`, so the UI runs on its mock; main refuses core:invoke too.
const DEMO = Array.isArray(process.argv) && process.argv.includes('--mvs-demo');

contextBridge.exposeInMainWorld('mvs', {
  /** Resolves with { ok } or { error: { code, positions? } }. */
  ...(DEMO ? {} : { invoke: (cmd, args) => ipcRenderer.invoke('core:invoke', String(cmd), Array.isArray(args) ? args : []) }),
  /**
   * G-81 (design g81-p2p-calls.md §2.3): Opus frames over the P2P network.
   * `send({ callId, seq, ts, data })` is fire-and-forget (data: base64, ≤ 400
   * bytes decoded); main drops what is malformed, over the rate cap, or not
   * in a call and unlocked. `onFrame(cb)` gets { callId, from, seq, ts, data }
   * from the core; one listener (a new one replaces it). Returns an unsubscribe.
   * Not in the demo (T8-04): no core, no calls (SL).
   */
  ...(DEMO
    ? {}
    : {
        voice: Object.freeze({
          send: (frame) => ipcRenderer.send('voice:frame', frame),
          onFrame: (callback) => {
            if (typeof callback !== 'function') return () => {};
            frameListener = callback;
            return () => {
              if (frameListener === callback) frameListener = null;
            };
          },
        }),
      }),
  /**
   * Calls back with (eventName, payload) for every core event, plus
   * `link.open` { link } when the OS opens an mvs:// invite. Returns an
   * unsubscribe.
   */
  /** Puts plain text on the clipboard (e.g. an invite link). Resolves true if it did. */
  copyText: (text) => ipcRenderer.invoke('clipboard:write', String(text)),
  /** "Core unavailable" screen: start the core again now. Status follows as core.status. */
  retryCore: () => ipcRenderer.invoke('core:retry'),
  /**
   * G-61: a desktop notification { title, body, channelId, messageId }, shown
   * by the shell; a click arrives as the `notify.click` event. Resolves true if shown.
   */
  notify: (notice) => ipcRenderer.invoke('notify:show', notice),
  /**
   * Our own title bar (Windows, Linux): `windowFrame` is 'overlay' (Windows:
   * the OS draws the buttons) or 'custom' (Linux: the page does).
   * `windowControl`: 'minimize' | 'toggle-maximize' | 'close' |
   * 'theme:light' | 'theme:dark' (Windows overlay colours). Resolves true if
   * done. `window.state` { maximized, fullScreen } and `window.closeRequest`
   * (a close during a call: ask, then 'close') arrive as events.
   */
  ...(process.platform === 'win32' || process.platform === 'linux'
    ? { windowFrame: process.platform === 'win32' ? 'overlay' : 'custom', windowControl: (action) => ipcRenderer.invoke('window:control', String(action)) }
    : {}),
  /**
   * G-74: push-to-talk settings { key, globalMute }. `key` is a
   * KeyboardEvent.code (or null): while it's held in our focused window during
   * a call, `ptt.down` then `ptt.up` (200 ms after release or focus loss)
   * arrive as events. `globalMute` is an accelerator with two or three
   * modifiers, e.g. 'CommandOrControl+Shift+M', or F13-F24 (or null): it is
   * registered only during a call, and pressing it anywhere sends
   * `ptt.toggleMute`. Resolves 'ok' | 'invalid' | 'shortcut-taken'.
   */
  setPushToTalk: (settings) => ipcRenderer.invoke('ptt:set', settings),
  /**
   * G-62: the unread total for the taskbar (Windows overlay) or dock: a whole
   * number 0..9999; 0 clears it. Resolves true if accepted.
   */
  setUnreadCount: (count) => ipcRenderer.invoke('badge:set', count),
  /**
   * G-78: the app lock. `state()` -> { enabled, locked, pending, path:
   * 'A'|'B'|null, inCall, retryAfter? } (also the `lock.state` event).
   * `unlock({ passcode })` or `unlock({ words })` (forgot) -> 'ok' | 'wrong'
   * | 'rate-limited' | 'invalid'. `now()` locks (true if the lock is on).
   */
  lock: Object.freeze({
    state: () => ipcRenderer.invoke('lock:state'),
    unlock: (input) => ipcRenderer.invoke('lock:unlock', input),
    now: () => ipcRenderer.invoke('lock:now'),
  }),
  /** Opens the shell's logs folder (no words, no message content). Resolves true if it did. */
  openLogsFolder: () => ipcRenderer.invoke('logs:open'),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    listeners.add(callback);
    for (const [name, payload] of pending) setTimeout(() => callback(name, payload), 0);
    pending.clear();
    return () => listeners.delete(callback);
  },
});
