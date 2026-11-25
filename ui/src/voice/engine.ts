// Voice v1, piece D (#223): the WebRTC mesh engine. Ported from the spike's
// browser client (spikes/voice/web/voice.js, PR #59).
//
// - One RTCPeerConnection per other participant (the core caps a call at 5),
//   Opus audio only, with echo cancellation, noise suppression and AGC on.
// - Signalling goes through the core (`sendSignal` / `call.signal`), which
//   signs every envelope with the identity key; the SDP is sent whole, with
//   its candidates (no trickle), as in the spike.
// - Glare: of two participants, the one with the lower identity offers; an
//   offer from the higher one is ignored.
// - Fail closed:
//   - a `call.signal` without `fingerprintVerified` is never used, and the
//     connection to that peer is dropped;
//   - the remote SDP must name exactly one DTLS fingerprint, and what the
//     connection applied must equal the verified one;
//   - once connected, the certificate the peer actually presented (getStats)
//     must match it too;
//   - only then is the peer's audio played.
//   A peer dropped for any of these is not retried until the call ends.
// - Lost offers: the offerer re-offers (a fresh connection) when the peer is
//   not connected within `answerTimeoutMs`, doubling it each time, up to
//   OFFER_ATTEMPTS offers; then the peer is dropped as `peer-failed`. This
//   covers a newcomer whose engine wasn't attached yet when the first offer
//   came. The answerer drops a connection still not up after
//   `connectTimeoutMs` (`peer-failed`); the offerer's next offer starts over.
// - ICE servers come from the config's optional STUN URL only (`stunUrl`),
//   never a public default; plus, behind `enableTurn` (G-81), TURN
//   credentials from the core, cleaned (exact relay host, allowed ports) and
//   never logged. They are fetched before the first connection (at most
//   `turnFetchTimeoutMs`, then the call goes on without), cached until 80% of
//   their ttl, and refreshed then: every connection gets the new servers
//   (setConfiguration) and the offerer restarts ICE on the same connection.
//   See docs/design/voice-across-networks.md.
// - Speaking: an AnalyserNode per stream, sampled 10 times a second through
//   the G-82 state machine (speaking.ts: 150 ms to turn on, 400 ms to turn off).

import type { CallSignal, CallState, Id } from '../core/types';
import type { VoiceCore } from './adapter';
import { cleanStunUrl, cleanTurnCredentials, iceServersFor, normalizeFingerprint, soleFingerprint, type TurnCredentials } from './sdp';
import { quiet, rms, stepSpeaking, type SpeakState } from './speaking';
import { LOOPBACK_CONFIG, loopbackPlayout, type LoopbackPlayout } from './media/loopback';

export type PeerConnectionState = 'connecting' | 'connected' | 'failed';

export interface VoiceParticipant {
  identity: Id;
  /** Me: whether the microphone works. Others: the WebRTC link. */
  state: PeerConnectionState;
}

export type VoiceErrorCode =
  | 'mic-denied'
  | 'no-device'
  | 'failed'
  | 'unverified-signal'
  | 'fingerprint-mismatch'
  | 'peer-failed'
  /** The call started without a microphone; sending needs a rejoin. */
  | 'rejoin-to-talk'
  /**
   * G-81: a STUN server is configured but gathering found no public address
   * (srflx): UDP to it is blocked, or it is down. Once per call; for the
   * diagnostics and the debug log, not a user message.
   */
  | 'stun-unreachable';

/** ICE candidate types: the only thing diagnostics say about a candidate. */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export const CANDIDATE_TYPES: readonly CandidateType[] = ['host', 'srflx', 'prflx', 'relay'];

/**
 * G-81 diagnostics for one peer: states, candidate types, counts and
 * timings only. By construction there is no address, port or host name in
 * here: every string is one of a fixed set.
 */
export interface PeerDiagnostics {
  state: PeerConnectionState;
  ice: RTCIceConnectionState | 'unknown';
  /** My candidates in the last description I sent, by type; null before one. */
  gathered: Record<CandidateType, number> | null;
  /** The selected pair's types; null while there is none. */
  pair: { local: CandidateType | 'unknown'; remote: CandidateType | 'unknown' } | null;
  /** Gathering for the last description I sent, in ms. */
  gatherMs: number | null;
  /** From starting this connection to its first "connected", in ms. */
  setupMs: number | null;
}

export interface VoiceDiagnostics {
  /** A STUN server is configured (its address is never shown). */
  stun: boolean;
  /** Whether it answered (any srflx gathered); null before any gathering or without STUN. */
  stunAnswered: boolean | null;
  /** How long gathering may take before the description goes out anyway, in seconds (UX: "no answer within {s} s"). */
  gatherWindowS: number;
  peers: Record<Id, PeerDiagnostics>;
}

export interface VoiceError {
  code: VoiceErrorCode;
  /** The participant it concerns, for the per-peer codes. */
  peer?: Id;
}

export interface VoiceEvents {
  participants: VoiceParticipant[];
  /** Who is speaking now, me included, by identity. */
  speaking: Record<Id, boolean>;
  error: VoiceError;
  /** G-72: the chosen device is gone (unplugged); the system default is used instead. */
  deviceFallback: { kind: 'input' | 'output'; deviceId: string };
  /** G-72: devices were plugged in or out; lists may have changed. */
  devicesChanged: null;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
}

/** The browser APIs the engine uses; tests pass fakes. */
export interface VoiceEnv {
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;
  /**
   * One end of the in-renderer loopback pair that plays boosted audio as
   * WebRTC, so echo cancellation sees it (spike AEC run 2: 27.3 dB; plain Web
   * Audio playout couldn't be shown to be cancelled). No arguments: always
   * `iceServers: []`, never signalled, it reaches no one.
   */
  createLoopbackPeerConnection?(): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  /** null where Web Audio is missing: no speaking indicator then. */
  createAudioContext(): AudioContext | null;
  createAudioElement(): HTMLAudioElement;
  /** The Opus entries of the audio receive capabilities; null if unknown. */
  opusCodecs(): RTCRtpCodec[] | null;
  /** G-72: calls back when devices are plugged in or out; returns an unsubscribe. Optional. */
  onDeviceChange?(cb: () => void): () => void;
  /**
   * Calls back when the network changes (back online, or another interface:
   * Wi-Fi to LAN, a VPN on or off); returns an unsubscribe. Optional.
   */
  onNetworkChange?(cb: () => void): () => void;
}

export interface VoiceEngineOptions {
  /** The config's STUN URL (`stun:host:port`), if any. */
  stunUrl?: string | null;
  /** Relay-only is on: the engine never starts a call (SL S1, G-81). */
  relayOnly?: boolean;
  env?: VoiceEnv;
  /** How long to wait for ICE gathering before sending the SDP anyway. */
  gatherTimeoutMs?: number;
  /** The offerer's first wait for a connection; doubles per retry. Default 5 s. */
  answerTimeoutMs?: number;
  /** The answerer's wait for a connection. Default 30 s. */
  connectTimeoutMs?: number;
  /** G-81, off by default: use TURN credentials from the core. */
  enableTurn?: boolean;
  /** The configured relay host; TURN URLs must name exactly this host. Without it, no TURN. */
  turnHost?: string | null;
  /** The longest wait for TURN credentials before the first connection. Default 2 s. */
  turnFetchTimeoutMs?: number;
  /** RMS level above which someone counts as speaking (0..1). */
  speakingThreshold?: number;
  /** A connected call that drops (network change): how long ICE restarts may try before giving up. Default 15 s. */
  recoverTimeoutMs?: number;
  /** While recovering, the offerer sends a fresh restart offer this often. Default 5 s. */
  restartResendMs?: number;
  /** How long `disconnected` may last before a restart (it often recovers by itself). Default 2 s. */
  disconnectGraceMs?: number;
}

export interface VoiceEngine {
  /** Joins through the core, then starts the microphone and the mesh. */
  join(channelId: Id): Promise<CallState>;
  /** Stops all audio and leaves through the core. */
  leave(): Promise<void>;
  /**
   * Starts the microphone and the mesh for a call someone else joined (the
   * app store does). `me` is my identity. Resolves once the mic is settled.
   */
  attach(state: CallState, me: Id): Promise<void>;
  /** Stops all audio without telling the core (the caller left already). */
  detach(): void;
  /** Mutes the microphone and tells the core (presence). */
  setMuted(muted: boolean): Promise<void>;
  /** Mutes the microphone only; for callers that tell the core themselves. */
  setMicMuted(muted: boolean): void;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  listInputDevices(): Promise<AudioDevice[]>;
  listOutputDevices(): Promise<AudioDevice[]>;
  /** G-72 mic test: my microphone's level now, 0..1 (0 without a mic or while muted). */
  inputLevel(): number;
  /** G-84 deafen: silences everyone's audio (also people who connect later); false plays it again. */
  setDeafened(deafened: boolean): void;
  /** G-72 "השמעה עצמית": plays my microphone back to me on the chosen speaker. Off when the call ends. */
  setSelfMonitor(on: boolean): void;
  /**
   * G-73: one person's playback volume, 0..2 (clamped); kept for when they
   * connect. Above 1 needs the Web Audio path; on the element fallback it
   * plays at most 1.
   */
  setPeerVolume(id: Id, volume: number): void;
  on<E extends keyof VoiceEvents>(event: E, cb: (payload: VoiceEvents[E]) => void): () => void;
  /** Leaves the audio and unsubscribes from the core for good. */
  dispose(): void;
  /**
   * Diagnostics: per connected peer, the candidate types of the selected pair
   * (`host`, `srflx`, `prflx`, `relay`), never the addresses. null while none.
   */
  connectionTypes(): Promise<Record<Id, { local: string; remote: string } | null>>;
  /** G-81: what the diagnostics panel shows; never an address. */
  diagnostics(): Promise<VoiceDiagnostics>;
}

const MAX_PEERS = 4; // 5 in a call, me included
/** Trickled candidates accepted from one peer, in total. */
const MAX_TRICKLED_ICE = 32;
const OFFER_ATTEMPTS = 3;
const SPEAKING_POLL_MS = 100;

interface Peer {
  id: Id;
  pc: RTCPeerConnection;
  offerer: boolean;
  /** From the verified signal; null until one arrives. */
  fingerprint: string | null;
  pendingIce: RTCIceCandidateInit[];
  iceReceived: number;
  stream: MediaStream | null;
  audio: HTMLAudioElement | null;
  meter: Meter | null;
  /** G-73: this peer's gain on the Web Audio path; null on the element path. */
  gain: GainNode | null;
  state: PeerConnectionState;
  /** Media plays only after the certificate check. */
  verified: boolean;
  closed: boolean;
  /** Offerer: which offer this is (1-based). */
  attempt: number;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** A verified call that dropped: the give-up timer and the offerer's re-sends. */
  recovery: { giveUp: ReturnType<typeof setTimeout>; resend: ReturnType<typeof setInterval> | null } | null;
  /** A short wait on `disconnected` before restarting: it often comes back by itself. */
  grace: ReturnType<typeof setTimeout> | null;
  /** G-81 diagnostics: when this connection started, how long to connect, what I gathered. */
  startedAt: number;
  setupMs: number | null;
  gathered: Record<CandidateType, number> | null;
  gatherMs: number | null;
}

interface Meter {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  /** G-82: the speaking state machine (speaking.ts). */
  speak: SpeakState;
}

/** My candidates in a description, counted by type (nothing else is read from them). */
export function candidateCounts(sdp: string): Record<CandidateType, number> {
  const out: Record<CandidateType, number> = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  for (const m of sdp.matchAll(/^a=candidate:[^\r\n]* typ (host|srflx|prflx|relay)(?=[ \r\n]|$)/gm)) out[m[1] as CandidateType]++;
  return out;
}

const ICE_STATES: readonly string[] = ['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'];

/** The selected candidate pair's types, from getStats; never the addresses. */
async function selectedPair(pc: RTCPeerConnection): Promise<{ local: CandidateType | 'unknown'; remote: CandidateType | 'unknown' } | null> {
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((r: Record<string, unknown>) => byId.set(r.id as string, r));
    let pair: Record<string, unknown> | undefined;
    for (const r of byId.values()) {
      if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') pair = byId.get(r.selectedCandidatePairId);
    }
    if (!pair) {
      for (const r of byId.values()) if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    }
    const type = (id: unknown) => {
      const t = typeof id === 'string' ? byId.get(id)?.candidateType : undefined;
      return typeof t === 'string' && (CANDIDATE_TYPES as readonly string[]).includes(t) ? (t as CandidateType) : 'unknown';
    };
    return pair ? { local: type(pair.localCandidateId), remote: type(pair.remoteCandidateId) } : null;
  } catch {
    return null; // no stats
  }
}

export function browserEnv(): VoiceEnv {
  return {
    createPeerConnection: (config) => new RTCPeerConnection(config),
    createLoopbackPeerConnection: () => new RTCPeerConnection(LOOPBACK_CONFIG),
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    enumerateDevices: () => navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]),
    createAudioContext: () => (typeof AudioContext === 'function' ? new AudioContext({ latencyHint: 'interactive' }) : null),
    createAudioElement: () => new Audio(),
    onDeviceChange: (cb) => {
      const md = navigator.mediaDevices;
      if (!md?.addEventListener) return () => {};
      md.addEventListener('devicechange', cb);
      return () => md.removeEventListener('devicechange', cb);
    },
    onNetworkChange: (cb) => {
      // `online` after an outage; NetworkInformation `change` when the
      // interface or type changes (Chromium), e.g. Wi-Fi to LAN or a VPN.
      const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
      window.addEventListener('online', cb);
      conn?.addEventListener?.('change', cb);
      return () => {
        window.removeEventListener('online', cb);
        conn?.removeEventListener?.('change', cb);
      };
    },
    opusCodecs: () => {
      try {
        const caps = RTCRtpReceiver.getCapabilities?.('audio');
        return caps ? caps.codecs.filter((c) => /^audio\/opus$/i.test(c.mimeType)) : null;
      } catch {
        return null;
      }
    },
  };
}

function micError(e: unknown): VoiceErrorCode {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  return 'failed';
}

export function createVoiceEngine(core: VoiceCore, options: VoiceEngineOptions = {}): VoiceEngine {
  const env = options.env ?? browserEnv();
  const gatherTimeoutMs = options.gatherTimeoutMs ?? 3000;
  const threshold = options.speakingThreshold ?? 0.02;
  const answerTimeoutMs = options.answerTimeoutMs ?? 5000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const recoverTimeoutMs = options.recoverTimeoutMs ?? 15_000;
  const restartResendMs = options.restartResendMs ?? 5000;
  const disconnectGraceMs = options.disconnectGraceMs ?? 2000;
  const turnFetchTimeoutMs = options.turnFetchTimeoutMs ?? 2000;
  /** Cleaned TURN credentials, and when to refresh them (80% of the ttl). */
  let turn: TurnCredentials | null = null;
  let turnRefreshAt = 0;
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  const stunConfigured = cleanStunUrl(options.stunUrl) !== null;
  /** The call generation stun-unreachable was last reported for. */
  let stunWarned = -1;
  const iceServers = () => iceServersFor(options.stunUrl, turn && turn.expiresAt > Date.now() ? turn : null);

  const listeners: { [E in keyof VoiceEvents]: Set<(p: VoiceEvents[E]) => void> } = {
    participants: new Set(),
    speaking: new Set(),
    error: new Set(),
    deviceFallback: new Set(),
    devicesChanged: new Set(),
  };
  const emit = <E extends keyof VoiceEvents>(event: E, payload: VoiceEvents[E]) => {
    for (const cb of listeners[event]) {
      try {
        cb(payload);
      } catch {
        // A listener's bug must not break the mesh.
      }
    }
  };

  // ---- call state -----------------------------------------------------------
  let active = false;
  /** Bumped on every start/stop so late async work can tell it is stale. */
  let generation = 0;
  let me: Id | null = null;
  let channelId: Id | null = null;
  let members = new Set<Id>();
  const peers = new Map<Id, Peer>();
  /** Dropped for a security reason; not reconnected until the call ends. */
  const refused = new Set<Id>();
  let local: MediaStream | null = null;
  let micMuted = false;
  /** G-84: everyone's audio silenced. */
  let deafened = false;
  /** G-72: my microphone played back to me, while on. */
  let monitor: HTMLAudioElement | null = null;
  function startMonitor() {
    if (monitor || !local) return;
    const a = env.createAudioElement();
    a.autoplay = true;
    a.srcObject = local;
    if (outputId && 'setSinkId' in a) void a.setSinkId(outputId).catch(() => {});
    void a.play?.()?.catch?.(() => {});
    monitor = a;
  }
  function stopMonitor() {
    if (!monitor) return;
    monitor.pause();
    monitor.srcObject = null;
    monitor = null;
  }
  /** G-73: per-person playback volume, 0..2; 1 when not set. */
  const volumes = new Map<Id, number>();
  /**
   * G-73 playback path. Web Audio: each verified peer's source → its gain →
   * a shared limiter → the loopback pair → an <audio> element on the chosen
   * output, so the boosted audio is WebRTC playout that echo cancellation
   * sees (the 0.5.0 "echo above 100%" issue). Without a loopback factory, the
   * limiter goes to the context's destination as before. The peer's own
   * <audio> element stays, muted: Chromium feeds remote WebRTC audio to Web
   * Audio only while an element plays it.
   * Falls back to the element path (volume ≤ 1) where Web Audio or the
   * context's setSinkId is missing or fails. Decided per call.
   */
  let elementOnly = false;
  let limiter: DynamicsCompressorNode | null = null;
  let sinkSet: string | undefined;
  /** The shared loopback playout behind the limiter: one per call, made with the limiter, closed with the call. */
  let playout: LoopbackPlayout | null = null;

  /** The context for Web Audio playback, or null on the element path. */
  function playbackContext(): AudioContext | null {
    if (elementOnly) return null;
    const c = audioContext();
    if (!c || typeof c.createGain !== 'function' || typeof c.createDynamicsCompressor !== 'function') {
      elementOnly = true;
      return null;
    }
    if (!limiter) {
      try {
        // A limiter, so a peer at 200% doesn't clip.
        limiter = c.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.1;
        playout = makePlayout(c);
        limiter.connect(playout ? playout.input : c.destination);
      } catch {
        elementOnly = true;
        limiter = null;
        return null;
      }
    }
    if (outputId !== sinkSet) {
      if (playout) {
        sinkSet = outputId;
        playout.setSink(outputId);
      } else applyContextSink(c);
    }
    return c;
  }

  /**
   * The loopback couldn't negotiate, or an end failed: the limiter goes to
   * the speakers directly for the rest of the call (as before the loopback),
   * so nobody boosted goes silent.
   */
  function loopbackFailed(c: AudioContext) {
    if (!playout || c !== ctx || !limiter) return;
    const dead = playout;
    playout = null;
    try {
      limiter.disconnect();
    } catch {
      // already gone
    }
    limiter.connect(c.destination);
    dead.close();
    applyContextSink(c);
  }

  /** The loopback playout, or null where this env or context can't make one (then the speakers directly). */
  function makePlayout(c: AudioContext): LoopbackPlayout | null {
    if (!env.createLoopbackPeerConnection || typeof c.createMediaStreamDestination !== 'function') return null;
    try {
      return loopbackPlayout(c, () => env.createLoopbackPeerConnection!(), () => env.createAudioElement(), () => loopbackFailed(c));
    } catch {
      return null;
    }
  }

  /** The chosen speaker for the whole context; without setSinkId, back to the element path. */
  function applyContextSink(c: AudioContext) {
    const want = outputId;
    sinkSet = want;
    const sink = (c as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (!want) {
      if (sink) void sink.call(c, '').catch(() => {});
      return;
    }
    if (!sink) return toElementPath();
    void sink.call(c, want).catch(() => toElementPath());
  }

  /** Moves every peer to the element path (volume ≤ 1). */
  function toElementPath() {
    if (elementOnly) return;
    elementOnly = true;
    for (const p of peers.values()) {
      try {
        p.gain?.disconnect();
      } catch {
        // already gone
      }
      p.gain = null;
      applyPlayback(p);
    }
  }

  /** Puts this peer's volume and the deafen state on its gain or its element. */
  function applyPlayback(p: Peer) {
    const v = volumes.get(p.id) ?? 1;
    // Web Audio only for a peer turned up above 100% (voice-d, #440): echo
    // cancellation on that path is unverified, so everyone at 100% or less
    // stays on the element path calls have always used. A gain exists only
    // for a peer playPeer has started (audio and meter set), so only after
    // the certificate check.
    const boost = v > 1 && !!p.audio && !!p.meter && !p.closed;
    if (boost && !p.gain) {
      const c = playbackContext();
      if (c && limiter && p.meter) {
        try {
          const g = c.createGain();
          p.meter.source.connect(g);
          g.connect(limiter);
          p.gain = g;
        } catch {
          p.gain = null;
        }
      }
    } else if (!boost && p.gain) {
      try {
        p.gain.disconnect();
      } catch {
        // already gone
      }
      p.gain = null;
    }
    if (p.gain) {
      p.gain.gain.value = deafened ? 0 : v;
      if (p.audio) p.audio.muted = true;
    } else if (p.audio) {
      p.audio.muted = deafened;
      p.audio.volume = Math.min(1, v);
    }
  }
  let micState: PeerConnectionState = 'connecting';
  let inputId: string | undefined;
  let outputId: string | undefined;
  let ctx: AudioContext | null = null;
  let localMeter: Meter | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let speaking: Record<Id, boolean> = {};

  const unsubscribe = [core.onState((s) => onState(s)), core.onSignal((s) => void onSignal(s))];
  if (env.onDeviceChange) unsubscribe.push(env.onDeviceChange(() => void onDevicesChanged()));
  // A network change: every connected call restarts ICE at once instead of
  // waiting for ICE to notice the old path is gone.
  if (env.onNetworkChange) unsubscribe.push(env.onNetworkChange(() => onNetworkChanged()));

  function emitParticipants() {
    if (!active || !me) return;
    const list: VoiceParticipant[] = [{ identity: me, state: micState }];
    for (const p of peers.values()) list.push({ identity: p.id, state: p.state });
    emit('participants', list);
  }

  // ---- microphone ------------------------------------------------------------
  async function openMic(deviceId: string | undefined): Promise<MediaStream> {
    return env.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  }

  /**
   * G-72: the chosen microphone, or the system default when it is gone
   * (unplugged): then the choice is dropped and deviceFallback says which.
   */
  async function openChosenMic(): Promise<MediaStream> {
    try {
      return await openMic(inputId);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (!inputId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw e;
      const lost = inputId;
      inputId = undefined;
      emit('deviceFallback', { kind: 'input', deviceId: lost });
      return openMic(undefined);
    }
  }

  /** G-72: a device was plugged in or out. A chosen device that is gone falls back to the default. */
  async function onDevicesChanged() {
    emit('devicesChanged', null);
    let all: MediaDeviceInfo[];
    try {
      all = await env.enumerateDevices();
    } catch {
      return;
    }
    const has = (kind: MediaDeviceKind, id: string) => all.some((d) => d.kind === kind && d.deviceId === id);
    if (outputId && !has('audiooutput', outputId)) {
      const lost = outputId;
      outputId = undefined;
      for (const p of peers.values()) if (p.audio && 'setSinkId' in p.audio) void p.audio.setSinkId('').catch(() => {});
      if (ctx && !elementOnly && limiter) applyContextSink(ctx);
      emit('deviceFallback', { kind: 'output', deviceId: lost });
    }
    if (inputId && !has('audioinput', inputId)) {
      const lost = inputId;
      inputId = undefined;
      emit('deviceFallback', { kind: 'input', deviceId: lost });
      if (active && local) await switchMic();
    }
  }

/** Opens the chosen (or default) microphone and swaps it into every connection. */
  async function switchMic() {
    const gen = generation;
    const next = await openChosenMic();
    if (gen !== generation) {
      for (const t of next.getTracks()) t.stop();
      return;
    }
    const track = next.getAudioTracks()[0] ?? null;
    for (const p of peers.values()) {
      for (const s of p.pc.getSenders()) if (!s.track || s.track.kind === 'audio') await s.replaceTrack(track);
    }
    for (const t of local?.getTracks() ?? []) t.stop();
    dropMeter(localMeter);
    local = next;
    if (monitor) monitor.srcObject = next;
    applyMute();
    localMeter = makeMeter(next);
    micState = 'connected';
    emitParticipants();
  }

    function micTrack(): MediaStreamTrack | null {
    return local?.getAudioTracks()[0] ?? null;
  }

  function applyMute() {
    for (const t of local?.getAudioTracks() ?? []) t.enabled = !micMuted;
  }

  // ---- audio analysis --------------------------------------------------------
  function audioContext(): AudioContext | null {
    if (!ctx) {
      try {
        ctx = env.createAudioContext();
        void ctx?.resume?.().catch(() => {});
      } catch {
        ctx = null;
      }
    }
    return ctx;
  }

  function makeMeter(stream: MediaStream): Meter | null {
    const c = audioContext();
    if (!c) return null;
    try {
      const source = c.createMediaStreamSource(stream);
      const analyser = c.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // not to the destination: the <audio> element plays it
      return { source, analyser, buffer: new Float32Array(analyser.fftSize), speak: quiet() };
    } catch {
      return null;
    }
  }

  function dropMeter(m: Meter | null) {
    try {
      m?.source.disconnect();
    } catch {
      // already gone
    }
  }

  /** G-82: one sample (at most every SPEAKING_POLL_MS) through the state machine. */
  function loud(m: Meter, now: number): boolean {
    m.analyser.getFloatTimeDomainData(m.buffer);
    m.speak = stepSpeaking(m.speak, rms(m.buffer), now, threshold);
    return m.speak.on;
  }

  function pollSpeaking() {
    if (!active || !me) return;
    const now = Date.now();
    const next: Record<Id, boolean> = {};
    // My meter keeps sampling while muted (a disabled track is silent), so
    // unmuting starts from an honest state; muted is never shown speaking.
    const mine = !!localMeter && loud(localMeter, now);
    next[me] = !micMuted && mine;
    for (const p of peers.values()) next[p.id] = p.verified && !!p.meter && loud(p.meter, now);
    const keys = new Set([...Object.keys(next), ...Object.keys(speaking)]);
    if ([...keys].some((k) => next[k] !== speaking[k])) {
      speaking = next;
      emit('speaking', { ...next });
    }
  }

  // ---- peers -----------------------------------------------------------------
  function createPeer(id: Id, offerer: boolean, attempt = 1): Peer {
    const pc = env.createPeerConnection({
      iceServers: iceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    const peer: Peer = {
      id,
      pc,
      offerer,
      fingerprint: null,
      pendingIce: [],
      iceReceived: 0,
      stream: null,
      audio: null,
      meter: null,
      gain: null,
      state: 'connecting',
      verified: false,
      closed: false,
      attempt,
      watchdog: null,
      recovery: null,
      grace: null,
      startedAt: Date.now(),
      setupMs: null,
      gathered: null,
      gatherMs: null,
    };
    peers.set(id, peer);
    peer.watchdog = setTimeout(
      () => {
        peer.watchdog = null;
        if (!peer.closed && !peer.verified) retryOrFail(peer);
      },
      offerer ? answerTimeoutMs * 2 ** (attempt - 1) : connectTimeoutMs,
    );

    // The offerer creates the audio m-line. The answerer must not: a
    // transceiver added before the offer is applied is not bound to the
    // offer's m-line in Chromium, and the answer then goes out recvonly
    // (QA-21: one-way audio). It takes the offer's transceiver instead, in
    // bindAnswerTransceiver.
    if (offerer) {
      const track = micTrack();
      const transceiver = track
        ? pc.addTransceiver(track, { direction: 'sendrecv', streams: local ? [local] : [] })
        : pc.addTransceiver('audio', { direction: 'recvonly' });
      preferOpus(transceiver);
    }

    pc.ondatachannel = (e) => e.channel.close(); // voice uses no data channels
    pc.ontrack = (e) => {
      if (peer.closed || e.track.kind !== 'audio') return;
      peer.stream = e.streams[0] ?? new MediaStream([e.track]);
      if (peer.verified) playPeer(peer);
    };
    pc.onconnectionstatechange = () => {
      if (peer.closed) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        if (peer.setupMs === null) peer.setupMs = Date.now() - peer.startedAt;
        clearGrace(peer);
        endRecovery(peer);
        void checkCertificate(peer); // again after a restart: same certificate, or the peer goes
      } else if (s === 'disconnected' || s === 'failed') {
        // A call that worked: ICE restart on this connection (after a short
        // grace for `disconnected`, at once for `failed`). One that never
        // connected: the offerer's fresh-connection retries, as before.
        if (peer.verified) {
          if (s === 'failed' || peer.recovery) recover(peer);
          else if (!peer.grace) {
            peer.grace = setTimeout(() => {
              peer.grace = null;
              if (!peer.closed && peer.pc.connectionState !== 'connected') recover(peer);
            }, disconnectGraceMs);
          }
        } else if (s === 'failed') retryOrFail(peer);
      }
    };
    emitParticipants();
    return peer;
  }

  // ---- ICE restart: a call that survives a network change -----------------
  // A verified call whose connection drops (disconnected, failed) or whose
  // device changes network restarts ICE on the same connection: the offerer
  // (lower identity, as for the first offer: no glare) sends a restart offer
  // over the existing signalling, again every restartResendMs while it's down;
  // the answerer answers on the same connection (onSignal). The certificate
  // can't change: the same checks run. Not back within recoverTimeoutMs: the
  // peer is dropped as peer-failed ("no voice connection").

  function recover(peer: Peer) {
    if (peer.closed || !peer.verified) return;
    clearGrace(peer);
    if (!peer.recovery) {
      peer.state = 'connecting';
      emitParticipants();
      const giveUp = setTimeout(() => {
        if (peer.recovery) dropPeer(peer, 'peer-failed');
      }, recoverTimeoutMs);
      const resend = peer.offerer ? setInterval(() => restartIce(peer), restartResendMs) : null;
      peer.recovery = { giveUp, resend };
    }
    if (peer.offerer) restartIce(peer);
  }

  function restartIce(peer: Peer) {
    if (peer.closed || !peer.recovery) return;
    const st = peer.pc.signalingState;
    if (st !== 'stable' && st !== 'have-local-offer') return;
    try {
      peer.pc.restartIce();
    } catch {
      return;
    }
    void sendDescription(peer, 'offer').catch(() => {});
  }

  function clearGrace(peer: Peer) {
    if (peer.grace) clearTimeout(peer.grace);
    peer.grace = null;
  }

  function endRecovery(peer: Peer) {
    if (!peer.recovery) return;
    clearTimeout(peer.recovery.giveUp);
    if (peer.recovery.resend) clearInterval(peer.recovery.resend);
    peer.recovery = null;
  }

  /** The device changed network: every connected call restarts now. */
  function onNetworkChanged() {
    if (!active) return;
    for (const p of [...peers.values()]) if (p.verified && !p.closed) recover(p);
  }

  /** The offerer offers again on a fresh connection while it has tries left. */
  function retryOrFail(peer: Peer) {
    if (peer.closed) return; // already dropped or retried (stale async work)
    const next = peer.attempt + 1;
    if (peer.offerer && next <= OFFER_ATTEMPTS && active && members.has(peer.id) && !refused.has(peer.id)) {
      dropPeer(peer);
      void offerTo(peer.id, next);
    } else {
      dropPeer(peer, 'peer-failed');
    }
  }

  function dropPeer(peer: Peer, reason?: VoiceErrorCode) {
    if (peer.closed) return;
    peer.closed = true;
    if (peer.watchdog) clearTimeout(peer.watchdog);
    peer.watchdog = null;
    endRecovery(peer);
    clearGrace(peer);
    peer.state = 'failed';
    try {
      peer.pc.close();
    } catch {
      // closing twice is harmless
    }
    dropMeter(peer.meter);
    try {
      peer.gain?.disconnect();
    } catch {
      // already gone
    }
    peer.gain = null;
    if (peer.audio) {
      peer.audio.pause();
      peer.audio.srcObject = null;
    }
    peers.delete(peer.id);
    if (reason === 'fingerprint-mismatch' || reason === 'unverified-signal') refused.add(peer.id);
    if (reason) emit('error', { code: reason, peer: peer.id });
    if (speaking[peer.id] !== undefined) {
      const { [peer.id]: _gone, ...rest } = speaking;
      speaking = rest;
      emit('speaking', { ...rest });
    }
    emitParticipants();
  }

  /** The certificate the peer presented must be the one its verified SDP named. */
  // Fails closed: no stats, no certificate, or any certificate that differs
  // drops the peer. (Chromium reports remoteCertificateId once DTLS is up.)
  async function checkCertificate(peer: Peer) {
    const seen: string[] = [];
    try {
      const stats = await peer.pc.getStats();
      if (peer.closed) return;
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((r: Record<string, unknown>) => byId.set(r.id as string, r));
      for (const r of byId.values()) {
        if (r.type !== 'transport' || typeof r.remoteCertificateId !== 'string') continue;
        const cert = byId.get(r.remoteCertificateId);
        const ok = cert && typeof cert.fingerprint === 'string' && typeof cert.fingerprintAlgorithm === 'string';
        seen.push(ok ? (normalizeFingerprint(cert.fingerprintAlgorithm as string, cert.fingerprint as string) ?? '') : '');
      }
    } catch {
      if (peer.closed) return;
      return dropPeer(peer, 'fingerprint-mismatch');
    }
    if (!peer.fingerprint || !seen.length || seen.some((f) => f !== peer.fingerprint)) {
      return dropPeer(peer, 'fingerprint-mismatch');
    }
    peer.verified = true;
    peer.state = 'connected';
    if (peer.watchdog) clearTimeout(peer.watchdog);
    peer.watchdog = null;
    if (peer.stream) playPeer(peer);
    emitParticipants();
  }

  function playPeer(peer: Peer) {
    if (peer.audio || !peer.stream) return;
    // Chromium feeds remote WebRTC audio to Web Audio only while an element
    // also plays it (spike finding), so the element both plays and enables
    // the meter.
    const audio = env.createAudioElement();
    audio.autoplay = true;
    audio.srcObject = peer.stream;
    if (outputId && 'setSinkId' in audio) void audio.setSinkId(outputId).catch(() => {});
    void audio.play?.()?.catch?.(() => {});
    peer.audio = audio;
    peer.meter = makeMeter(peer.stream);
    // Only from here on, after the certificate check (verified), may a peer reach the speakers.
    applyPlayback(peer);
  }

  /** Waits for ICE gathering so the SDP carries every candidate (no trickle). */
  function gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (pc.iceGatheringState !== 'complete') return;
        pc.removeEventListener('icegatheringstatechange', done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }, gatherTimeoutMs);
      pc.addEventListener('icegatheringstatechange', done);
    });
  }

  async function sendDescription(peer: Peer, kind: 'offer' | 'answer') {
    const gen = generation;
    const pc = peer.pc;
    const desc = kind === 'offer' ? await pc.createOffer() : await pc.createAnswer();
    if (peer.closed || gen !== generation) return;
    await pc.setLocalDescription(desc);
    const gatherFrom = Date.now();
    await gathered(pc);
    if (peer.closed || gen !== generation) return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) return dropPeer(peer, 'failed');
    peer.gatherMs = Date.now() - gatherFrom;
    peer.gathered = candidateCounts(sdp);
    // G-81: STUN configured, yet no public address came back: say so once per call.
    if (stunConfigured && peer.gathered.srflx === 0 && stunWarned !== generation) {
      stunWarned = generation;
      emit('error', { code: 'stun-unreachable' });
    }
    await core.sendSignal(peer.id, kind, sdp);
  }

  async function offerTo(id: Id, attempt = 1) {
    const peer = createPeer(id, true, attempt);
    try {
      await sendDescription(peer, 'offer');
    } catch {
      retryOrFail(peer);
    }
  }

  /** Applies a verified offer or answer; false (and the peer dropped) on a fingerprint problem. */
  function preferOpus(transceiver: RTCRtpTransceiver) {
    const opus = env.opusCodecs();
    if (!opus?.length) return;
    try {
      transceiver.setCodecPreferences(opus);
    } catch {
      // the browser negotiates its default (Opus first in Chromium)
    }
  }

  /**
   * Answerer, after the offer is applied: the transceiver of the offer's audio
   * m-line sends my mic (sendrecv), or only receives without one. False when
   * the offer has no audio m-line.
   */
  async function bindAnswerTransceiver(peer: Peer): Promise<boolean> {
    const offered = peer.pc.getTransceivers().filter((t) => t.mid !== null && t.currentDirection !== 'stopped');
    const transceiver = offered.find((t) => t.receiver.track?.kind === 'audio');
    if (!transceiver) return false;
    // Voice is one audio m-line. Anything else the offer carries (video, a
    // second audio line) is answered inactive: nothing sent, nothing taken.
    // A data channel (m=application) has no transceiver; ondatachannel
    // closes any that opens.
    for (const t of offered) if (t !== transceiver) t.direction = 'inactive';
    const track = micTrack();
    if (track) {
      await transceiver.sender.replaceTrack(track);
      if (local) transceiver.sender.setStreams?.(local);
      transceiver.direction = 'sendrecv';
    } else {
      transceiver.direction = 'recvonly';
    }
    preferOpus(transceiver);
    return true;
  }

  async function applyRemote(peer: Peer, type: 'offer' | 'answer', sdp: string): Promise<boolean> {
    const fingerprint = soleFingerprint(sdp);
    // Pinned: once a peer has a fingerprint, every later offer or answer (an
    // ICE restart) must name the same one; refused before it's applied.
    if (!fingerprint || (peer.fingerprint !== null && fingerprint !== peer.fingerprint)) {
      dropPeer(peer, 'fingerprint-mismatch');
      return false;
    }
    peer.fingerprint = fingerprint;
    await peer.pc.setRemoteDescription({ type, sdp });
    if (peer.closed) return false;
    // What the connection applied must commit to the verified certificate.
    const applied = soleFingerprint(peer.pc.remoteDescription?.sdp ?? '');
    if (applied !== fingerprint) {
      dropPeer(peer, 'fingerprint-mismatch');
      return false;
    }
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    return true;
  }

  async function onSignal(signal: CallSignal) {
    if (!active || !me || signal.from === me || !members.has(signal.from)) return;
    const existing = peers.get(signal.from);
    if (signal.fingerprintVerified !== true) {
      // The core never sends these (it fails closed); if one shows up anyway,
      // nothing from that peer is trusted for the rest of the call.
      if (existing) dropPeer(existing, 'unverified-signal');
      else {
        refused.add(signal.from);
        emit('error', { code: 'unverified-signal', peer: signal.from });
      }
      return;
    }
    if (refused.has(signal.from)) return;
    const iOffer = me < signal.from;
    try {
      if (signal.kind === 'offer') {
        if (iOffer) return; // glare: the lower identity offers, so mine wins
        // An ICE restart (new TURN credentials) on a working connection: same
        // certificate, so renegotiate on it; the checks still run.
        if (
          existing &&
          !existing.offerer &&
          existing.verified &&
          existing.pc.signalingState === 'stable' &&
          soleFingerprint(signal.payload) === existing.fingerprint
        ) {
          if (!(await applyRemote(existing, 'offer', signal.payload)) || existing.closed) return;
          await sendDescription(existing, 'answer');
          return;
        }
        // Any other new offer from the same peer (it restarted): start over.
        if (existing) dropPeer(existing);
        if (peers.size >= MAX_PEERS) return;
        const peer = createPeer(signal.from, false);
        if (!(await applyRemote(peer, 'offer', signal.payload))) return;
        if (peer.closed) return;
        if (!(await bindAnswerTransceiver(peer))) return dropPeer(peer, 'peer-failed');
        if (peer.closed) return;
        await sendDescription(peer, 'answer');
      } else if (signal.kind === 'answer') {
        if (!existing || !existing.offerer || existing.pc.signalingState !== 'have-local-offer') return;
        await applyRemote(existing, 'answer', signal.payload);
      } else if (signal.kind === 'ice') {
        if (!existing) return;
        let init: RTCIceCandidateInit;
        try {
          const parsed = JSON.parse(signal.payload) as RTCIceCandidateInit;
          if (typeof parsed?.candidate !== 'string') return;
          init = { candidate: parsed.candidate, sdpMid: parsed.sdpMid ?? null, sdpMLineIndex: parsed.sdpMLineIndex ?? null };
        } catch {
          return;
        }
        // A cap on everything a peer trickles, so a member can't make us send
        // checks to any number of addresses (we don't trickle; normally 0).
        if (existing.iceReceived >= MAX_TRICKLED_ICE) return;
        existing.iceReceived++;
        if (existing.pc.remoteDescription) await existing.pc.addIceCandidate(init).catch(() => {});
        else existing.pendingIce.push(init);
      }
    } catch {
      const peer = peers.get(signal.from);
      if (peer) retryOrFail(peer);
    }
  }

  function onState(state: CallState) {
    if (!active || !me) return;
    if (!state.participants.length || (channelId && state.channelId !== channelId)) {
      // Left, or the core moved me to another call: the mesh is over.
      if (!state.participants.length) stop();
      else {
        for (const p of [...peers.values()]) dropPeer(p);
        refused.clear();
        channelId = state.channelId;
        reconcile(state);
      }
      return;
    }
    reconcile(state);
  }

  function reconcile(state: CallState) {
    const others = state.participants.map((p) => p.identity).filter((id) => id !== me);
    members = new Set(others.slice(0, MAX_PEERS));
    for (const p of [...peers.values()]) if (!members.has(p.id)) dropPeer(p);
    for (const id of members) {
      if (peers.has(id) || refused.has(id)) continue;
      if (me! < id) void offerTo(id);
    }
    emitParticipants();
  }

  // ---- TURN (G-81) -------------------------------------------------------------
  /** Fresh credentials from the core, cleaned; null on any failure. Never logged. */
  async function fetchTurn(): Promise<TurnCredentials | null> {
    if (!options.enableTurn || !options.turnHost || !core.getTurnCredentials) return null;
    try {
      const raw = await Promise.race([
        core.getTurnCredentials(),
        new Promise<null>((r) => setTimeout(() => r(null), turnFetchTimeoutMs)),
      ]);
      return cleanTurnCredentials(raw, options.turnHost);
    } catch {
      return null; // relay-only, not-implemented, rate-limited: STUN only
    }
  }

  function scheduleTurnRefresh(gen: number) {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    if (!turn) return;
    turnTimer = setTimeout(() => void refreshTurn(gen), Math.max(1000, turnRefreshAt - Date.now()));
  }

  function keepTurn(next: TurnCredentials) {
    turn = next;
    turnRefreshAt = Date.now() + next.ttl * 800; // 80% of the ttl
  }

  /** New credentials into every connection; the offerer restarts ICE. */
  async function refreshTurn(gen: number) {
    turnTimer = null;
    const next = await fetchTurn();
    if (gen !== generation || !active) return;
    if (!next) {
      // Keep the old ones while they last; try again in 30 s.
      if (turn && turn.expiresAt > Date.now() + 30_000) turnTimer = setTimeout(() => void refreshTurn(gen), 30_000);
      return;
    }
    keepTurn(next);
    for (const p of peers.values()) {
      try {
        p.pc.setConfiguration({ ...p.pc.getConfiguration(), iceServers: iceServers() });
        if (p.offerer && p.verified && p.pc.signalingState === 'stable') {
          p.pc.restartIce();
          void sendDescription(p, 'offer').catch(() => {});
        }
      } catch {
        // this connection keeps its current servers
      }
    }
    scheduleTurnRefresh(gen);
  }

  /** Cached credentials while fresh, else a fetch (bounded by turnFetchTimeoutMs). */
  async function ensureTurn(gen: number) {
    if (!options.enableTurn) return;
    if (!turn || Date.now() >= turnRefreshAt) {
      const next = await fetchTurn();
      if (gen !== generation) return;
      if (next) keepTurn(next);
    }
    scheduleTurnRefresh(gen);
  }

  // ---- lifecycle -------------------------------------------------------------
  async function start(state: CallState, myId: Id) {
    if (active) stop();
    // SL S1: relay-only means no voice. The core already refuses and ends
    // calls; the engine adds its own stop: no microphone, no connection, no
    // candidate gathering (offers and signals are ignored while inactive).
    if (options.relayOnly) return;
    active = true;
    const gen = ++generation;
    me = myId;
    channelId = state.channelId;
    micState = 'connecting';
    speaking = {};
    const turnReady = ensureTurn(gen); // alongside the microphone
    try {
      local = await openChosenMic();
      if (gen !== generation) {
        for (const t of local.getTracks()) t.stop();
        return;
      }
      applyMute();
      localMeter = makeMeter(local);
      micState = 'connected';
    } catch (e) {
      if (gen !== generation) return;
      local = null;
      micState = 'failed';
      emit('error', { code: micError(e) }); // still listen
    }
    await turnReady;
    if (gen !== generation) return;
    timer = setInterval(pollSpeaking, SPEAKING_POLL_MS);
    reconcile(state);
  }

  function stop() {
    stopMonitor();
    if (!active) return;
    active = false;
    generation++;
    for (const p of [...peers.values()]) dropPeer(p);
    for (const t of local?.getTracks() ?? []) t.stop();
    local = null;
    dropMeter(localMeter);
    localMeter = null;
    if (timer) clearInterval(timer);
    timer = null;
    if (turnTimer) clearTimeout(turnTimer); // the cache stays; no refreshing outside a call
    turnTimer = null;
    playout?.close();
    playout = null;
    void ctx?.close?.().catch(() => {});
    ctx = null;
    limiter = null;
    sinkSet = undefined;
    elementOnly = false;
    refused.clear();
    members = new Set();
    me = null;
    channelId = null;
    if (Object.keys(speaking).length) emit('speaking', {});
    speaking = {};
    emit('participants', []);
  }

  async function listDevices(kind: MediaDeviceKind): Promise<AudioDevice[]> {
    const all = await env.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    return all.filter((d) => d.kind === kind).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${kind} ${i + 1}` }));
  }

  return {
    async join(id) {
      const state = await core.joinCall(id);
      const mine = state.participants[0]?.identity; // the core lists me first
      if (mine) await start(state, mine);
      return state;
    },
    async leave() {
      stop();
      await core.leaveCall();
    },
    attach: (state, myId) => start(state, myId),
    detach: () => stop(),
    async setMuted(muted) {
      micMuted = muted;
      applyMute();
      await core.setMuted(muted);
    },
    setMicMuted(muted) {
      micMuted = muted;
      applyMute();
    },
    async setInputDevice(deviceId) {
      inputId = deviceId || undefined;
      if (!active) return;
      // Connections made without a microphone are receive-only; sending would
      // need a renegotiation the answerer can't start (glare rule). v1: rejoin.
      if (!local) {
        emit('error', { code: 'rejoin-to-talk' });
        return;
      }
      await switchMic();
    },
    async setOutputDevice(deviceId) {
      outputId = deviceId || undefined;
      if (playout) {
        sinkSet = outputId;
        playout.setSink(outputId);
      } else if (ctx && !elementOnly && limiter) applyContextSink(ctx);
      if (monitor && 'setSinkId' in monitor) void monitor.setSinkId(deviceId).catch(() => {});
      await Promise.all(
        [...peers.values()].map((p) =>
          p.audio && 'setSinkId' in p.audio ? p.audio.setSinkId(deviceId).catch(() => {}) : undefined,
        ),
      );
    },
    listInputDevices: () => listDevices('audioinput'),
    listOutputDevices: () => listDevices('audiooutput'),
    setSelfMonitor(on) {
      if (on && active) startMonitor();
      else stopMonitor();
    },
    setPeerVolume(id, volume) {
      const v = Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
      volumes.set(id, v);
      const p = peers.get(id);
      if (p) applyPlayback(p);
    },
    setDeafened(on) {
      deafened = on;
      for (const p of peers.values()) applyPlayback(p);
    },
    inputLevel() {
      if (!active || micMuted || !localMeter) return 0;
      try {
        localMeter.analyser.getFloatTimeDomainData(localMeter.buffer);
        let sum = 0;
        for (const v of localMeter.buffer) sum += v * v;
        // Speech RMS sits around 0.02..0.2: scale so a normal voice fills most of the bar.
        return Math.min(1, Math.sqrt(sum / localMeter.buffer.length) * 5);
      } catch {
        return 0;
      }
    },
    on(event, cb) {
      listeners[event].add(cb);
      return () => listeners[event].delete(cb);
    },
    async connectionTypes() {
      const out: Record<Id, { local: string; remote: string } | null> = {};
      for (const p of peers.values()) out[p.id] = await selectedPair(p.pc);
      return out;
    },
    async diagnostics() {
      const out: VoiceDiagnostics = { stun: stunConfigured, stunAnswered: null, gatherWindowS: gatherTimeoutMs / 1000, peers: {} };
      for (const p of peers.values()) {
        const ice = p.pc.iceConnectionState;
        out.peers[p.id] = {
          state: p.state,
          ice: ICE_STATES.includes(ice) ? ice : 'unknown',
          gathered: p.gathered && { ...p.gathered },
          pair: await selectedPair(p.pc),
          gatherMs: p.gatherMs,
          setupMs: p.setupMs,
        };
        if (stunConfigured && p.gathered) out.stunAnswered = out.stunAnswered === true || p.gathered.srflx > 0;
      }
      return out;
    },
    dispose() {
      stop();
      for (const u of unsubscribe) u();
      for (const set of Object.values(listeners)) set.clear();
    },
  };
}
