// The React side of the voice engine, in the shape the call bar (piece E,
// ui/src/screens/shell/CallBar.tsx) agreed on. The app store joins and
// leaves through the core; this hook starts and stops the audio to match.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCore } from '../core';
import type { CallState, Id } from '../core/types';
import { fromCoreApi } from './adapter';
import {
  createVoiceEngine,
  type AudioDevice,
  type VoiceEngine,
  type VoiceDiagnostics,
  type VoiceEngineOptions,
  type VoiceError,
  type VoiceParticipant,
} from './engine';
import { DEVICES_EVENT, loadDevices, saveDevices } from './devices';

export interface VoiceEngineView {
  ready: boolean;
  /** `rejoin-to-talk`: the call started without a mic; a new device needs a rejoin. */
  error?: 'mic-denied' | 'no-device' | 'failed' | 'rejoin-to-talk';
  speaking: Record<Id, boolean>;
  /**
   * People in the call I have no voice connection with, and why:
   * - `failed`: the engine gave up connecting (peer-failed);
   * - `refused`: a security check failed (fingerprint-mismatch,
   *   unverified-signal); not retried during this call.
   * Cleared when that person connects again, and when the call ends.
   */
  peerFailed: Record<Id, PeerFailure>;
  setMicMuted: (muted: boolean) => void;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  inputId?: string;
  outputId?: string;
  setInput: (id: string) => void;
  setOutput: (id: string) => void;
  /** G-72 mic test: my microphone's level now, 0..1. */
  inputLevel: () => number;
  /** G-84: I hear no one. Back to false when the call ends. */
  deafened: boolean;
  setDeafened: (deafened: boolean) => void;
  /**
   * G-73: per-person volume in percent (0..200), remembered on this computer;
   * 100 when not set. Above 100 needs the engine's Web Audio path; on its
   * element fallback it plays at 100.
   */
  volumes: Record<Id, number>;
  setVolume: (id: Id, percent: number) => void;
  /** G-72: the last chosen device that was gone; its label if known. Shown once as a notice. */
  deviceFallback: { kind: 'input' | 'output'; label: string | null; at: number } | null;
  /** G-72: "השמעה עצמית": my microphone played back to me. Off by default and when the call ends. */
  selfMonitor: boolean;
  setSelfMonitor: (on: boolean) => void;
  /** G-81: connection diagnostics (types and timings, never addresses); null outside a call. */
  diagnostics?: () => Promise<VoiceDiagnostics | null>;
}

export { loadDevices } from './devices';

/** G-73: per-person volumes, kept on this computer only. */
const VOLUMES_KEY = 'mvs.voice.volumes.v1';
const MAX_VOLUMES = 500;

/** The stored volumes, keeping only 64-hex IDs with a whole percent in 0..100. */
export function loadVolumes(): Record<Id, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VOLUMES_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<Id, number> = {};
    for (const [id, v] of Object.entries(raw).slice(0, MAX_VOLUMES)) {
      if (/^[0-9a-f]{64}$/.test(id) && Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 200) out[id] = v as number;
    }
    return out;
  } catch {
    return {};
  }
}

function saveVolumes(v: Record<Id, number>): void {
  try {
    localStorage.setItem(VOLUMES_KEY, JSON.stringify(v));
  } catch {
    // Not remembered; it still applies to this call.
  }
}

export type PeerFailure = 'failed' | 'refused';

/** The next peerFailed map after an engine event. Pure, for tests. */
export function nextPeerFailed(
  prev: Record<Id, PeerFailure>,
  event: { error: VoiceError } | { participants: VoiceParticipant[] },
): Record<Id, PeerFailure> {
  if ('error' in event) {
    const { peer, code } = event.error;
    const reason: PeerFailure | null =
      code === 'peer-failed' ? 'failed' : code === 'fingerprint-mismatch' || code === 'unverified-signal' ? 'refused' : null;
    // A refusal is never downgraded to a plain failure.
    if (!peer || !reason || prev[peer] === reason || prev[peer] === 'refused') return prev;
    return { ...prev, [peer]: reason };
  }
  const ids = Object.keys(prev);
  if (!event.participants.length) return ids.length ? {} : prev;
  const connected = new Set(event.participants.filter((p) => p.state === 'connected').map((p) => p.identity));
  if (!ids.some((id) => connected.has(id))) return prev;
  return Object.fromEntries(Object.entries(prev).filter(([id]) => !connected.has(id)));
}

/**
 * `call` is the store's current call (null outside one), `myId` my identity.
 * `options.stunUrl` is the config's STUN URL from the desktop shell (piece C);
 * without it, only host candidates are used. `options.enableTurn` (off by
 * default) and `options.turnHost` (the configured relay host) turn on TURN
 * credentials from the core (G-81).
 */
export function useVoiceEngine(call: CallState | null, myId: Id, options: Pick<VoiceEngineOptions, 'stunUrl' | 'enableTurn' | 'turnHost' | 'relayOnly'> = {}): VoiceEngineView {
  const core = useCore();
  const engineRef = useRef<VoiceEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<VoiceEngineView['error']>();
  const [speaking, setSpeaking] = useState<Record<Id, boolean>>({});
  const [peerFailed, setPeerFailed] = useState<Record<Id, PeerFailure>>({});
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [inputId, setInputId] = useState<string | undefined>(() => loadDevices().input);
  const [outputId, setOutputId] = useState<string | undefined>(() => loadDevices().output);
  const [deviceFallback, setDeviceFallback] = useState<VoiceEngineView['deviceFallback']>(null);
  const chosenRef = useRef<{ input?: string; output?: string }>({});
  const listsRef = useRef<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>({ inputs: [], outputs: [] });
  listsRef.current = { inputs, outputs };
  chosenRef.current = { input: inputId, output: outputId };
  const [deafened, setDeafenedState] = useState(false);
  const [selfMonitor, setSelfMonitorState] = useState(false);
  const [volumes, setVolumes] = useState<Record<Id, number>>(loadVolumes);
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;

  const stunUrl = options.stunUrl ?? null;
  const enableTurn = options.enableTurn === true;
  const turnHost = options.turnHost ?? null;
  const relayOnly = options.relayOnly === true;
  useEffect(() => {
    const engine = createVoiceEngine(fromCoreApi(core), { stunUrl, enableTurn, turnHost, relayOnly });
    engineRef.current = engine;
    for (const [id, pct] of Object.entries(volumesRef.current)) engine.setPeerVolume(id, pct / 100);
    // G-72: the remembered devices (a gone one falls back to the default on use).
    const saved = loadDevices();
    if (saved.input) void engine.setInputDevice(saved.input);
    if (saved.output) void engine.setOutputDevice(saved.output);
    const relist = async () => {
      const [ins, outs] = await Promise.all([engine.listInputDevices(), engine.listOutputDevices()]);
      if (engineRef.current !== engine) return;
      setInputs(ins);
      setOutputs(outs);
    };
    const offs = [
      engine.on('speaking', setSpeaking),
      engine.on('devicesChanged', () => void relist().catch(() => {})),
      engine.on('deviceFallback', ({ kind, deviceId }) => {
        const list = kind === 'input' ? listsRef.current.inputs : listsRef.current.outputs;
        const label = list.find((d) => d.deviceId === deviceId)?.label || null;
        const now = loadDevices();
        saveDevices(kind === 'input' ? { ...now, input: undefined } : { ...now, output: undefined }, false);
        if (kind === 'input') setInputId(undefined);
        else setOutputId(undefined);
        setDeviceFallback({ kind, label, at: Date.now() });
      }),
      engine.on('participants', (participants) => setPeerFailed((prev) => nextPeerFailed(prev, { participants }))),
      engine.on('error', (e) => {
        setPeerFailed((prev) => nextPeerFailed(prev, { error: e }));
        if (e.code === 'mic-denied' || e.code === 'no-device' || e.code === 'failed' || e.code === 'rejoin-to-talk') setError(e.code);
      }),
    ];
    // Settings → Voice changed the choice (also during a call): follow it.
    const follow = () => {
      const d = loadDevices();
      if (d.input !== chosenRef.current.input) {
        setInputId(d.input);
        void engine.setInputDevice(d.input ?? '').catch(() => setError('no-device'));
      }
      if (d.output !== chosenRef.current.output) {
        setOutputId(d.output);
        void engine.setOutputDevice(d.output ?? '');
      }
    };
    window.addEventListener(DEVICES_EVENT, follow);
    return () => {
      window.removeEventListener(DEVICES_EVENT, follow);
      offs.forEach((off) => off());
      engine.dispose();
      engineRef.current = null;
    };
  }, [core, stunUrl, enableTurn, turnHost, relayOnly]);

  const callKey = call && call.participants.length ? call.channelId : null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !callKey || !call) return;
    let live = true;
    setReady(false);
    setError(undefined);
    void engine.attach(call, myId).then(async () => {
      if (!live) return;
      setReady(true);
      // Device labels are only filled in after the microphone permission.
      const [ins, outs] = await Promise.all([engine.listInputDevices(), engine.listOutputDevices()]);
      if (!live) return;
      setInputs(ins);
      setOutputs(outs);
    });
    return () => {
      live = false;
      engine.setDeafened(false);
      setDeafenedState(false);
      engine.setSelfMonitor(false);
      setSelfMonitorState(false);
      engine.detach();
      setReady(false);
      setSpeaking({});
      setPeerFailed({});
    };
    // Re-attach only when the call itself changes, not on every participant update:
    // the engine follows call.state on its own.
  }, [callKey, myId, core, stunUrl, enableTurn, turnHost, relayOnly]);

  const setMicMuted = useCallback((muted: boolean) => engineRef.current?.setMicMuted(muted), []);
  const setInput = useCallback((id: string) => {
    setInputId(id || undefined);
    saveDevices({ ...loadDevices(), input: id || undefined }, false);
    void engineRef.current?.setInputDevice(id).catch(() => setError('no-device'));
  }, []);
  const setOutput = useCallback((id: string) => {
    setOutputId(id || undefined);
    saveDevices({ ...loadDevices(), output: id || undefined }, false);
    void engineRef.current?.setOutputDevice(id);
  }, []);

  const inputLevel = useCallback(() => engineRef.current?.inputLevel() ?? 0, []);
  const diagnostics = useCallback(async () => (engineRef.current ? engineRef.current.diagnostics() : null), []);
  const setVolume = useCallback((id: Id, percent: number) => {
    const pct = Math.round(Math.min(200, Math.max(0, percent)));
    engineRef.current?.setPeerVolume(id, pct / 100);
    setVolumes((prev) => {
      const next = { ...prev, [id]: pct };
      if (pct === 100) delete next[id]; // the default: nothing to remember
      saveVolumes(next);
      return next;
    });
  }, []);
  const setSelfMonitor = useCallback((on: boolean) => {
    setSelfMonitorState(on);
    engineRef.current?.setSelfMonitor(on);
  }, []);
  const setDeafened = useCallback((on: boolean) => {
    setDeafenedState(on);
    engineRef.current?.setDeafened(on);
  }, []);

  return { ready, error, speaking, peerFailed, setMicMuted, inputs, outputs, inputId, outputId, setInput, setOutput, inputLevel, deafened, setDeafened, volumes, setVolume, deviceFallback, selfMonitor, setSelfMonitor, diagnostics };
}
