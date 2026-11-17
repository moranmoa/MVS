// G-74: push-to-talk (docs/ux/specs/chat-and-voice-extras.md §6). The
// desktop shell watches the chosen key on our focused window and sends
// down / up (up already waits the 200 ms release delay, and losing focus
// counts as letting go); this hook turns that into the mic state.
//
// The call bar keeps owning the mute button: `hardMuted` is that button. In
// push-to-talk mode the mic is open only while the key is held and the
// button isn't on. In open mode this hook leaves the mic alone.

import { useEffect, useRef, useState } from 'react';
import {
  onPushToTalk,
  setPushToTalk,
  type DesktopBridge,
  type PushToTalkResult,
  type PushToTalkSignal,
} from '../core/ipc';

export type VoiceInputMode = 'open' | 'ptt';

export interface PushToTalkOptions {
  mode: VoiceInputMode;
  /** KeyboardEvent.code; push-to-talk needs one before it does anything. */
  pttKey: string | null;
  /** Optional global toggle-mute accelerator (off by default). */
  globalMute: string | null;
  inCall: boolean;
  /** The call bar's mute button. */
  hardMuted: boolean;
  /** useVoiceEngine's setMicMuted. */
  setMicMuted: (muted: boolean) => void;
  /** The global shortcut was pressed during a call: flip the mute button. */
  onToggleMute?: () => void;
  /** Tests only. */
  bridge?: DesktopBridge;
}

export interface PushToTalkView {
  /** Key held (after the release delay): show the mic as active. */
  talking: boolean;
  /** The shell's answer to the settings: 'unsupported' outside the desktop app. */
  status: PushToTalkResult | 'pending';
}

/** Whether the mic should be muted, or null when push-to-talk doesn't decide (open mode, no key). */
export function pttMicMuted(o: { mode: VoiceInputMode; pttKey: string | null; talking: boolean; hardMuted: boolean }): boolean | null {
  if (o.mode !== 'ptt' || !o.pttKey) return null;
  return o.hardMuted || !o.talking;
}

/** The next `talking` for a shell signal. */
export function nextTalking(talking: boolean, signal: PushToTalkSignal): boolean {
  if (signal === 'down') return true;
  if (signal === 'up') return false;
  return talking;
}

export function usePushToTalk(o: PushToTalkOptions): PushToTalkView {
  const { mode, pttKey, globalMute, inCall, hardMuted, setMicMuted, onToggleMute, bridge } = o;
  const [talking, setTalking] = useState(false);
  const [status, setStatus] = useState<PushToTalkView['status']>('pending');
  const toggleRef = useRef(onToggleMute);
  toggleRef.current = onToggleMute;

  // The settings go to the shell; the key only counts in push-to-talk mode.
  const key = mode === 'ptt' ? pttKey : null;
  useEffect(() => {
    let live = true;
    void setPushToTalk({ key, globalMute }, bridge).then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [key, globalMute, bridge]);
  // Unmounted (signed out, app closing): nothing stays registered.
  useEffect(() => () => void setPushToTalk({ key: null, globalMute: null }, bridge), [bridge]);

  useEffect(
    () =>
      onPushToTalk((signal) => {
        if (signal === 'toggleMute') toggleRef.current?.();
        else setTalking((t) => nextTalking(t, signal));
      }, bridge),
    [bridge],
  );

  // Out of a call, or the key changed: not talking.
  useEffect(() => {
    if (!inCall) setTalking(false);
  }, [inCall]);
  useEffect(() => setTalking(false), [key]);

  // In push-to-talk mode the mic follows the key; leaving the mode gives the
  // mic back to the mute button.
  const muted = pttMicMuted({ mode, pttKey, talking, hardMuted });
  const wasPtt = useRef(false);
  useEffect(() => {
    if (!inCall) return;
    if (muted !== null) {
      setMicMuted(muted);
      wasPtt.current = true;
    } else if (wasPtt.current) {
      setMicMuted(hardMuted);
      wasPtt.current = false;
    }
  }, [muted, inCall, hardMuted, setMicMuted]);

  return { talking: muted !== null && talking && inCall, status };
}
