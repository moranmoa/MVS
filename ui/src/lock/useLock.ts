// G-78: the app lock as the page sees it. Main owns the lock
// (desktop/src/applock.js, docs/design/app-lock.md); the page only shows it.
import { useEffect, useState } from 'react';
import { getLockState, onLockState, type LockState } from '../core/ipc';

/** Which lock screen the URL asks for: main reloads the page into these (path A). */
export function lockScreenFromUrl(search = typeof location !== 'undefined' ? location.search : ''): 'locked' | 'pending' | null {
  const v = new URLSearchParams(search).get('locked');
  if (v === null) return null;
  return v === 'pending' ? 'pending' : 'locked';
}

/** The lock state, kept current from main's `lock.state`; null outside the desktop app. */
export function useLockState(): LockState | null {
  const [state, setState] = useState<LockState | null>(null);
  useEffect(() => {
    let live = true;
    const off = onLockState((s) => live && setState(s));
    void getLockState().then((s) => live && s && setState((cur) => cur ?? s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** "1:30" or "45": whole seconds, minutes when a minute or more. */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return String(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Seconds left until `until` (ms timestamp), updated once a second; 0 when past or null. */
export function useCountdown(until: number | null): number {
  const calc = () => (until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0);
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    if (!until) return;
    const t = setInterval(() => {
      const s = calc();
      setLeft(s);
      if (s === 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return left;
}

/** The end of the current wait (ms timestamp), from every lock state that carries retryAfter. */
export function useWaitUntil(lock: LockState | null): number | null {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    setUntil(lock?.retryAfter ? Date.now() + lock.retryAfter * 1000 : null);
  }, [lock]);
  return until;
}

/** A one-off notice for after a reload (e.g. "the lock is off" after the 12 words). */
const NOTICE_KEY = 'mvs.lock.notice';
export function leaveNotice(id: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, id);
  } catch {
    // no storage: no notice
  }
}
export function takeNotice(): string | null {
  try {
    const v = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return v === 'lock.words.done' ? v : null;
  } catch {
    return null;
  }
}
