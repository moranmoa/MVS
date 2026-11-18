// CoreApi over the desktop shell's bridge (desktop/src/preload.js): every
// command becomes `window.mvs.invoke(name, args)`, and core events arrive
// through `window.mvs.onEvent`. The shell's main process checks the command
// against its allow-list and forwards it to the core process.
//
// createCore() (index.ts) should use this when `hasDesktopBridge()` is true and
// wrap it in guardCore() like any other core: what comes back is other
// people's data and is cleaned the same way.

import type { CoreApi, CoreEventName, CoreEvents, Unsubscribe } from './api';
import type { CoreError } from './types';

/** What desktop/src/preload.js exposes as `window.mvs`. */
export interface DesktopBridge {
  /** Missing in the checkout demo (T8-04): the UI runs on its mock then. */
  invoke(cmd: string, args: unknown[]): Promise<{ ok?: unknown; error?: CoreError | { code: string } }>;
  onEvent(callback: (event: string, payload: unknown) => void): () => void;
  /** G-62: the unread total for the taskbar / dock (desktop only). */
  setUnreadCount?(count: number): Promise<boolean>;
  /** G-74: push-to-talk settings (desktop only). */
  setPushToTalk?(settings: PushToTalkSettings): Promise<PushToTalkResult>;
  /** G-78: the app lock (desktop only). Main owns it; see docs/design/app-lock.md. */
  lock?: LockBridge;
  /** Read-only: the OS the desktop app runs on. */
  platform?: string;
}

/** G-78: what main says about the lock (also the `lock.state` event). */
export interface LockState {
  enabled: boolean;
  locked: boolean;
  /** At start, until the core answers: show "Loading…". */
  pending: boolean;
  /** A: not in a call (the page is reloaded into ?locked). B: in a call (overlay, no reload). */
  path: 'A' | 'B' | null;
  inCall?: boolean;
  /** Seconds until another attempt is allowed. */
  retryAfter?: number;
}

/** G-78: the lock settings (never the verifier or the attempt state). */
export interface LockConfig {
  enabled: boolean;
  idleMinutes: number;
  lockOnSleep: boolean;
  method: 'passcode' | 'os';
}

export type UnlockResult = 'ok' | 'wrong' | 'rate-limited' | 'invalid';
export interface LockChangeResult {
  result: 'ok' | 'wrong' | 'rate-limited' | 'invalid' | 'busy' | 'locked';
  retryAfter?: number;
}

interface LockBridge {
  state(): Promise<unknown>;
  unlock(input: { passcode: string } | { words: string }): Promise<unknown>;
  now(): Promise<unknown>;
  config?(): Promise<unknown>;
  set?(input: { current?: string; passcode: string; idleMinutes: number; lockOnSleep: boolean }): Promise<unknown>;
  clear?(input: { current: string }): Promise<unknown>;
}

const bridgeNow = (): DesktopBridge | undefined => (typeof window === 'undefined' ? undefined : window.mvs);
const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.ceil(v), 24 * 3600) : undefined);

/** G-78: the lock's state as main has it; null outside the desktop app (no lock). */
export function cleanLockState(v: unknown): LockState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.locked !== 'boolean' || typeof o.pending !== 'boolean') return null;
  const retryAfter = seconds(o.retryAfter);
  return {
    enabled: o.enabled === true,
    locked: o.locked,
    pending: o.pending,
    path: o.path === 'A' || o.path === 'B' ? o.path : null,
    inCall: o.inCall === true,
    ...(retryAfter ? { retryAfter } : {}),
  };
}

export async function getLockState(bridge = bridgeNow()): Promise<LockState | null> {
  if (typeof bridge?.lock?.state !== 'function') return null;
  try {
    return cleanLockState(await bridge.lock.state());
  } catch {
    return null;
  }
}

/** Calls back with every `lock.state` from main. Returns an unsubscribe. */
export function onLockState(callback: (state: LockState) => void, bridge = bridgeNow()): () => void {
  if (typeof bridge?.onEvent !== 'function') return () => {};
  return bridge.onEvent((event, payload) => {
    if (event !== 'lock.state') return;
    const st = cleanLockState(payload);
    if (st) callback(st);
  });
}

export async function unlockApp(input: { passcode: string } | { words: string }, bridge = bridgeNow()): Promise<UnlockResult> {
  if (typeof bridge?.lock?.unlock !== 'function') return 'invalid';
  try {
    const r = await bridge.lock.unlock(input);
    return r === 'ok' || r === 'wrong' || r === 'rate-limited' ? r : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** "Lock now" (menu, Ctrl+L). True if the lock is on and it locked. */
export async function lockNow(bridge = bridgeNow()): Promise<boolean> {
  if (typeof bridge?.lock?.now !== 'function') return false;
  try {
    return (await bridge.lock.now()) === true;
  } catch {
    return false;
  }
}

/** The lock settings, or null outside the desktop app / while locked. */
export async function getLockConfig(bridge = bridgeNow()): Promise<LockConfig | null> {
  if (typeof bridge?.lock?.config !== 'function') return null;
  try {
    const v = (await bridge.lock.config()) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || typeof v.enabled !== 'boolean') return null;
    const idle = v.idleMinutes;
    return {
      enabled: v.enabled,
      idleMinutes: typeof idle === 'number' && Number.isInteger(idle) && idle >= 1 && idle <= 60 ? idle : 5,
      lockOnSleep: v.lockOnSleep !== false,
      method: v.method === 'os' ? 'os' : 'passcode',
    };
  } catch {
    return null;
  }
}

function cleanChange(v: unknown): LockChangeResult {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const ok = ['ok', 'wrong', 'rate-limited', 'invalid', 'busy', 'locked'] as const;
  const result = ok.find((r) => r === o.result) ?? 'invalid';
  const retryAfter = seconds(o.retryAfter);
  return { result, ...(retryAfter ? { retryAfter } : {}) };
}

/** Turn the lock on or change it. `current` is the passcode the user typed (required once a lock is set). */
export async function setAppLock(
  input: { current?: string; passcode: string; idleMinutes: number; lockOnSleep: boolean },
  bridge = bridgeNow(),
): Promise<LockChangeResult> {
  if (typeof bridge?.lock?.set !== 'function') return { result: 'invalid' };
  try {
    return cleanChange(await bridge.lock.set(input));
  } catch {
    return { result: 'invalid' };
  }
}

/** Turn the lock off with the current passcode. */
export async function clearAppLock(current: string, bridge = bridgeNow()): Promise<LockChangeResult> {
  if (typeof bridge?.lock?.clear !== 'function') return { result: 'invalid' };
  try {
    return cleanChange(await bridge.lock.clear({ current }));
  } catch {
    return { result: 'invalid' };
  }
}

/** The OS the desktop app runs on, or null in a browser. */
export function desktopPlatform(bridge = bridgeNow()): 'win32' | 'linux' | 'darwin' | null {
  const p = bridge?.platform;
  return p === 'win32' || p === 'linux' || p === 'darwin' ? p : null;
}

/**
 * G-74: `key` is a KeyboardEvent.code (e.g. 'KeyV', 'ControlLeft', 'F13') or
 * null; `globalMute` an Electron accelerator with two or three modifiers
 * (e.g. 'CommandOrControl+Shift+M', 'Control+Alt+0'), or F13–F24 with any, or
 * null. One-modifier shortcuts (Ctrl+C, Alt+F4…) are refused.
 */
export interface PushToTalkSettings {
  key: string | null;
  globalMute: string | null;
}
/** `shortcut-taken`: the key is set, but another app holds the global shortcut. */
export type PushToTalkResult = 'ok' | 'invalid' | 'shortcut-taken' | 'unsupported';
/** What the shell sends: talk (key held), stop (200 ms after release or focus loss), toggleMute (global shortcut). */
export type PushToTalkSignal = 'down' | 'up' | 'toggleMute';

/** G-74: hands the push-to-talk settings to the shell; 'unsupported' outside the desktop app. */
export async function setPushToTalk(
  settings: PushToTalkSettings,
  bridge: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.mvs,
): Promise<PushToTalkResult> {
  if (typeof bridge?.setPushToTalk !== 'function') return 'unsupported';
  try {
    const res = await bridge.setPushToTalk(settings);
    return res === 'ok' || res === 'shortcut-taken' ? res : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** G-74: calls back with the shell's push-to-talk signals. Returns an unsubscribe (a no-op outside the desktop app). */
export function onPushToTalk(
  callback: (signal: PushToTalkSignal) => void,
  bridge: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.mvs,
): () => void {
  if (typeof bridge?.onEvent !== 'function') return () => {};
  return bridge.onEvent((event) => {
    if (event === 'ptt.down') callback('down');
    else if (event === 'ptt.up') callback('up');
    else if (event === 'ptt.toggleMute') callback('toggleMute');
  });
}

declare global {
  interface Window {
    mvs?: DesktopBridge;
  }
}

export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.mvs?.invoke === 'function';
}

/**
 * G-62: shows `count` unread on the taskbar (Windows overlay) or dock. A whole
 * number 0..9999; 0 clears it. Resolves false outside the desktop app or when
 * the shell refuses the value, so callers need no guard.
 */
export async function setUnreadCount(count: number, bridge: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.mvs): Promise<boolean> {
  if (typeof bridge?.setUnreadCount !== 'function') return false;
  try {
    return (await bridge.setUnreadCount(count)) === true;
  } catch {
    return false;
  }
}

/**
 * Errors the shell adds to the core's own codes: `timeout` (the core did not
 * answer in time; show "busy"), `core-unavailable`, `core-restarted`,
 * `too-large`, `bad-request`.
 */
export function createIpcCore(bridge: DesktopBridge = window.mvs as DesktopBridge): CoreApi {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  // An mvs:// link (`link.open`) can arrive before anything listens for it:
  // on the first launch, or during onboarding before the shell is mounted.
  // The latest one waits for the first listener.
  let pendingLink: unknown = null;
  // core.status (T8-01) is a state, not a one-off: the latest one is kept and
  // given to every new listener, so a screen mounted late still knows it.
  let lastStatus: unknown = null;
  bridge.onEvent((event, payload) => {
    if (event === 'core.status') lastStatus = payload;
    const set = handlers.get(event);
    if (event === 'link.open' && !set?.size) {
      pendingLink = payload;
      return;
    }
    set?.forEach((h) => h(payload as never));
  });

  const on = <E extends CoreEventName>(event: E, handler: (payload: CoreEvents[E]) => void): Unsubscribe => {
    let set = handlers.get(event);
    if (!set) handlers.set(event, (set = new Set()));
    set.add(handler as (payload: never) => void);
    if ((event as string) === 'link.open' && pendingLink !== null) {
      const p = pendingLink;
      pendingLink = null;
      setTimeout(() => (handler as (payload: unknown) => void)(p), 0);
    }
    if ((event as string) === 'core.status' && lastStatus !== null) {
      const p = lastStatus;
      setTimeout(() => {
        // Only if it is still the latest and the listener is still there.
        if (p === lastStatus && set.has(handler as (payload: never) => void)) (handler as (payload: unknown) => void)(p);
      }, 0);
    }
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  };

  const call =
    (cmd: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      const res = await bridge.invoke(cmd, args);
      if (res && res.error) throw res.error;
      return res?.ok ?? null;
    };

  return new Proxy({ on } as CoreApi, {
    get(target, prop) {
      if (prop === 'on') return target.on;
      // Not a thenable, so `await core` does not call the bridge.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return call(prop);
    },
  });
}
