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
  invoke(cmd: string, args: unknown[]): Promise<{ ok?: unknown; error?: CoreError | { code: string } }>;
  onEvent(callback: (event: string, payload: unknown) => void): () => void;
  /** G-62: the unread total for the taskbar / dock (desktop only). */
  setUnreadCount?(count: number): Promise<boolean>;
  /** G-74: push-to-talk settings (desktop only). */
  setPushToTalk?(settings: PushToTalkSettings): Promise<PushToTalkResult>;
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
