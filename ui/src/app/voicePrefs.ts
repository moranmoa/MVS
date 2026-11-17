// G-74 (chat-and-voice-extras.md §6): how I talk in calls, on this computer only.

import type { VoiceInputMode } from '../voice';

export interface VoicePrefs {
  /** "פתוח לדיבור" (voice activity) or "לחיצה לדיבור" (push to talk). */
  mode: VoiceInputMode;
  /** KeyboardEvent.code; none by default: push to talk needs one first. */
  pttKey: string | null;
  /** An Electron accelerator that toggles mute from anywhere; off by default. */
  globalMute: string | null;
}

export function defaultVoicePrefs(): VoicePrefs {
  return { mode: 'open', pttKey: null, globalMute: null };
}

const CODE = /^[A-Za-z0-9]{1,24}$/;
const ACCELERATOR = /^(?:(?:CommandOrControl|Alt|Shift)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/;

/** Stored prefs checked field by field; anything odd falls back to the default. */
export function cleanVoicePrefs(v: unknown): VoicePrefs {
  const d = defaultVoicePrefs();
  if (!v || typeof v !== 'object') return d;
  const p = v as Record<string, unknown>;
  return {
    mode: p.mode === 'ptt' ? 'ptt' : 'open',
    pttKey: typeof p.pttKey === 'string' && CODE.test(p.pttKey) ? p.pttKey : null,
    globalMute: typeof p.globalMute === 'string' && ACCELERATOR.test(p.globalMute) && (p.globalMute.split('+').length >= 3 || /F(1[3-9]|2[0-4])$/.test(p.globalMute)) ? p.globalMute : null,
  };
}

/** Keys the shell refuses for push to talk: OS keys, Escape (cancels the capture) and Enter. */
const REFUSED = /^(?:Meta|OS)(?:Left|Right)?$|^Escape$|^Enter$|^NumpadEnter$/;

/** The code to store for a pressed key, or null when it can't be the push-to-talk key. */
export function pttKeyFrom(e: { code: string }): string | null {
  return e.code && CODE.test(e.code) && !REFUSED.test(e.code) ? e.code : null;
}

/**
 * The accelerator for a pressed key, or null: two or three modifiers (Ctrl/Cmd, Alt,
 * Shift) and a letter, digit or F-key, or F13–F24 with any modifiers (#444, Security
 * Lead: one modifier would take over shortcuts like Ctrl+C or Alt+F4).
 */
export function acceleratorFrom(e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const key = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit([0-9])$/.exec(e.code)?.[1] ?? /^(F(?:[1-9]|1[0-9]|2[0-4]))$/.exec(e.code)?.[1];
  if (!key) return null;
  const mods = [e.ctrlKey || e.metaKey ? 'CommandOrControl' : null, e.altKey ? 'Alt' : null, e.shiftKey ? 'Shift' : null].filter(Boolean);
  if (mods.length < 2 && !/^F(1[3-9]|2[0-4])$/.test(key)) return null;
  return [...mods, key].join('+');
}

/** How a key code reads on screen: "V", "5", "F13", "ControlLeft" as is. */
export function keyLabel(code: string): string {
  return /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? code;
}

/** How an accelerator reads: "Ctrl+Shift+M" ("CommandOrControl" shortened). */
export function acceleratorLabel(acc: string): string {
  return acc.replace('CommandOrControl', 'Ctrl');
}
