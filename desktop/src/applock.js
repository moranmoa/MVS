// G-78: the app lock, main's side (docs/design/app-lock.md). Pure state and
// rules; main.js wires it to Electron (powerMonitor, the window, IPC).
//
// Main owns the lock, not the page:
// - path A (not in a call): the page is reloaded into ?locked, and only
//   getAppInfo reaches the core;
// - path B (in a call): no reload (the voice engine lives in the page); the
//   page unmounts its content behind an inert overlay, the mic is forced
//   off, and only what the call needs passes;
// - pending (at start, until the core says whether the lock is on): gated
//   like A, the lock screen after 10 s without an answer (fail closed).
// The passcode is checked by the core (Argon2id, attempt counter); main only
// shapes it and never keeps or logs it.
'use strict';

const START_TIMEOUT_MS = 10_000;
const PASSCODE_MIN = 4;
const PASSCODE_MAX = 64;
const WORDS_MAX = 1024;

/** The passcode as the core gets it (NFC), or null if it can't be one. */
function cleanPasscode(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC');
  const len = [...s].length;
  return len >= PASSCODE_MIN && len <= PASSCODE_MAX ? s : null;
}

/** "Forgot": the 12 words as typed, bounded; the core checks them. */
function cleanWords(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').trim();
  return s.length > 0 && s.length <= WORDS_MAX ? s : null;
}

/**
 * The core's answers to getAppLock that can mean "this core has no app lock"
 * (unknown or not-yet command), as opposed to "no answer" (down, timeout).
 * They count as "off" only from a core older than LOCK_SINCE; from any other
 * core they are a fault, and the lock stays on (fail closed).
 */
const NO_LOCK_SUPPORT = new Set(['bad-request', 'not-implemented']);
/** The first core with getAppLock (#476): the release after 0.4.7. */
const LOCK_SINCE = [0, 4, 8];

/**
 * Is this getAppInfo version older than LOCK_SINCE? Only a plain
 * "x.y.z[-pre][+build]" counts; anything else is false (not provably old).
 * A pre-release of 0.4.8 counts as 0.4.8: it's cut after the lock landed.
 */
function predatesLock(version) {
  if (typeof version !== 'string' || version.length > 64) return false;
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.+-]*)?$/.exec(version);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i] !== LOCK_SINCE[i]) return v[i] < LOCK_SINCE[i];
  }
  return false;
}

/** Core events the page still gets: A (and pending) vs B (in a call). */
const EVENTS_A = new Set(['core.status', 'lock.state']);
const EVENTS_B = new Set(['core.status', 'lock.state', 'call.signal', 'call.state']);

/**
 * The lock. `request(cmd, args)` asks the core and resolves with
 * { ok } | { error }. `inCall()` is the call gate. `onChange(state)` gets
 * every change of { enabled, locked, pending, path, retryAfter? }; main
 * reloads / tells the page from it.
 */
function createAppLock({ request, inCall, onChange, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let enabled = true; // fail closed until the core answers
  let pending = true;
  let locked = true;
  let path = 'A';
  let idleMinutes = 5;
  let lockOnSleep = true;
  let retryAfter = null;
  let startTimer = null;
  /** The core gave a definite answer about the lock (config, or "no such command"). */
  let answered = false;

  const state = () => ({ enabled, locked, pending, path: locked ? path : null, ...(retryAfter ? { retryAfter } : {}) });
  const changed = () => onChange(state());

  let method = 'passcode';
  /** A lock:set / lock:clear is with the core (Argon2): one at a time. */
  let changing = false;

  function applyConfig(cfg) {
    enabled = cfg.enabled === true;
    if (Number.isInteger(cfg.idleMinutes) && cfg.idleMinutes >= 1 && cfg.idleMinutes <= 60) idleMinutes = cfg.idleMinutes;
    lockOnSleep = cfg.lockOnSleep !== false;
    method = cfg.method === 'os' ? 'os' : 'passcode';
    // A delay the core is still running (it survives a restart).
    if (Number.isFinite(cfg.retryAfter) && cfg.retryAfter > 0) retryAfter = Math.ceil(cfg.retryAfter);
  }

  /** The core's AppLockAnswer as main hands it on: { result, retryAfter? }. */
  function answerOf(res) {
    const r = res && res.ok;
    const result = r && ['ok', 'wrong', 'rate-limited'].includes(r.result) ? r.result : 'invalid';
    const after = r && Number.isFinite(r.retryAfter) && r.retryAfter > 0 ? Math.ceil(r.retryAfter) : null;
    return { result, ...(after ? { retryAfter: after } : {}) };
  }

  /** One change at a time, and only while unlocked; refresh after an ok. */
  async function change(run) {
    if (locked || pending) return { result: 'locked' };
    if (changing) return { result: 'busy' };
    changing = true;
    try {
      const answer = answerOf(await run().catch(() => null));
      if (answer.result === 'ok') await lockApi.refresh();
      return answer;
    } finally {
      changing = false;
    }
  }

  const lockApi = {
    get state() {
      return state();
    },
    /** The settings for the page (unlocked only): never the verifier or the attempt state. */
    config() {
      if (locked || pending) return null;
      return { enabled, idleMinutes, lockOnSleep, method };
    },
    /**
     * Turn the lock on or change it: { current?, passcode, idleMinutes,
     * lockOnSleep }. `current` is what the user typed (the core requires it
     * once a lock is set and counts a wrong one); main never fills it in.
     * → { result: 'ok'|'wrong'|'rate-limited'|'invalid'|'busy'|'locked', retryAfter? }
     */
    async set(input) {
      if (locked || pending) return { result: 'locked' };
      const args = cleanSetInput(input);
      if (!args) return { result: 'invalid' };
      return change(() => request('setAppLock', args));
    },
    /** Turn the lock off: { current } (checked by the core, same counter). */
    async clear(input) {
      if (locked || pending) return { result: 'locked' };
      const current = input && typeof input === 'object' ? cleanPasscode(input.current) : null;
      if (!current) return { result: 'invalid' };
      return change(() => request('clearAppLock', { current }));
    },
    /** At start: ask the core; locked (path A) until it says the lock is off. */
    async start() {
      startTimer = setTimer(() => {
        if (!pending) return;
        pending = false; // no answer: the lock screen (fail closed)
        changed();
      }, START_TIMEOUT_MS);
      const ask = async (cmd) => {
        try {
          return await request(cmd, {});
        } catch {
          return null;
        }
      };
      const res = await ask('getAppLock');
      // "No such command" is "off" only from a core that predates the lock;
      // the core says its version (getAppInfo). Unknown version: stays on.
      let old = false;
      if (res && res.error && NO_LOCK_SUPPORT.has(res.error.code)) {
        const info = await ask('getAppInfo');
        old = !!(info && info.ok && predatesLock(info.ok.version));
      }
      // A late answer (after the timeout) still counts: if the lock is
      // off, nobody is kept out; if it's on, the lock screen stays.
      clearTimer(startTimer);
      pending = false;
      if (res && res.ok && typeof res.ok === 'object') {
        answered = true;
        applyConfig(res.ok);
        if (!enabled) locked = false;
      } else if (old) {
        // A core from before G-78 can't have a lock set: a definite "off".
        answered = true;
        enabled = false;
        locked = false;
      }
      // Anything else (down, timeout, a lock-era core refusing): locked.
      changed();
    },
    /** The core came up: ask again if it never gave a definite answer (fail closed until then). */
    async coreUp() {
      if (answered || !locked) return;
      await this.start();
    },
    /** Lock now (menu, shortcut, idle, sleep). Returns false if the lock is off. */
    lock() {
      if (!enabled || pending) return false;
      if (locked) return true;
      locked = true;
      path = inCall() ? 'B' : 'A';
      changed();
      return true;
    },
    /** Every few seconds with the system idle time (seconds). Never during a call. */
    idleTick(idleSeconds) {
      if (!enabled || locked || pending || inCall()) return false;
      if (idleSeconds < idleMinutes * 60) return false;
      return this.lock();
    },
    /** The OS locked the screen or is going to sleep. */
    onSleep() {
      return lockOnSleep ? this.lock() : false;
    },
    /** The call ended: a path B lock becomes path A (reload, content gone). */
    callEnded() {
      if (!locked || path !== 'B') return;
      path = 'A';
      changed();
    },
    /**
     * Unlock with { passcode } or { words } (forgot: clears the lock).
     * 'ok' | 'wrong' | 'rate-limited' | 'invalid'.
     */
    async unlock(input) {
      if (!locked || pending) return 'invalid';
      if (!input || typeof input !== 'object') return 'invalid';
      let res;
      if (input.passcode !== undefined) {
        const passcode = cleanPasscode(input.passcode);
        if (!passcode) return 'invalid';
        res = await request('verifyAppLock', { passcode });
      } else if (input.words !== undefined) {
        const words = cleanWords(input.words);
        if (!words) return 'invalid';
        res = await request('clearAppLockWithWords', { words });
      } else {
        return 'invalid';
      }
      const r = res && res.ok;
      if (r && r.result === 'ok') {
        retryAfter = null;
        locked = false;
        if (input.words !== undefined) enabled = false;
        changed();
        return 'ok';
      }
      const after = r && Number.isFinite(r.retryAfter) ? r.retryAfter : null;
      retryAfter = after;
      changed();
      if (r && r.result === 'rate-limited') return 'rate-limited';
      if (r && r.result === 'wrong') return 'wrong';
      return 'invalid';
    },
    /** The page changed the lock settings (unlocked): re-read them. */
    async refresh() {
      const res = await request('getAppLock', {}).catch(() => null);
      if (res && res.ok && typeof res.ok === 'object') applyConfig(res.ok);
      changed();
    },
    /** May the page send this core command now? (`args` as named by toRequest.) */
    allows(cmd, args) {
      if (!locked && !pending) return true;
      if (cmd === 'getAppInfo') return true;
      if (pending || path === 'A') return false;
      // Path B: only what the call needs.
      if (cmd === 'leaveCall') return true;
      if (cmd === 'setMuted') return !!args && Object.keys(args).length === 1 && args.muted === true;
      if (cmd === 'sendSignal') return inCall();
      return false;
    },
    /** May this core event reach the page now? */
    forwards(name) {
      if (!locked && !pending) return true;
      return (pending || path === 'A' ? EVENTS_A : EVENTS_B).has(name);
    },
  };
  return lockApi;
}

/**
 * lock:set's input, checked before the core sees it: the passcodes shaped
 * like an attempt (the core applies the new-passcode rules), idleMinutes a
 * whole 1–60, lockOnSleep a boolean, nothing else. Null if anything is off.
 */
function cleanSetInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const known = new Set(['current', 'passcode', 'idleMinutes', 'lockOnSleep']);
  if (Object.keys(input).some((k) => !known.has(k))) return null;
  const passcode = cleanPasscode(input.passcode);
  if (!passcode) return null;
  let current;
  if (input.current !== undefined) {
    current = cleanPasscode(input.current);
    if (!current) return null;
  }
  const { idleMinutes, lockOnSleep } = input;
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 60) return null;
  if (typeof lockOnSleep !== 'boolean') return null;
  return { ...(current ? { current } : {}), passcode, method: 'passcode', idleMinutes, lockOnSleep };
}

module.exports = { createAppLock, cleanPasscode, cleanWords, cleanSetInput, predatesLock, START_TIMEOUT_MS };
