// Voice v1, piece D: the mesh engine against fake WebRTC and a fake core.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallPath, CallSignal, CallState, Id } from '../core/types';
import type { SignalKind, VoiceCore } from './adapter';
import { candidateCounts, createVoiceEngine, remotePeerConnection, type VoiceEngineOptions, type VoiceEnv, type VoiceError, type VoiceParticipant } from './engine';
import { cleanTurnCredentials, fingerprints, iceServersFor, normalizeFingerprint, soleFingerprint } from './sdp';
import type { MediaEnv } from './media/session';
import { loopback } from './media/transport';

const A: Id = 'a'.repeat(64);
const B: Id = 'b'.repeat(64);
const C: Id = 'c'.repeat(64);
const CH: Id = 'f'.repeat(64);

// ---- fakes -------------------------------------------------------------------

let fpCounter = 0;
const newFingerprint = () => {
  const n = (++fpCounter).toString(16).padStart(2, '0');
  return Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 'AB')).join(':');
};

/** An offer from a peer with a mic: one audio m-line, sendrecv. */
const audioOffer = (fp = newFingerprint()) =>
  `v=0\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n`;

class FakeTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

interface FakeSender {
  track: FakeTrack | null;
  streams: FakeStream[];
  replaceTrack: (t: FakeTrack | null) => Promise<void>;
  setStreams: (...s: FakeStream[]) => void;
}

interface FakeTransceiver {
  mid: string | null;
  direction: string;
  stopped: boolean;
  codecs: unknown;
  sender: FakeSender;
  receiver: { track: { kind: string } };
  setCodecPreferences: (c: unknown) => void;
}

/** Every fake connection, so a test can look at them and at who presented what certificate. */
const allPcs: FakePC[] = [];

/** Real-looking candidate lines, addresses included (the diagnostics must never show them). */
const DEFAULT_CANDIDATES = [
  'candidate:1 1 udp 2122260223 192.168.1.23 54321 typ host generation 0',
  'candidate:2 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.23 rport 54321 generation 0',
];
/** Candidate lines for the next FakePCs (a test sets it before the call starts). */
let nextCandidates: string[] | null = null;

class FakePC {
  readonly fingerprint = newFingerprint();
  /** What getStats reports as the peer's certificate; by default, the real peer's. */
  presentedFingerprint: string | null = null;
  /** 'none': no transport stats; 'throw': getStats rejects. */
  statsMode: 'ok' | 'none' | 'throw' = 'ok';
  /** Rewrites what setRemoteDescription applies (a misbehaving stack). */
  rewriteRemote: ((sdp: string) => string) | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'complete';
  closed = false;
  candidates: RTCIceCandidateInit[] = [];
  senders: FakeSender[] = [];
  transceivers: FakeTransceiver[] = [];
  ontrack: ((e: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  /** setConfiguration calls (G-81 refresh) and restartIce calls. */
  configs: RTCConfiguration[] = [];
  restarts = 0;
  /** Candidate types of the selected pair, for connectionTypes. */
  pairTypes: [string, string] = ['host', 'host'];
  /** Extra fields on both candidate stats, and extra stats (G-81 fuzz: hostile values everywhere). */
  statsExtra: Record<string, unknown> = {};
  statsMore: Record<string, unknown>[] = [];
  /** G-81: the candidate lines this side gathers (into its SDP): a host and a srflx, as behind a NAT with STUN. */
  localCandidates: string[] = [...(nextCandidates ?? DEFAULT_CANDIDATES)];
  get iceConnectionState(): RTCIceConnectionState {
    const s = this.connectionState;
    return s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'closed' ? 'closed' : 'checking';
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(c: RTCConfiguration) {
    this.configs.push(c);
    this.config = c;
  }
  restartIce() {
    this.restarts++;
  }
  constructor(public config: RTCConfiguration) {
    allPcs.push(this);
  }
  private transceiver(direction: string, track: FakeTrack | null, mid: string | null): FakeTransceiver {
    const sender: FakeSender = {
      track,
      streams: [],
      replaceTrack: async (nt) => void (sender.track = nt),
      setStreams: (...s) => void (sender.streams = s),
    };
    const t: FakeTransceiver = {
      mid,
      direction,
      stopped: false,
      codecs: null,
      sender,
      receiver: { track: { kind: 'audio' } },
      setCodecPreferences: (c) => void (t.codecs = c),
    };
    this.transceivers.push(t);
    this.senders.push(sender);
    return t;
  }
  addTransceiver(trackOrKind: FakeTrack | string, init: { direction: string }) {
    return this.transceiver(init.direction, typeof trackOrKind === 'string' ? null : trackOrKind, null);
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders() {
    return this.senders;
  }
  /** The transceiver of the one audio m-line ("0"), once negotiated. */
  bound(): FakeTransceiver | undefined {
    return this.transceivers.find((t) => t.mid === '0');
  }
  private sdp(type: string) {
    const direction = this.bound()?.direction ?? 'inactive';
    return `v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${this.fingerprint}\r\na=setup:${type === 'offer' ? 'actpass' : 'active'}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=${direction}\r\n` + this.localCandidates.map((c) => `a=${c}\r\n`).join('');
  }
  async createOffer() {
    // The first transceiver without a mid gets the m-line.
    const t = this.transceivers.find((x) => x.mid === null);
    if (t && !this.bound()) t.mid = '0';
    return { type: 'offer' as const, sdp: this.sdp('offer') };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: this.sdp('answer') };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    this.maybeConnect();
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = { type: d.type, sdp: this.rewriteRemote ? this.rewriteRemote(d.sdp!) : d.sdp };
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    // Like Chromium: a transceiver added with addTransceiver before the offer
    // is NOT bound to the offer's m-line; a new receive-only one is (QA-21).
    // One per audio/video m-line, in order, mid = its index (m=application
    // is SCTP: no transceiver).
    if (d.type === 'offer' && !this.bound()) {
      const kinds = [...(d.sdp ?? '').matchAll(/\r\nm=(\w+) /g)].map((m) => m[1]!);
      kinds.forEach((kind, i) => {
        if (kind !== 'audio' && kind !== 'video') return;
        this.transceiver('recvonly', null, String(i)).receiver.track.kind = kind;
      });
    }
    this.maybeConnect();
  }
  /** Whether the remote side sends audio, from its m-line direction. */
  private remoteSends(): boolean {
    return /a=(sendrecv|sendonly)\r\n/.test(this.remoteDescription?.sdp ?? '');
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.candidates.push(c);
  }
  addEventListener() {}
  removeEventListener() {}
  async getStats() {
    if (this.statsMode === 'throw') throw new Error('stats unavailable');
    if (this.statsMode === 'none') return new Map<string, Record<string, unknown>>([['X', { id: 'X', type: 'codec' }]]);
    const remote = this.presentedFingerprint ?? soleFingerprint(this.remoteDescription?.sdp ?? '')?.split(' ')[1];
    return new Map<string, Record<string, unknown>>([
      ['T1', { id: 'T1', type: 'transport', remoteCertificateId: 'CR', selectedCandidatePairId: 'P' }],
      ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded', nominated: true }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: this.pairTypes[0], address: '192.0.2.10', port: 5000, ...this.statsExtra }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: this.pairTypes[1], address: '198.51.100.20', port: 6000, ...this.statsExtra }],
      ['CR', { id: 'CR', type: 'certificate', fingerprint: remote?.toUpperCase(), fingerprintAlgorithm: 'sha-256' }],
      ...this.statsMore.map((r, i): [string, Record<string, unknown>] => [`X${i}`, { id: `X${i}`, ...r }]),
    ]);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  /** ICE never connects again (a network with no path to the peer); signalling still works. */
  neverConnect = false;
  private maybeConnect() {
    if (this.neverConnect || this.signalingState !== 'stable' || !this.localDescription || !this.remoteDescription) return;
    setTimeout(() => {
      if (this.closed) return;
      if (this.remoteSends()) this.ontrack?.({ track: new FakeTrack(), streams: [new FakeStream()] });
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
    }, 0);
  }
}

class FakeAnalyser {
  fftSize = 512;
  level = 0;
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(this.level);
  }
}

/** G-81 B playout: one end of the in-renderer loopback pair. Records what it was asked to do. */
class FakeLoopbackPC {
  static made: FakeLoopbackPC[] = [];
  calls: string[] = [];
  closed = false;
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  constructor(readonly args: unknown[]) {
    FakeLoopbackPC.made.push(this);
  }
  addTrack() {
    this.calls.push('addTrack');
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'v=0 loopback-offer' };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'v=0 loopback-answer' };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
    this.calls.push(`local:${d.type}`);
    // A candidate, as a real end would gather (it must stay in the pair).
    setTimeout(() => this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' } }), 0);
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.calls.push(`remote:${d.type}`);
    if (d.type === 'offer') setTimeout(() => this.ontrack?.({ track: new FakeTrack(), streams: [new FakeStream()] }), 0);
  }
  async addIceCandidate() {
    this.calls.push('ice');
  }
  close() {
    this.closed = true;
  }
}

/** G-73: a node that records what it is connected to. */
class FakeNode {
  out: unknown[] = [];
  connect(n: unknown) {
    this.out.push(n);
  }
  disconnect() {
    this.out = [];
  }
}

/** G-73: the Web Audio playback path (gain, limiter, setSinkId); off in the plain fake. */
class FakeWebAudioContext {
  analysers: FakeAnalyser[] = [];
  gains: (FakeNode & { gain: { value: number } })[] = [];
  sources: FakeNode[] = [];
  limiters: (FakeNode & { threshold: { value: number } })[] = [];
  destination = new FakeNode();
  sinks: string[] = [];
  closed = false;
  constructor(private sinkFails = false) {}
  createMediaStreamSource() {
    const n = new FakeNode();
    this.sources.push(n);
    return n;
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  }
  createGain() {
    const g = Object.assign(new FakeNode(), { gain: { value: 1 } });
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    const c = Object.assign(new FakeNode(), { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } });
    this.limiters.push(c);
    return c;
  }
  /** G-81 B playout: the loopback's stream source. */
  destinations: (FakeNode & { stream: { getAudioTracks(): { stop(): void }[]; getTracks(): { stop(): void; stopped?: boolean }[] } })[] = [];
  createMediaStreamDestination() {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const d = Object.assign(new FakeNode(), { stream: { getAudioTracks: () => [track], getTracks: () => [track] } });
    this.destinations.push(d);
    return d;
  }
  // G-81 B playback: a clock and buffer sources (what MediaSession schedules).
  currentTime = 0;
  scheduled: { at: number; out: unknown }[] = [];
  createBuffer(_c: number, n: number) {
    return { length: n, copyToChannel() {} };
  }
  createBufferSource() {
    const node = Object.assign(new FakeNode(), { buffer: null as unknown, start: (at: number) => this.scheduled.push({ at, out: node.out[0] }) });
    return node;
  }
  async setSinkId(id: string) {
    if (this.sinkFails && id) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
    this.sinks.push(id);
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
}

class FakeAudioContext {
  analysers: FakeAnalyser[] = [];
  closed = false;
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
}

interface Harness {
  env: VoiceEnv;
  mics: FakeStream[];
  contexts: (FakeAudioContext | FakeWebAudioContext)[];
  audios: { srcObject: unknown; paused: boolean; muted: boolean; volume: number }[];
  pcs: FakePC[];
  /** G-72: the devices on the computer; a chosen ID not in it fails like an unplugged device. */
  devices: MediaDeviceInfo[];
  /** The deviceId each getUserMedia asked for (undefined: the default). */
  asked: (string | undefined)[];
  /** Plugs devices in or out, then fires devicechange. */
  changeDevices: (list: MediaDeviceInfo[]) => Promise<void>;
  /** Fires the network-change event (online / another interface). */
  changeNetwork: () => void;
}

function fakeEnv(opts: { micError?: string; webAudio?: { sinkFails?: boolean } } = {}): Harness {
  let onChange: (() => void) | null = null;
  let onNet: (() => void) | null = null;
  const h: Harness = {
    mics: [],
    contexts: [],
    audios: [],
    pcs: [],
    env: null as unknown as VoiceEnv,
    devices: [
      { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      { kind: 'audiooutput', deviceId: 'spk1', label: '' },
    ] as MediaDeviceInfo[],
    asked: [],
    changeDevices: async (list) => {
      h.devices = list;
      onChange?.();
      await flush();
    },
    changeNetwork: () => onNet?.(),
  };
  h.env = {
    createPeerConnection: (config) => {
      const pc = new FakePC(config);
      h.pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    getUserMedia: async (c) => {
      if (opts.micError) throw Object.assign(new Error('no'), { name: opts.micError });
      const wanted = ((c.audio as MediaTrackConstraints | undefined)?.deviceId as { exact?: string } | undefined)?.exact;
      h.asked.push(wanted);
      if (wanted && !h.devices.some((d) => d.kind === 'audioinput' && d.deviceId === wanted)) {
        throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      }
      const s = new FakeStream();
      h.mics.push(s);
      return s as unknown as MediaStream;
    },
    enumerateDevices: async () => h.devices,
    onDeviceChange: (cb) => {
      onChange = cb;
      return () => {
        onChange = null;
      };
    },
    onNetworkChange: (cb) => {
      onNet = cb;
      return () => {
        onNet = null;
      };
    },
    createAudioContext: () => {
      const c = opts.webAudio ? new FakeWebAudioContext(opts.webAudio.sinkFails) : new FakeAudioContext();
      h.contexts.push(c);
      return c as unknown as AudioContext;
    },
    createLoopbackPeerConnection: (...args: unknown[]) => new FakeLoopbackPC(args) as unknown as RTCPeerConnection,
    createAudioElement: () => {
      const a = { srcObject: null as unknown, paused: true, autoplay: false, muted: false, volume: 1, sinks: [] as string[], setSinkId: async (id: string) => void a.sinks.push(id), play: async () => void (a.paused = false), pause: () => void (a.paused = true) };
      h.audios.push(a);
      return a as unknown as HTMLAudioElement;
    },
    opusCodecs: () => [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
  };
  return h;
}

class FakeCore implements VoiceCore {
  stateHandlers = new Set<(s: CallState) => void>();
  signalHandlers = new Set<(s: CallSignal) => void>();
  sent: { to: Id; kind: SignalKind; payload: string }[] = [];
  muted: boolean[] = [];
  left = 0;
  /** Where sendSignal delivers (another engine's core), if wired. */
  wire: ((to: Id, kind: SignalKind, payload: string) => void) | null = null;
  /** G-81: mocked TURN credentials (the core api does not have it yet). */
  getTurnCredentials?: () => Promise<unknown>;
  /** G-81 B (2a, mocked): the core's path to each participant, and the call id. */
  paths: Partial<Record<Id, CallPath>> = {};
  callId: string | undefined = undefined;
  /** G-81 B (2a, mocked): what the engine said about live LAN WebRTC peers. */
  webrtcPeers: Id[][] = [];
  setCallWebrtcPeers?: (ids: Id[]) => Promise<unknown>;
  constructor(readonly me: Id, readonly participants: Id[]) {}
  state(): CallState {
    return {
      channelId: CH,
      participants: this.participants.map((identity) => ({ identity, muted: false, ...(this.paths[identity] ? { path: this.paths[identity] } : {}) })),
      full: false,
      ...(this.callId ? { callId: this.callId } : {}),
    };
  }
  async joinCall() {
    return this.state();
  }
  async leaveCall() {
    this.left++;
    return null;
  }
  async setMuted(m: boolean) {
    this.muted.push(m);
    return null;
  }
  async sendSignal(to: Id, kind: SignalKind, payload: string) {
    this.sent.push({ to, kind, payload });
    this.wire?.(to, kind, payload);
    return null;
  }
  onState(h: (s: CallState) => void) {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }
  onSignal(h: (s: CallSignal) => void) {
    this.signalHandlers.add(h);
    return () => this.signalHandlers.delete(h);
  }
  emitState(s: CallState) {
    for (const h of this.stateHandlers) h(s);
  }
  emitSignal(s: CallSignal) {
    for (const h of this.signalHandlers) h(s);
  }
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Two engines whose cores pass signals to each other, as two verifying cores would. */
function pair(ids: [Id, Id] = [A, B], opts: Omit<VoiceEngineOptions, 'env'> = {}, xEnv: Parameters<typeof fakeEnv>[0] = {}) {
  const [x, y] = ids;
  const hx = fakeEnv(xEnv);
  const hy = fakeEnv();
  const cx = new FakeCore(x, [x, y]);
  const cy = new FakeCore(y, [y, x]);
  cx.wire = (to, kind, payload) => to === y && setTimeout(() => cy.emitSignal({ from: x, kind, payload, fingerprintVerified: true }), 0);
  cy.wire = (to, kind, payload) => to === x && setTimeout(() => cx.emitSignal({ from: y, kind, payload, fingerprintVerified: true }), 0);
  const ex = createVoiceEngine(cx, { env: hx.env, stunUrl: 'stun:stun.example.test:3478', ...opts });
  const ey = createVoiceEngine(cy, { env: hy.env, stunUrl: 'stun:stun.example.test:3478', ...opts });
  return { hx, hy, cx, cy, ex, ey };
}

function record<T>(on: (cb: (p: T) => void) => unknown): T[] {
  const out: T[] = [];
  on((p) => out.push(p));
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  allPcs.length = 0;
  nextCandidates = null;
});

// ---- tests -------------------------------------------------------------------

describe('sdp helpers', () => {
  it('reads and normalises fingerprints, and wants exactly one', () => {
    expect(fingerprints('a=fingerprint:SHA-256 AB:CD\r\nx\na=fingerprint:sha-512 0a:0b')).toEqual(['sha-256 ab:cd', 'sha-512 0a:0b']);
    expect(soleFingerprint('v=0\r\na=fingerprint:sha-256 AB:CD\r\n')).toBe('sha-256 ab:cd');
    expect(soleFingerprint('v=0\r\n')).toBeNull();
    expect(soleFingerprint('a=fingerprint:sha-256 AB:CD\na=fingerprint:sha-256 AB:CE')).toBeNull();
    expect(soleFingerprint('a=fingerprint:md5 AB:CD')).toBeNull();
    // sha-256 or stronger only.
    expect(normalizeFingerprint('sha-1', 'AB:CD')).toBeNull();
    expect(normalizeFingerprint('sha-224', 'AB:CD')).toBeNull();
    expect(normalizeFingerprint('sha-384', 'AB:CD')).toBe('sha-384 ab:cd');
    expect(soleFingerprint('a=fingerprint:sha-1 AB:CD')).toBeNull();
    expect(soleFingerprint('a=fingerprint:sha-256 AB:CD extra')).toBeNull();
  });

  it('takes ICE servers from the configured STUN URL only, never a default', () => {
    expect(iceServersFor(undefined)).toEqual([]);
    expect(iceServersFor(null)).toEqual([]);
    expect(iceServersFor('')).toEqual([]);
    expect(iceServersFor('stun:stun.example.test:3478')).toEqual([{ urls: 'stun:stun.example.test:3478' }]);
    expect(iceServersFor('turn:turn.example.test')).toEqual([]);
    expect(iceServersFor('stun:user@host')).toEqual([]);
    expect(iceServersFor('https://example.test')).toEqual([]);
  });
});

describe('voice engine', () => {
  it('connects two peers: only the lower identity offers, media plays after the checks', async () => {
    const { hx, hy, cx, cy, ex, ey } = pair();
    const partsX = record<VoiceParticipant[]>((cb) => ex.on('participants', cb));
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();

    expect(cx.sent.map((s) => s.kind)).toEqual(['offer']);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer']);
    expect(hx.pcs).toHaveLength(1);
    expect(hy.pcs).toHaveLength(1);
    // Opus only, with the microphone, through the configured STUN server only.
    expect(hx.pcs[0]!.config.iceServers).toEqual([{ urls: 'stun:stun.example.test:3478' }]);
    expect(hx.pcs[0]!.transceivers[0]).toMatchObject({ direction: 'sendrecv', codecs: [{ mimeType: 'audio/opus' }] });
    expect(hx.audios).toHaveLength(1);
    expect(hy.audios).toHaveLength(1);
    expect(hx.audios[0]!.paused).toBe(false);
    expect(partsX.at(-1)).toEqual([
      { identity: A, state: 'connected' },
      { identity: B, state: 'connected' },
    ]);
  });

  it('G-84: deafen silences everyone, also audio that starts later, and undeafen plays it again', async () => {
    const { hx, hy, cx, cy, ex, ey } = pair();
    ex.setDeafened(true);
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    expect(hx.audios).toHaveLength(1);
    expect(hx.audios[0]!.muted).toBe(true); // connected while deafened
    expect(hy.audios[0]!.muted).toBe(false); // the other side is unaffected
    ex.setDeafened(false);
    expect(hx.audios[0]!.muted).toBe(false);
    ex.setDeafened(true);
    expect(hx.audios[0]!.muted).toBe(true);
  });

  it('G-73: a per-person volume applies now and to audio that starts later, clamped to 0..1', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    ex.setPeerVolume(B, 0.3); // before B connects
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    expect(hx.audios[0]!.volume).toBe(0.3);
    ex.setPeerVolume(B, 0.8);
    expect(hx.audios[0]!.volume).toBe(0.8);
    ex.setPeerVolume(B, 7);
    expect(hx.audios[0]!.volume).toBe(1);
    ex.setPeerVolume(B, -1);
    expect(hx.audios[0]!.volume).toBe(0);
    ex.setPeerVolume(B, Number.NaN);
    expect(hx.audios[0]!.volume).toBe(1);
  });

  it('G-72: a chosen mic that is gone at the start falls back to the default, once, and says which', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    const fallbacks = record<{ kind: string; deviceId: string }>((cb) => ex.on('deviceFallback', cb));
    await ex.setInputDevice('mic-gone'); // remembered from an earlier run
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    expect(hx.asked).toEqual(['mic-gone', undefined]);
    expect(fallbacks).toEqual([{ kind: 'input', deviceId: 'mic-gone' }]);
    expect(hx.pcs[0]!.transceivers[0]!.sender.track).toBe(hx.mics[0]!.tracks[0]); // still talking
  });

  it('G-72: unplugging the chosen mic or speaker mid-call switches to the default and says which', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    const fallbacks = record<{ kind: string; deviceId: string }>((cb) => ex.on('deviceFallback', cb));
    const changed = record<null>((cb) => ex.on('devicesChanged', cb));
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    await ex.setInputDevice('mic1');
    await ex.setOutputDevice('spk1');
    // A headset plugged in: nothing chosen is gone, only the lists changed.
    await hx.changeDevices([...hx.devices, { kind: 'audioinput', deviceId: 'mic2', label: 'Headset' } as MediaDeviceInfo]);
    expect(changed).toHaveLength(1);
    expect(fallbacks).toEqual([]);
    // Both chosen devices unplugged.
    await hx.changeDevices([{ kind: 'audioinput', deviceId: 'mic2', label: 'Headset' } as MediaDeviceInfo]);
    expect(fallbacks).toEqual([
      { kind: 'output', deviceId: 'spk1' },
      { kind: 'input', deviceId: 'mic1' },
    ]);
    expect(hx.asked.at(-1)).toBeUndefined(); // the default mic
    expect(hx.pcs[0]!.transceivers[0]!.sender.track).toBe(hx.mics.at(-1)!.tracks[0]);
  });

  it('G-72: hear myself plays my mic on my speaker, follows a new mic, and stops with the call', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    ex.setSelfMonitor(true); // not in a call: nothing
    expect(hx.audios).toHaveLength(0);
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    const before = hx.audios.length;
    ex.setSelfMonitor(true);
    expect(hx.audios).toHaveLength(before + 1);
    const monitor = hx.audios.at(-1)!;
    expect(monitor.srcObject).toBe(hx.mics[0]);
    await ex.setInputDevice('mic1');
    expect(monitor.srcObject).toBe(hx.mics.at(-1));
    ex.detach();
    expect(monitor.srcObject).toBeNull();
    expect(monitor.paused).toBe(true);
  });

  it('G-73: Web Audio playback: each verified peer gets a gain into a limiter; 0..200%, deafen at 0', async () => {
    const { hx, cx, cy, ex, ey } = pair([A, B], {}, { webAudio: {} });
    ex.setPeerVolume(B, 1.5);
    await ex.attach(cx.state(), A);
    const ctx = hx.contexts[0] as FakeWebAudioContext;
    expect(ctx.gains).toHaveLength(0); // nothing from a peer before it is verified
    await ey.attach(cy.state(), B);
    await flush();
    expect(ctx.gains).toHaveLength(1);
    const [gain] = ctx.gains;
    const [limiter] = ctx.limiters;
    expect(gain!.gain.value).toBe(1.5);
    expect(gain!.out).toEqual([limiter]);
    expect(limiter!.out).toEqual([ctx.destination]);
    expect(limiter!.threshold.value).toBe(-3);
    expect(hx.audios[0]!.muted).toBe(true); // the element only feeds Web Audio
    ex.setPeerVolume(B, 5);
    expect(gain!.gain.value).toBe(2);
    ex.setDeafened(true);
    expect(gain!.gain.value).toBe(0);
    ex.setDeafened(false);
    expect(gain!.gain.value).toBe(2);
  });

  it('G-73: at 100% or less a peer stays on the element path (no Web Audio); above, a gain; back down, the element again', async () => {
    const { hx, cx, cy, ex, ey } = pair([A, B], {}, { webAudio: {} });
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    const ctx = hx.contexts[0] as FakeWebAudioContext;
    expect(ctx.gains).toHaveLength(0); // 100%: today's path
    expect(hx.audios[0]!.muted).toBe(false);
    ex.setPeerVolume(B, 0.6);
    expect(ctx.gains).toHaveLength(0);
    expect(hx.audios[0]!.volume).toBe(0.6);
    ex.setPeerVolume(B, 1.4);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.gains[0]!.gain.value).toBe(1.4);
    expect(hx.audios[0]!.muted).toBe(true);
    ex.setPeerVolume(B, 0.9);
    expect(ctx.gains[0]!.out).toEqual([]); // disconnected
    expect(hx.audios[0]!.muted).toBe(false);
    expect(hx.audios[0]!.volume).toBe(0.9);
  });

  it('G-73: a speaker the context cannot use falls back to the element path, capped at 100%', async () => {
    const { hx, cx, cy, ex, ey } = pair([A, B], {}, { webAudio: { sinkFails: true } });
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    ex.setPeerVolume(B, 1.6);
    const ctx = hx.contexts[0] as FakeWebAudioContext;
    expect(ctx.gains[0]!.gain.value).toBe(1.6);
    await ex.setOutputDevice('spk1');
    await flush();
    expect(ctx.gains[0]!.out).toEqual([]); // disconnected
    expect(hx.audios[0]!.muted).toBe(false);
    expect(hx.audios[0]!.volume).toBe(1);
    ex.setPeerVolume(B, 0.4);
    expect(hx.audios[0]!.volume).toBe(0.4);
    ex.setDeafened(true);
    expect(hx.audios[0]!.muted).toBe(true);
  });

  it('QA-21: the answerer sends its mic on the offer\'s m-line (sendrecv), so audio flows both ways', async () => {
    const { hx, hy, cx, cy, ex, ey } = pair();
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    const answerer = hy.pcs[0]!;
    // One transceiver only: bound to m-line "0", sending the mic, Opus.
    expect(answerer.transceivers).toHaveLength(1);
    expect(answerer.transceivers[0]).toMatchObject({ mid: '0', direction: 'sendrecv', codecs: [{ mimeType: 'audio/opus' }] });
    expect(answerer.transceivers[0]!.sender.track).toBe(hy.mics[0]!.tracks[0]);
    expect(answerer.transceivers[0]!.sender.streams).toEqual([hy.mics[0]]);
    expect(cy.sent[0]!.payload).toContain('a=sendrecv');
    // Each side plays the other: the offerer hears the answerer too.
    expect(hx.audios).toHaveLength(1);
    expect(hy.audios).toHaveLength(1);
  });

  it('an answerer without a mic only receives, and a mic chosen later asks for a rejoin', async () => {
    const hx = fakeEnv();
    const hy = fakeEnv({ micError: 'NotAllowedError' });
    const cx = new FakeCore(A, [A, B]);
    const cy = new FakeCore(B, [B, A]);
    cx.wire = (to, kind, payload) => to === B && setTimeout(() => cy.emitSignal({ from: A, kind, payload, fingerprintVerified: true }), 0);
    cy.wire = (to, kind, payload) => to === A && setTimeout(() => cx.emitSignal({ from: B, kind, payload, fingerprintVerified: true }), 0);
    const ex = createVoiceEngine(cx, { env: hx.env });
    const ey = createVoiceEngine(cy, { env: hy.env });
    const errors = record<VoiceError>((cb) => ey.on('error', cb));
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    expect(hy.pcs[0]!.transceivers).toHaveLength(1);
    expect(hy.pcs[0]!.transceivers[0]).toMatchObject({ mid: '0', direction: 'recvonly' });
    expect(hy.pcs[0]!.transceivers[0]!.sender.track).toBeNull();
    expect(hy.audios).toHaveLength(1); // B hears A
    expect(hx.audios).toHaveLength(0); // A gets nothing from B, as expected
    await ey.setInputDevice('mic1');
    expect(errors).toEqual([{ code: 'mic-denied' }, { code: 'rejoin-to-talk' }]);
  });

  it('a new input device replaces the track the answerer sends', async () => {
    const { hy, cx, cy, ex, ey } = pair();
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    await ey.setInputDevice('mic1');
    expect(hy.pcs[0]!.transceivers[0]!.sender.track).toBe(hy.mics[1]!.tracks[0]);
  });

  it('the answerer sets any extra offered m-lines (video, a 2nd audio) inactive and closes data channels', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), B);
    const extra =
      `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\na=setup:actpass\r\n` +
      'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendrecv\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=sendrecv\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:2\r\na=sendrecv\r\n' +
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:3\r\n';
    core.emitSignal({ from: A, kind: 'offer', payload: extra, fingerprintVerified: true });
    await flush();
    const pc = h.pcs[0]!;
    expect(core.sent.map((s) => s.kind)).toEqual(['answer']);
    expect(pc.transceivers.map((t) => [t.mid, t.receiver.track.kind, t.direction])).toEqual([
      ['0', 'video', 'inactive'],
      ['1', 'audio', 'sendrecv'],
      ['2', 'audio', 'inactive'],
    ]);
    expect(pc.transceivers[1]!.sender.track).toBe(h.mics[0]!.tracks[0]);
    expect(pc.transceivers.filter((t) => t.sender.track).length).toBe(1); // the mic goes out once
    // A data channel the peer opens is closed at once.
    const channel = { closed: false, close() { this.closed = true; } };
    (pc as unknown as { ondatachannel: (e: { channel: typeof channel }) => void }).ondatachannel({ channel });
    expect(channel.closed).toBe(true);
    engine.dispose();
  });

  it('the answerer drops an offer without an audio m-line', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), B);
    core.emitSignal({ from: A, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`, fingerprintVerified: true });
    await flush();
    expect(h.pcs[0]!.closed).toBe(true);
    expect(core.sent).toEqual([]);
    expect(errors).toEqual([{ code: 'peer-failed', peer: A }]);
  });

  it('glare: an offer from the higher identity is ignored by the lower one', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), A);
    await flush();
    expect(core.sent.map((s) => [s.to, s.kind])).toEqual([[B, 'offer']]);

    // B offers too (it got the rule wrong, or both raced): A keeps its own offer.
    core.emitSignal({ from: B, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`, fingerprintVerified: true });
    await flush();
    expect(core.sent.map((s) => s.kind)).toEqual(['offer']);
    expect(h.pcs).toHaveLength(1);
    expect(h.pcs[0]!.signalingState).toBe('have-local-offer');
  });

  it('the higher identity waits for the offer instead of sending one', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A, C]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), B);
    await flush();
    // B < C, so B offers to C; A < B, so B waits for A.
    expect(core.sent.map((s) => [s.to, s.kind])).toEqual([[C, 'offer']]);
  });

  it('drops a peer whose signal is not fingerprint-verified', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), B);

    core.emitSignal({ from: A, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`, fingerprintVerified: false });
    await flush();
    expect(h.pcs).toHaveLength(0);
    expect(core.sent).toEqual([]);
    expect(errors).toEqual([{ code: 'unverified-signal', peer: A }]);

    // Refused for the rest of the call, even with a verified one later.
    core.emitSignal({ from: A, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`, fingerprintVerified: true });
    await flush();
    expect(h.pcs).toHaveLength(0);
  });

  it('an unverified signal closes an existing connection to that peer', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), A);
    await flush();
    expect(h.pcs).toHaveLength(1);
    core.emitSignal({ from: B, kind: 'ice', payload: '{"candidate":"candidate:1 1 udp 1 192.0.2.1 9 typ host"}', fingerprintVerified: false });
    await flush();
    expect(h.pcs[0]!.closed).toBe(true);
    expect(h.pcs[0]!.candidates).toEqual([]);
  });

  it('ignores signals from someone not in the call', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), B);
    core.emitSignal({ from: '0'.repeat(64), kind: 'offer', payload: `a=fingerprint:sha-256 ${newFingerprint()}`, fingerprintVerified: true });
    await flush();
    expect(h.pcs).toHaveLength(0);
  });

  it('drops a peer whose SDP names no single fingerprint, before applying it', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), B);
    const twoFps = `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`;
    core.emitSignal({ from: A, kind: 'offer', payload: twoFps, fingerprintVerified: true });
    await flush();
    expect(h.pcs[0]!.closed).toBe(true);
    expect(h.pcs[0]!.remoteDescription).toBeNull();
    expect(core.sent).toEqual([]);
    expect(errors).toEqual([{ code: 'fingerprint-mismatch', peer: A }]);
  });

  it('drops a peer when the applied SDP differs from the verified fingerprint', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), B);
    const swap = newFingerprint();
    const realCreate = h.env.createPeerConnection;
    h.env.createPeerConnection = (c) => {
      const pc = realCreate(c) as unknown as FakePC;
      pc.rewriteRemote = (sdp) => sdp.replace(/a=fingerprint:sha-256 \S+/, `a=fingerprint:sha-256 ${swap}`);
      return pc as unknown as RTCPeerConnection;
    };
    core.emitSignal({ from: A, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`, fingerprintVerified: true });
    await flush();
    expect(h.pcs[0]!.closed).toBe(true);
    expect(core.sent).toEqual([]);
    expect(errors).toEqual([{ code: 'fingerprint-mismatch', peer: A }]);
  });

  it('drops a peer that presents a different DTLS certificate, before playing its audio', async () => {
    const { hx, hy, cx, cy, ex, ey } = pair();
    const errors = record<VoiceError>((cb) => ey.on('error', cb));
    const realCreate = hy.env.createPeerConnection;
    hy.env.createPeerConnection = (c) => {
      const pc = realCreate(c) as unknown as FakePC;
      pc.presentedFingerprint = newFingerprint(); // a man in the middle's certificate
      return pc as unknown as RTCPeerConnection;
    };
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    expect(hy.pcs[0]!.closed).toBe(true);
    expect(hy.audios).toEqual([]); // nothing from that peer was ever played
    expect(errors).toEqual([{ code: 'fingerprint-mismatch', peer: A }]);
    expect(hx.audios).toHaveLength(1); // A's side checks on its own
  });

  for (const mode of ['none', 'throw'] as const) {
    it(`fails closed when the certificate can't be read (getStats: ${mode})`, async () => {
      const { hy, cx, cy, ex, ey } = pair();
      const errors = record<VoiceError>((cb) => ey.on('error', cb));
      const realCreate = hy.env.createPeerConnection;
      hy.env.createPeerConnection = (c) => {
        const pc = realCreate(c) as unknown as FakePC;
        pc.statsMode = mode;
        return pc as unknown as RTCPeerConnection;
      };
      await ex.attach(cx.state(), A);
      await ey.attach(cy.state(), B);
      await flush();
      expect(hy.pcs[0]!.closed).toBe(true);
      expect(hy.audios).toEqual([]);
      expect(errors).toEqual([{ code: 'fingerprint-mismatch', peer: A }]);
    });
  }

  it('caps the trickled ICE candidates a peer can send, in total', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env, answerTimeoutMs: 60_000 });
    await engine.attach(core.state(), A);
    await flush();
    const pc = h.pcs[0]!;
    const ice = (i: number) =>
      core.emitSignal({
        from: B,
        kind: 'ice',
        payload: JSON.stringify({ candidate: `candidate:${i} 1 udp 1 192.0.2.${i % 250} 9 typ host`, sdpMid: '0' }),
        fingerprintVerified: true,
      });
    for (let i = 0; i < 20; i++) ice(i); // before the answer: queued
    await flush();
    core.emitSignal({ from: B, kind: 'answer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\n`, fingerprintVerified: true });
    await flush();
    for (let i = 20; i < 100; i++) ice(i); // after: applied, up to the cap
    await flush();
    expect(pc.candidates).toHaveLength(32);
    engine.dispose();
  });

  it('leave closes every connection, stops the mic and tells the core', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    const parts = record<VoiceParticipant[]>((cb) => ex.on('participants', cb));
    await ex.join(CH);
    await ey.attach(cy.state(), B);
    await flush();
    expect(hx.pcs).toHaveLength(1);

    await ex.leave();
    expect(cx.left).toBe(1);
    expect(hx.pcs.every((pc) => pc.closed)).toBe(true);
    expect(hx.mics[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(hx.audios.every((a) => a.paused)).toBe(true);
    expect(hx.contexts.every((c) => c.closed)).toBe(true);
    expect(parts.at(-1)).toEqual([]);

    // Signals after leaving do nothing.
    cx.emitSignal({ from: B, kind: 'offer', payload: `a=fingerprint:sha-256 ${newFingerprint()}`, fingerprintVerified: true });
    await flush();
    expect(hx.pcs).toHaveLength(1);
  });

  it('follows call.state: a peer who leaves is closed, an empty state stops everything', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B, C]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), A);
    await flush();
    expect(h.pcs).toHaveLength(2);
    core.emitState({ channelId: CH, participants: [{ identity: A, muted: false }, { identity: C, muted: false }], full: false });
    expect(h.pcs[0]!.closed).toBe(true);
    expect(h.pcs[1]!.closed).toBe(false);
    core.emitState({ channelId: CH, participants: [], full: false });
    expect(h.pcs[1]!.closed).toBe(true);
    expect(h.mics[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('mute disables the mic track and tells the core; setMicMuted only the track', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), A);
    const track = h.mics[0]!.tracks[0]!;
    await engine.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(core.muted).toEqual([true]);
    engine.setMicMuted(false);
    expect(track.enabled).toBe(true);
    expect(core.muted).toEqual([true]);
  });

  it('a changed input device keeps the mute state and replaces the sent track', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    await engine.attach(core.state(), A);
    await flush();
    engine.setMicMuted(true);
    await engine.setInputDevice('mic1');
    const [old, next] = h.mics;
    expect(old!.tracks[0]!.stopped).toBe(true);
    expect(next!.tracks[0]!.enabled).toBe(false);
    expect(h.pcs[0]!.senders[0]!.track).toBe(next!.tracks[0]);
    expect(await engine.listInputDevices()).toEqual([{ deviceId: 'mic1', label: 'Mic' }]);
    expect(await engine.listOutputDevices()).toEqual([{ deviceId: 'spk1', label: 'audiooutput 1' }]);
  });

  it('without a microphone it reports why and still listens', async () => {
    const h = fakeEnv({ micError: 'NotAllowedError' });
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), A);
    await flush();
    expect(errors).toEqual([{ code: 'mic-denied' }]);
    expect(h.pcs[0]!.transceivers[0]!.direction).toBe('recvonly');
  });

  it('speaking: a level over the threshold, held briefly; never while muted', async () => {
    vi.useFakeTimers();
    const h = fakeEnv();
    const core = new FakeCore(A, [A]);
    const engine = createVoiceEngine(core, { env: h.env });
    const events = record<Record<Id, boolean>>((cb) => engine.on('speaking', cb));
    await engine.attach(core.state(), A);
    const mic = h.contexts[0]!.analysers[0]!;

    mic.level = 0.2;
    await vi.advanceTimersByTimeAsync(100);
    expect(events.at(-1)?.[A]).not.toBe(true); // not yet: 150 ms first (G-82)
    await vi.advanceTimersByTimeAsync(200);
    expect(events.at(-1)).toEqual({ [A]: true });
    mic.level = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(events.at(-1)).toEqual({ [A]: true }); // held
    await vi.advanceTimersByTimeAsync(400);
    expect(events.at(-1)).toEqual({ [A]: false });

    mic.level = 0.2;
    engine.setMicMuted(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(events.at(-1)).toEqual({ [A]: false });
  });

  it('a lost first offer: the answerer attaches 1 s late and the pair still connects', async () => {
    vi.useFakeTimers();
    const { hx, hy, cx, cy, ex, ey } = pair();
    const errors = record<VoiceError>((cb) => ex.on('error', cb));
    await ex.attach(cx.state(), A);
    await vi.advanceTimersByTimeAsync(10);
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer']); // lost: B isn't attached yet
    expect(cy.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await ey.attach(cy.state(), B);
    await vi.advanceTimersByTimeAsync(4_500); // past the 5 s answer timeout
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer', 'offer']);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer']);
    expect(hx.pcs).toHaveLength(2);
    expect(hx.pcs[0]!.closed).toBe(true);
    expect(hx.pcs[1]!.connectionState).toBe('connected');
    expect(hx.audios).toHaveLength(1);
    expect(hy.audios).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000); // connected: no more offers, no failure
    expect(cx.sent).toHaveLength(2);
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('gives up after 3 offers with backoff, as peer-failed', async () => {
    vi.useFakeTimers();
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), A);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(core.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200); // 5 s: second offer
    expect(core.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_800);
    expect(core.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300); // +10 s: third offer
    expect(core.sent).toHaveLength(3);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000); // +20 s: give up
    expect(core.sent).toHaveLength(3);
    expect(errors).toEqual([{ code: 'peer-failed', peer: B }]);
    expect(h.pcs.every((pc) => pc.closed)).toBe(true);
    engine.dispose();
  });

  it('the answerer drops a connection that stays connecting, as peer-failed', async () => {
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env, connectTimeoutMs: 300 });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), B);
    const realCreate = h.env.createPeerConnection;
    h.env.createPeerConnection = (c) => {
      const pc = realCreate(c) as unknown as FakePC;
      pc.setLocalDescription = async (d) => void (pc.localDescription = d); // never connects
      return pc as unknown as RTCPeerConnection;
    };
    core.emitSignal({ from: A, kind: 'offer', payload: audioOffer(), fingerprintVerified: true });
    await flush();
    expect(h.pcs[0]!.closed).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.pcs[0]!.closed).toBe(true);
    expect(errors).toEqual([{ code: 'peer-failed', peer: A }]);
    engine.dispose();
  });

  it('a mic chosen after starting without one asks for a rejoin', async () => {
    const h = fakeEnv({ micError: 'NotFoundError' });
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), A);
    await engine.setInputDevice('mic1');
    expect(errors).toEqual([{ code: 'no-device' }, { code: 'rejoin-to-talk' }]);
    engine.dispose();
  });

  it('a failed offer send is retried, not the end of the re-offers', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    const errors = record<VoiceError>((cb) => ex.on('error', cb));
    const realSend = cx.sendSignal.bind(cx);
    let failures = 1;
    cx.sendSignal = async (to, kind, payload) => {
      if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'internal' });
      return realSend(to, kind, payload);
    };
    await ey.attach(cy.state(), B);
    await ex.attach(cx.state(), A);
    await flush();
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer']); // the 2nd attempt; the 1st threw
    expect(hx.pcs).toHaveLength(2);
    expect(hx.pcs[0]!.closed).toBe(true);
    expect(hx.pcs[1]!.connectionState).toBe('connected');
    expect(errors).toEqual([]);
  });

  it('an answer that fails to apply leads to a re-offer', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    const errors = record<VoiceError>((cb) => ex.on('error', cb));
    const realCreate = hx.env.createPeerConnection;
    let first = true;
    hx.env.createPeerConnection = (c) => {
      const pc = realCreate(c) as unknown as FakePC;
      if (first) {
        first = false;
        pc.setRemoteDescription = async () => {
          throw new Error('bad answer');
        };
      }
      return pc as unknown as RTCPeerConnection;
    };
    await ey.attach(cy.state(), B);
    await ex.attach(cx.state(), A);
    await flush(20);
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer', 'offer']);
    expect(hx.pcs[1]!.connectionState).toBe('connected');
    expect(errors).toEqual([]);
  });

  it('gives up as peer-failed when every offer send fails', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    core.sendSignal = async () => {
      throw new Error('down');
    };
    const engine = createVoiceEngine(core, { env: h.env });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), A);
    await flush();
    expect(h.pcs).toHaveLength(3);
    expect(h.pcs.every((pc) => pc.closed)).toBe(true);
    expect(errors).toEqual([{ code: 'peer-failed', peer: B }]);
    engine.dispose();
  });

  it('dispose unsubscribes from the core', async () => {
    const core = new FakeCore(A, [A]);
    const engine = createVoiceEngine(core, { env: fakeEnv().env });
    expect(core.stateHandlers.size).toBe(1);
    engine.dispose();
    expect(core.stateHandlers.size).toBe(0);
    expect(core.signalHandlers.size).toBe(0);
  });
});

// ---- TURN (G-81) ------------------------------------------------------------------

const TURN_HOST = 'turn.example.test';
/** Credentials as the relay would mint them (mocked until the core api exists). */
function turnCreds(ttl = 600, now = Date.now(), tag = 'abcdEFGH1234') {
  return {
    urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`, `turns:${TURN_HOST}:5349`],
    username: `${Math.floor(now / 1000) + ttl}:${tag}`,
    credential: `c2VjcmV0${tag}=`,
    ttl,
    expiresAt: now + ttl * 1000,
  };
}
const turnServer = (c: { username: string }) => (pc: FakePC) =>
  (pc.config.iceServers ?? []).find((s) => (s as RTCIceServer).username === c.username);

describe('TURN credentials (cleanTurnCredentials)', () => {
  const now = Date.now();
  const ok = turnCreds(600, now);
  const clean = (patch: Record<string, unknown>, host: string | null = TURN_HOST) => cleanTurnCredentials({ ...ok, ...patch }, host, now);

  it('accepts well-formed credentials for the configured host', () => {
    expect(cleanTurnCredentials(ok, TURN_HOST, now)).toEqual(ok);
    expect(cleanTurnCredentials(ok, 'TURN.Example.Test', now)).toEqual(ok); // host case does not matter
  });

  it('pins the URLs: exact host, allowed ports, transport= only', () => {
    expect(clean({}, null)).toBeNull(); // no configured relay host: no TURN
    expect(clean({ urls: ['turn:evil.example.test:3478'] })).toBeNull();
    expect(clean({ urls: [`turn:${TURN_HOST}.evil.test:3478`] })).toBeNull();
    expect(clean({ urls: [`turn:x.${TURN_HOST}:3478`] })).toBeNull();
    expect(clean({ urls: [`turn:${TURN_HOST}:3479`] })).toBeNull();
    expect(clean({ urls: [`turn:${TURN_HOST}`] })).toBeNull(); // the port is required
    expect(clean({ urls: [`turn:${TURN_HOST}:3478?transport=udp&x=1`] })).toBeNull();
    expect(clean({ urls: [`turn:${TURN_HOST}:3478?transport=sctp`] })).toBeNull();
    expect(clean({ urls: [`stun:${TURN_HOST}:3478`] })).toBeNull();
    expect(clean({ urls: [`turn:user@${TURN_HOST}:3478`] })).toBeNull();
    expect(clean({ urls: [] })).toBeNull();
    expect(clean({ urls: Array(5).fill(`turn:${TURN_HOST}:3478`) })).toBeNull();
    expect(clean({ urls: [`turns:${TURN_HOST}:443?transport=tcp`] })?.urls).toEqual([`turns:${TURN_HOST}:443?transport=tcp`]);
  });

  it('wants <expiry>:<random> (never a peer id), a plain credential, a sane ttl and expiry', () => {
    expect(clean({ username: 'a'.repeat(64) })).toBeNull();
    expect(clean({ username: `1800000000:${'a'.repeat(64)}:x` })).toBeNull();
    expect(clean({ username: 'x'.repeat(300) })).toBeNull();
    // expiry:<an identity or peer id> is refused too (N8b).
    expect(clean({ username: `1800000000:${'ab'.repeat(32)}` })).toBeNull();
    expect(clean({ username: '1800000000:12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc' })).toBeNull();
    expect(clean({ username: '1800000000:QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N' })).toBeNull();
    expect(clean({ username: `1800000000:${'ab'.repeat(31)}` })?.username).toBe(`1800000000:${'ab'.repeat(31)}`); // not 64: fine
    expect(clean({ credential: '' })).toBeNull();
    expect(clean({ credential: 'has space' })).toBeNull();
    expect(clean({ credential: 'x'.repeat(257) })).toBeNull();
    expect(clean({ ttl: 30 })).toBeNull();
    expect(clean({ ttl: 100_000 })).toBeNull();
    expect(clean({ ttl: 600.5 })).toBeNull();
    expect(clean({ expiresAt: now - 1 })).toBeNull();
    expect(clean({ expiresAt: now + 3_600_000 })).toBeNull(); // beyond its own ttl
    expect(cleanTurnCredentials(null, TURN_HOST, now)).toBeNull();
    expect(cleanTurnCredentials('turn:x', TURN_HOST, now)).toBeNull();
  });

  it('iceServersFor: STUN, then TURN with its credentials', () => {
    expect(iceServersFor('stun:stun.example.test:3478', ok)).toEqual([
      { urls: 'stun:stun.example.test:3478' },
      { urls: ok.urls, username: ok.username, credential: ok.credential },
    ]);
    expect(iceServersFor(null, ok)).toEqual([{ urls: ok.urls, username: ok.username, credential: ok.credential }]);
  });
});

describe('voice engine with TURN', () => {
  it('off by default: never asks the core, STUN only', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const ask = vi.fn(async () => turnCreds());
    core.getTurnCredentials = ask;
    const engine = createVoiceEngine(core, { env: h.env, stunUrl: 'stun:stun.example.test:3478', turnHost: TURN_HOST });
    await engine.attach(core.state(), A);
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(h.pcs[0]!.config.iceServers).toEqual([{ urls: 'stun:stun.example.test:3478' }]);
    engine.dispose();
  });

  it('on: the first connection already has TURN', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const c = turnCreds();
    core.getTurnCredentials = async () => c;
    const engine = createVoiceEngine(core, { env: h.env, stunUrl: 'stun:stun.example.test:3478', enableTurn: true, turnHost: TURN_HOST });
    await engine.attach(core.state(), A);
    await flush();
    expect(h.pcs).toHaveLength(1);
    expect(h.pcs[0]!.config.iceServers).toEqual([
      { urls: 'stun:stun.example.test:3478' },
      { urls: c.urls, username: c.username, credential: c.credential },
    ]);
    engine.dispose();
  });

  const failures: [string, () => Promise<unknown>][] = [
    ['rejects', async () => Promise.reject(Object.assign(new Error('x'), { code: 'not-implemented' }))],
    ['never answers (2 s, then without)', () => new Promise<never>(() => {})],
    ['answers for another host', async () => ({ ...turnCreds(), urls: ['turn:evil.example.test:3478'] })],
  ];
  for (const [name, ask] of failures) {
    it(`goes on without TURN when the core ${name}`, async () => {
      vi.useFakeTimers();
      const h = fakeEnv();
      const core = new FakeCore(A, [A, B]);
      core.getTurnCredentials = ask;
      const engine = createVoiceEngine(core, { env: h.env, enableTurn: true, turnHost: TURN_HOST });
      const errors = record<VoiceError>((cb) => engine.on('error', cb));
      const attached = engine.attach(core.state(), A);
      await vi.advanceTimersByTimeAsync(2_100);
      await attached;
      expect(h.pcs).toHaveLength(1);
      expect(h.pcs[0]!.config.iceServers).toEqual([]);
      expect(errors).toEqual([]);
      engine.dispose();
    });
  }

  it('caches the credentials until 80% of the ttl: a second call does not ask again', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const c = turnCreds(600);
    const ask = vi.fn(async () => c);
    core.getTurnCredentials = ask;
    const engine = createVoiceEngine(core, { env: h.env, enableTurn: true, turnHost: TURN_HOST });
    await engine.attach(core.state(), A);
    engine.detach();
    await engine.attach(core.state(), A);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(turnServer(c)(h.pcs.at(-1)!)).toBeTruthy();
    engine.dispose();
  });

  it('refresh at 80% of the ttl: new servers on every connection, only the offerer restarts ICE, same connection', async () => {
    vi.useFakeTimers();
    const { hx, hy, cx, cy, ex, ey } = pair([A, B], { enableTurn: true, turnHost: TURN_HOST });
    let n = 0;
    const issued: ReturnType<typeof turnCreds>[] = [];
    const mint = async () => {
      const c = turnCreds(100, Date.now(), `tag${++n}xxxxxx`);
      issued.push(c);
      return c;
    };
    cx.getTurnCredentials = mint;
    cy.getTurnCredentials = mint;
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await vi.advanceTimersByTimeAsync(50);
    expect(hx.pcs).toHaveLength(1);
    expect(hy.pcs).toHaveLength(1);
    expect(hx.audios).toHaveLength(1);
    expect(issued).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(80_000); // 80% of 100 s
    expect(issued).toHaveLength(4);
    const offerer = hx.pcs[0]!;
    const answerer = hy.pcs[0]!;
    const fresh = (pc: FakePC) => !!(turnServer(issued[2]!)(pc) ?? turnServer(issued[3]!)(pc));
    expect(fresh(offerer)).toBe(true);
    expect(fresh(answerer)).toBe(true);
    expect(offerer.configs).toHaveLength(1);
    expect(answerer.configs).toHaveLength(1);
    expect(offerer.restarts).toBe(1);
    expect(answerer.restarts).toBe(0);
    // The offerer renegotiated on the same connection; the answerer answered on it.
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer', 'offer']);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer', 'answer']);
    expect(hx.pcs).toHaveLength(1);
    expect(hy.pcs).toHaveLength(1);
    expect(offerer.closed || answerer.closed).toBe(false);
    expect(hx.audios).toHaveLength(1);
    ex.dispose();
    ey.dispose();
  });

  it('never puts the credentials in an event, even when fetching fails', async () => {
    vi.useFakeTimers();
    const { cx, cy, ex, ey } = pair([A, B], { enableTurn: true, turnHost: TURN_HOST });
    const c = turnCreds(100);
    cx.getTurnCredentials = async () => c;
    cy.getTurnCredentials = async () => Promise.reject(new Error(`${c.username} ${c.credential}`));
    const seen: unknown[] = [];
    for (const e of [ex, ey]) {
      e.on('participants', (p) => seen.push(p));
      e.on('speaking', (p) => seen.push(p));
      e.on('error', (p) => seen.push(p));
    }
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await vi.advanceTimersByTimeAsync(81_000);
    const text = JSON.stringify(seen) + JSON.stringify(await ex.connectionTypes());
    expect(seen.length).toBeGreaterThan(0);
    expect(text).not.toContain(c.credential);
    expect(text).not.toContain(c.username);
    ex.dispose();
    ey.dispose();
  });

  it('connectionTypes: the selected pair candidate types, never addresses', async () => {
    const { hx, cx, cy, ex, ey } = pair();
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    await flush();
    hx.pcs[0]!.pairTypes = ['relay', 'srflx'];
    const types = await ex.connectionTypes();
    expect(types).toEqual({ [B]: { local: 'relay', remote: 'srflx' } });
    expect(JSON.stringify(types)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

// ---- ICE restart: a call that survives a network change ---------------------------

describe('voice engine: ICE restart on a network change', () => {
  /** The connection's ICE path drops, as on a Wi-Fi/LAN switch or a VPN toggle. */
  const drop = (pc: FakePC, state: RTCPeerConnectionState = 'disconnected') => {
    pc.connectionState = state;
    (pc.onconnectionstatechange as (() => void) | null)?.();
  };

  async function connectedPair() {
    vi.useFakeTimers();
    const p = pair();
    const errors = record<VoiceError>((cb) => p.ex.on('error', cb));
    const errorsY = record<VoiceError>((cb) => p.ey.on('error', cb));
    const partsX = record<VoiceParticipant[]>((cb) => p.ex.on('participants', cb));
    await p.ex.attach(p.cx.state(), A);
    await p.ey.attach(p.cy.state(), B);
    await vi.advanceTimersByTimeAsync(50);
    expect(p.hx.pcs[0]!.connectionState).toBe('connected');
    expect(p.cx.sent.map((s) => s.kind)).toEqual(['offer']);
    return { ...p, errors, errorsY, partsX };
  }

  it('a dropped call restarts ICE on the same connection and comes back', async () => {
    const { hx, hy, cx, cy, ex, ey, errors, errorsY, partsX } = await connectedPair();
    drop(hx.pcs[0]!);
    drop(hy.pcs[0]!);
    await vi.advanceTimersByTimeAsync(1_900); // within the 2 s grace: nothing yet
    expect(hx.pcs[0]!.restarts).toBe(0);
    const before = partsX.length;
    await vi.advanceTimersByTimeAsync(150);
    // Shown as reconnecting while it restarted.
    expect(partsX.slice(before).some((list) => list.some((p) => p.identity === B && p.state === 'connecting'))).toBe(true);
    // The offerer (A, the lower identity) restarted and re-offered; B answered on the same connection.
    expect(hx.pcs[0]!.restarts).toBe(1);
    expect(hy.pcs[0]!.restarts).toBe(0);
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer', 'offer']);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer', 'answer']);
    expect(hx.pcs).toHaveLength(1);
    expect(hy.pcs).toHaveLength(1);
    expect(hx.pcs[0]!.connectionState).toBe('connected');
    expect(partsX.at(-1)).toContainEqual({ identity: B, state: 'connected' });
    expect(hx.audios).toHaveLength(1); // the same audio, not a second player
    // Recovered: no give-up later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors).toEqual([]);
    expect(errorsY).toEqual([]);
    expect(cx.sent).toHaveLength(2);
    ex.dispose();
    ey.dispose();
  });

  it('a network change (online, another interface) restarts at once, before ICE notices', async () => {
    const { hx, cx, cy, ex, ey, errors } = await connectedPair();
    hx.changeNetwork();
    await vi.advanceTimersByTimeAsync(50);
    expect(hx.pcs[0]!.restarts).toBe(1);
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer', 'offer']);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer', 'answer']);
    expect(hx.pcs[0]!.connectionState).toBe('connected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('the answerer never offers (glare): it waits for the offerer, whose restart brings it back', async () => {
    const { hx, hy, cy, ex, ey, errorsY } = await connectedPair();
    drop(hy.pcs[0]!);
    hy.changeNetwork();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hy.pcs[0]!.restarts).toBe(0);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer']);
    // The offerer's side notices too and restarts (after its 2 s grace).
    drop(hx.pcs[0]!);
    await vi.advanceTimersByTimeAsync(2_050);
    expect(cy.sent.map((s) => s.kind)).toEqual(['answer', 'answer']);
    expect(hy.pcs[0]!.connectionState).toBe('connected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errorsY).toEqual([]); // the answerer's give-up timer was cleared
    ex.dispose();
    ey.dispose();
  });

  it('a short "disconnected" that comes back within 2 s restarts nothing', async () => {
    const { hx, hy, cx, ex, ey, errors } = await connectedPair();
    drop(hx.pcs[0]!);
    drop(hy.pcs[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    drop(hx.pcs[0]!, 'connected');
    drop(hy.pcs[0]!, 'connected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hx.pcs[0]!.restarts).toBe(0);
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer']);
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('a restart answer naming another certificate is refused before it is applied (pinned fingerprint)', async () => {
    const { hx, hy, cx, cy, ex, ey, errors } = await connectedPair();
    // B's side answers the restart with another certificate (a man in the middle).
    const realSend = cy.sendSignal.bind(cy);
    cy.wire = null;
    cy.sendSignal = async (to, kind, payload) => {
      const swapped = payload.replace(/a=fingerprint:sha-256 \S+/, `a=fingerprint:sha-256 ${newFingerprint()}`);
      setTimeout(() => cx.emitSignal({ from: B, kind, payload: swapped, fingerprintVerified: true }), 0);
      return realSend(to, kind, payload);
    };
    const offerer = hx.pcs[0]!;
    const remoteBefore = offerer.remoteDescription;
    drop(offerer, 'failed');
    drop(hy.pcs[0]!, 'failed');
    await vi.advanceTimersByTimeAsync(50);
    expect(offerer.restarts).toBe(1);
    expect(errors).toEqual([{ code: 'fingerprint-mismatch', peer: B }]);
    expect(offerer.closed).toBe(true);
    expect(offerer.remoteDescription).toBe(remoteBefore); // never applied
    ex.dispose();
    ey.dispose();
  });

  it('"failed" after a working call restarts too, instead of a new connection', async () => {
    const { hx, hy, cx, ex, ey, errors } = await connectedPair();
    drop(hx.pcs[0]!, 'failed');
    drop(hy.pcs[0]!, 'failed');
    await vi.advanceTimersByTimeAsync(50);
    expect(hx.pcs).toHaveLength(1);
    expect(hx.pcs[0]!.restarts).toBe(1);
    expect(cx.sent.map((s) => s.kind)).toEqual(['offer', 'offer']);
    expect(hx.pcs[0]!.connectionState).toBe('connected');
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('no path back: a fresh restart offer every 5 s, then after 15 s "no voice connection" on both sides', async () => {
    const { hx, hy, cx, cy, ex, ey, errors, errorsY } = await connectedPair();
    // The new network can't reach the other side: signalling still works, ICE never connects.
    hx.pcs[0]!.neverConnect = true;
    hy.pcs[0]!.neverConnect = true;
    drop(hx.pcs[0]!);
    drop(hy.pcs[0]!);
    await vi.advanceTimersByTimeAsync(2_050); // the 2 s grace, then the first restart
    expect(hx.pcs[0]!.restarts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hx.pcs[0]!.restarts).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hx.pcs[0]!.restarts).toBe(3);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000); // 15 s after the restart began
    expect(errors).toEqual([{ code: 'peer-failed', peer: B }]);
    expect(errorsY).toEqual([{ code: 'peer-failed', peer: A }]);
    expect(hx.pcs[0]!.closed && hy.pcs[0]!.closed).toBe(true);
    // Gone for good: no more offers.
    const offers = cx.sent.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cx.sent.length).toBe(offers);
    expect(cy.sent.every((s) => s.kind === 'answer')).toBe(true);
    ex.dispose();
    ey.dispose();
  });

  it('a network change outside a call does nothing', async () => {
    const h = fakeEnv();
    const core = new FakeCore(A, [A, B]);
    const engine = createVoiceEngine(core, { env: h.env });
    h.changeNetwork();
    expect(h.pcs).toHaveLength(0);
    expect(core.sent).toEqual([]);
    engine.dispose();
  });
});

// ---- G-81: diagnostics and stun-unreachable -----------------------------------------

describe('voice engine: G-81 diagnostics', () => {
  async function call(opts: Omit<VoiceEngineOptions, 'env'> = {}) {
    vi.useFakeTimers();
    const p = pair([A, B], opts);
    const errors = record<VoiceError>((cb) => p.ex.on('error', cb));
    const errorsY = record<VoiceError>((cb) => p.ey.on('error', cb));
    await p.ex.attach(p.cx.state(), A);
    await p.ey.attach(p.cy.state(), B);
    await vi.advanceTimersByTimeAsync(50);
    return { ...p, errors, errorsY };
  }

  /** Every string anywhere in a value: the diagnostics may only hold words from fixed sets. */
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];
  const ALLOWED = new Set([
    ...['host', 'srflx', 'prflx', 'relay', 'unknown'],
    ...['new', 'checking', 'connecting', 'connected', 'completed', 'failed', 'disconnected', 'closed'],
    ...['stun', 'stunAnswered', 'gatherWindowS', 'peers', 'state', 'ice', 'gathered', 'pair', 'local', 'remote', 'gatherMs', 'setupMs'],
    A,
    B,
  ]);

  it('counts my candidates by type, from candidate lines only', () => {
    const sdp =
      'v=0\r\na=candidate:1 1 udp 1 192.168.1.2 5 typ host\r\na=candidate:2 1 udp 1 abc.local 6 typ host generation 0\r\n' +
      'a=candidate:3 1 udp 1 203.0.113.9 7 typ srflx raddr 0.0.0.0 rport 0\r\na=candidate:4 1 udp 1 198.51.100.1 8 typ relay raddr x rport 1\r\n' +
      'a=x-note: typ srflx\r\na=candidate:5 1 udp 1 1.2.3.4 9 typ hostile\r\n';
    expect(candidateCounts(sdp)).toEqual({ host: 2, srflx: 1, prflx: 0, relay: 1 });
    expect(candidateCounts('')).toEqual({ host: 0, srflx: 0, prflx: 0, relay: 0 });
  });

  it('a connected call: STUN answered, the path, candidate counts and timings; no address anywhere', async () => {
    const { hx, ex, ey, errors, errorsY } = await call();
    hx.pcs[0]!.pairTypes = ['srflx', 'prflx'];
    const d = await ex.diagnostics();
    expect(d.stun).toBe(true);
    expect(d.stunAnswered).toBe(true);
    const peer = d.peers[B]!;
    expect(peer.state).toBe('connected');
    expect(peer.ice).toBe('connected');
    expect(peer.pair).toEqual({ local: 'srflx', remote: 'prflx' });
    expect(peer.gathered).toEqual({ host: 1, srflx: 1, prflx: 0, relay: 0 });
    expect(peer.setupMs).toEqual(expect.any(Number));
    expect(peer.gatherMs).toEqual(expect.any(Number));
    for (const s of strings(d)) expect(ALLOWED.has(s), s).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/192\.168|203\.0\.113|198\.51\.100|54321|61000/);
    expect(errors).toEqual([]);
    expect(errorsY).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('STUN configured but no srflx gathered: stun-unreachable once per call, and the panel says no answer', async () => {
    nextCandidates = ['candidate:1 1 udp 2122260223 192.168.1.23 54321 typ host generation 0'];
    const { hx, ex, ey, errors, errorsY } = await call();
    expect(errors).toEqual([{ code: 'stun-unreachable' }]);
    expect(errorsY).toEqual([{ code: 'stun-unreachable' }]);
    expect((await ex.diagnostics()).stunAnswered).toBe(false);
    // An ICE restart in the same call gathers again: no second report.
    hx.changeNetwork();
    await vi.advanceTimersByTimeAsync(50);
    expect(hx.pcs[0]!.restarts).toBe(1);
    expect(errors).toEqual([{ code: 'stun-unreachable' }]);
    ex.dispose();
    ey.dispose();
  });

  it('without a STUN server, no srflx is expected: no report, and stun is false', async () => {
    nextCandidates = ['candidate:1 1 udp 2122260223 192.168.1.23 54321 typ host generation 0'];
    const { ex, ey, errors } = await call({ stunUrl: null });
    expect(errors).toEqual([]);
    const d = await ex.diagnostics();
    expect(d.stun).toBe(false);
    expect(d.stunAnswered).toBeNull();
    ex.dispose();
    ey.dispose();
  });

  it('outside a call: no peers', async () => {
    const h = fakeEnv();
    const engine = createVoiceEngine(new FakeCore(A, [A, B]), { env: h.env, stunUrl: 'stun:stun.example.test:3478' });
    expect(await engine.diagnostics()).toEqual({ stun: true, stunAnswered: null, gatherWindowS: 3, peers: {} });
    engine.dispose();
  });

  it('fuzz: whatever the candidate lines and stats hold, the diagnostics hold only fixed words and numbers', async () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), Math.floor((seed / 2 ** 31) * n));
    const pick = <T,>(xs: T[]) => xs[rnd(xs.length)]!;
    const addr = () =>
      pick([
        `${rnd(256)}.${rnd(256)}.${rnd(256)}.${rnd(256)}`,
        `2001:db8::${rnd(9999).toString(16)}`,
        `${rnd(1e6).toString(36)}.local`,
        'relay.example.org',
        '"><img src=x>',
      ]);
    for (let run = 0; run < 25; run++) {
      nextCandidates = Array.from({ length: 1 + rnd(4) }, (_, i) =>
        `candidate:${i} 1 ${pick(['udp', 'tcp'])} ${rnd(1e9)} ${addr()} ${rnd(65536)} typ ${pick(['host', 'srflx', 'relay', 'prflx', 'bogus', addr()])} raddr ${addr()} rport ${rnd(65536)}`,
      );
      const { hx, ex, ey } = await call();
      const pc = hx.pcs[0]!;
      pc.pairTypes = [pick(['host', 'srflx', addr()]), pick(['relay', addr(), 'prflx'])];
      // SL D2: an address in every field a candidate stat can carry, and in stats of every other kind.
      const hostile = Object.fromEntries(
        ['address', 'ip', 'port', 'relatedAddress', 'relatedPort', 'url', 'foundation', 'usernameFragment', 'candidate', 'protocol', 'relayProtocol', 'networkType'].map((k) => [k, addr()]),
      );
      pc.statsExtra = hostile;
      pc.statsMore = [
        { type: 'local-candidate', candidateType: addr(), ...hostile },
        { type: 'candidate-pair', state: addr(), nominated: true, localCandidateId: 'X0', remoteCandidateId: 'L', ...hostile },
        { type: 'transport', iceState: addr(), selectedCandidatePairId: rnd(2) ? 'P' : 'X1', ...hostile },
      ];
      const d = await ex.diagnostics();
      for (const s of strings(d)) expect(ALLOWED.has(s), s).toBe(true);
      expect(JSON.stringify(d)).not.toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{0,4}:|\.local|example|<img/i);
      ex.dispose();
      ey.dispose();
      vi.useRealTimers();
      allPcs.length = 0;
    }
  });

  it('SL S1: relay-only never starts a call: no RTCPeerConnection, no microphone, offers ignored', async () => {
    vi.useFakeTimers();
    const h = fakeEnv();
    const core = new FakeCore(B, [B, A]);
    const engine = createVoiceEngine(core, { env: h.env, stunUrl: 'stun:stun.example.test:3478', relayOnly: true });
    const errors = record<VoiceError>((cb) => engine.on('error', cb));
    await engine.attach(core.state(), B);
    core.emitSignal({ from: A, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n`, fingerprintVerified: true });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.pcs).toHaveLength(0);
    expect(h.mics).toHaveLength(0);
    expect(core.sent).toEqual([]);
    expect(errors).toEqual([]);
    expect(await engine.diagnostics()).toEqual({ stun: true, stunAnswered: null, gatherWindowS: 3, peers: {} });
    engine.dispose();
  });
});

describe('SL S3: ICE servers only from a plain stun:host:port', () => {
  it('accepts one host (name, IPv4 or [IPv6]) with an optional port', () => {
    for (const ok of ['stun:stun.example.test:3478', 'stuns:stun.example.test:5349', 'STUN:stun.example.test', 'stun:198.51.100.7:3478', 'stun:[2001:db8::7]:3478'])
      expect(iceServersFor(ok), ok).toEqual([{ urls: ok }]);
  });
  it('refuses TURN, credentials, ?transport, paths, lists and bad ports', () => {
    for (const bad of [
      'turn:turn.example.test:3478',
      'turns:turn.example.test:5349',
      'stun:stun.example.test:3478?transport=udp',
      'stun:user:pass@stun.example.test:3478',
      'stun:user@stun.example.test',
      'stun:stun.example.test/path',
      'stun:a.example.test:3478,stun:b.example.test:3478',
      'stun:a.example.test:3478 stun:b.example.test:3478',
      'stun:stun.example.test:0',
      'stun:stun.example.test:65536',
      'stun:stun.example.test:3478:1',
      'stun:',
      'stun:' + 'a'.repeat(260),
    ])
      expect(iceServersFor(bad), bad).toEqual([]);
  });
});

// ---- G-81 B: the C2 switch (docs/design/g81-p2p-calls.md §2.2) ----------------------

describe('voice engine: G-81 C2 (LAN WebRTC, else media over the P2P network)', () => {
  const CALL_ID = 'c'.repeat(32);

  /** A fake mic and codec for MediaSession: push(n) makes the mic produce n frames. */
  function fakeMedia() {
    const queue: ({ close(): void } | null)[] = [];
    let wake: (() => void) | null = null;
    const env: MediaEnv = {
      readTrack: () => ({
        async read() {
          while (!queue.length) await new Promise<void>((r) => (wake = r));
          return queue.shift() as unknown as AudioData | null;
        },
        cancel() {
          queue.push(null);
          wake?.();
        },
      }),
      createEncoder: ({ output }) => {
        let n = 0;
        return {
          configure() {},
          encode: () => output({ byteLength: 60, timestamp: ++n * 40_000, copyTo: (d) => d.fill(7) }),
          close() {},
        };
      },
      createDecoder: ({ output }) => ({ configure() {}, decode: () => output({ numberOfFrames: 1920, copyTo: (d) => d.fill(0.1), close() {} }), close() {} }),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    return {
      env,
      async push(n: number) {
        for (let i = 0; i < n; i++) queue.push({ close() {} });
        wake?.();
        await vi.advanceTimersByTimeAsync(1);
      },
    };
  }

  async function call(path: CallPath | undefined, o: { relayOnly?: boolean; lanNeverConnects?: boolean } = {}) {
    vi.useFakeTimers();
    const hx = fakeEnv({ webAudio: {} });
    const hy = fakeEnv({ webAudio: {} });
    const cx = new FakeCore(A, [A, B]);
    const cy = new FakeCore(B, [B, A]);
    for (const c of [cx, cy]) {
      c.callId = CALL_ID;
      c.setCallWebrtcPeers = async (ids) => void c.webrtcPeers.push(ids);
    }
    if (path) {
      cx.paths[B] = path;
      cy.paths[A] = path;
    }
    cx.wire = (to, kind, payload) => to === B && setTimeout(() => cy.emitSignal({ from: A, kind, payload, fingerprintVerified: true }), 0);
    cy.wire = (to, kind, payload) => to === A && setTimeout(() => cx.emitSignal({ from: B, kind, payload, fingerprintVerified: true }), 0);
    const net = loopback([A, B], {}, (fn) => fn());
    const mx = fakeMedia();
    const my = fakeMedia();
    const opts = { stunUrl: null, p2p: true, relayOnly: o.relayOnly };
    const ex = createVoiceEngine(cx, { env: hx.env, ...opts, media: { transport: () => net[A]!, env: mx.env } });
    const ey = createVoiceEngine(cy, { env: hy.env, ...opts, media: { transport: () => net[B]!, env: my.env } });
    const errors = record<VoiceError>((cb) => ex.on('error', cb));
    const parts = record<VoiceParticipant[]>((cb) => ex.on('participants', cb));
    await ex.attach(cx.state(), A);
    await ey.attach(cy.state(), B);
    if (o.lanNeverConnects) for (const pc of [...hx.pcs, ...hy.pcs]) pc.neverConnect = true;
    await vi.advanceTimersByTimeAsync(50);
    return { hx, hy, cx, cy, ex, ey, mx, my, errors, parts };
  }
  const yB = (parts: VoiceParticipant[][]) => parts.at(-1)?.find((p) => p.identity === B)?.state;
  const scheduledOn = (h: { contexts: unknown[] }) => (h.contexts[0] as { scheduled: unknown[] }).scheduled.length;

  it('a peer on another network (circuit): no RTCPeerConnection; audio goes over B, and B shows connected', async () => {
    const { hx, hy, cx, ex, ey, mx, errors, parts } = await call('circuit');
    expect(hx.pcs).toHaveLength(0);
    expect(hy.pcs).toHaveLength(0);
    expect(cx.sent).toEqual([]); // no WebRTC signalling at all
    await mx.push(5);
    await vi.advanceTimersByTimeAsync(400);
    expect(scheduledOn(hy)).toBeGreaterThan(0); // B's side scheduled A's audio
    expect(yB(parts)).toBe('connected');
    expect(cx.webrtcPeers.at(-1)).toEqual([]); // no LAN WebRTC: the core sends B to everyone
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('a peer on my LAN: WebRTC as before, and the core is told to leave it out of B', async () => {
    const { hx, cx, ex, ey, errors } = await call('lan');
    expect(hx.pcs).toHaveLength(1);
    expect(hx.pcs[0]!.connectionState).toBe('connected');
    expect(cx.webrtcPeers.at(-1)).toEqual([B]);
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('the core stops reporting a path for a LAN WebRTC peer (it is no B target): the call stays on WebRTC', async () => {
    const { hx, cx, ex, ey, errors, parts } = await call('lan');
    expect(cx.webrtcPeers.at(-1)).toEqual([B]);
    delete cx.paths[B]; // dev-sync: no path for peers excluded from B
    cx.emitState(cx.state());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hx.pcs).toHaveLength(1);
    expect(hx.pcs[0]!.closed).toBe(false);
    expect(yB(parts)).toBe('connected');
    expect(errors).toEqual([]);
    // WebRTC gives up later: the peer goes to B, and the core is told (it then reports a path again).
    hx.pcs[0]!.neverConnect = true;
    hx.pcs[0]!.connectionState = 'failed';
    (hx.pcs[0]!.onconnectionstatechange as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(cx.webrtcPeers.at(-1)).toEqual([]);
    expect(errors).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('a LAN attempt that never connects falls to B after 3 s, with no error', async () => {
    const { hx, ex, ey, errors, parts } = await call('lan', { lanNeverConnects: true });
    expect(hx.pcs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hx.pcs[0]!.closed).toBe(true);
    expect(errors).toEqual([]);
    expect(yB(parts)).toBe('connected'); // on B now (the core has a LAN path to them)
    ex.dispose();
    ey.dispose();
  });

  it('relay-only with B on: the call runs on B, never a REMOTE RTCPeerConnection, even toward a LAN peer', async () => {
    const { hx, hy, cx, ex, ey, mx } = await call('lan', { relayOnly: true });
    expect(hx.pcs).toHaveLength(0);
    expect(hy.pcs).toHaveLength(0);
    expect(cx.sent).toEqual([]);
    await mx.push(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(scheduledOn(hy)).toBeGreaterThan(0);
    ex.dispose();
    ey.dispose();
  });

  it('an offer from a peer not on my LAN is ignored: a peer cannot force WebRTC', async () => {
    // To B (the higher identity, which takes offers): A's offer must not open WebRTC there.
    const { hy, cy, ex, ey } = await call('circuit');
    cy.emitSignal({ from: A, kind: 'offer', payload: `v=0\r\na=fingerprint:sha-256 ${newFingerprint()}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n`, fingerprintVerified: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(hy.pcs).toHaveLength(0);
    expect(cy.sent).toEqual([]);
    ex.dispose();
    ey.dispose();
  });

  it('no usable path within the connect timeout: peer-failed once, shown failed', async () => {
    const { ex, ey, errors, parts } = await call('none');
    expect(yB(parts)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(errors).toEqual([{ code: 'peer-failed', peer: B }]);
    expect(yB(parts)).toBe('failed');
    ex.dispose();
    ey.dispose();
  });

  it('muted: nothing goes out over B', async () => {
    const { hy, ex, ey, mx } = await call('circuit');
    ex.setMicMuted(true);
    await mx.push(5);
    await vi.advanceTimersByTimeAsync(400);
    expect(scheduledOn(hy)).toBe(0);
    ex.dispose();
    ey.dispose();
  });

  it('with the flag off, nothing changes: WebRTC to everyone, whatever the path', async () => {
    vi.useFakeTimers();
    const p = pair();
    p.cx.paths[B] = 'circuit';
    p.cx.callId = CALL_ID;
    await p.ex.attach(p.cx.state(), A);
    await p.ey.attach(p.cy.state(), B);
    await vi.advanceTimersByTimeAsync(50);
    expect(p.hx.pcs).toHaveLength(1);
    p.ex.dispose();
    p.ey.dispose();
  });
});

// ---- G-81 B playout: the in-renderer loopback (AEC run 2: 27.3 dB; TL L1-L4, SL L3/L5/L6) ----

describe('voice engine: G-81 B playout through the loopback pair', () => {
  const CALL_ID = 'c'.repeat(32);

  async function bCall(o: { relayOnly?: boolean } = {}) {
    vi.useFakeTimers();
    FakeLoopbackPC.made = [];
    const hx = fakeEnv({ webAudio: {} });
    const cx = new FakeCore(A, [A, B]);
    cx.callId = CALL_ID;
    cx.paths[B] = 'circuit';
    const net = loopback([A, B], {}, (fn) => fn());
    const quietEnv: MediaEnv = {
      readTrack: () => ({ read: () => new Promise<AudioData | null>(() => {}), cancel() {} }),
      createEncoder: () => ({ configure() {}, encode() {}, close() {} }),
      createDecoder: ({ output }) => ({ configure() {}, decode: () => output({ numberOfFrames: 1920, copyTo: (d) => d.fill(0.1), close() {} }), close() {} }),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    const ex = createVoiceEngine(cx, { env: hx.env, stunUrl: null, p2p: true, relayOnly: o.relayOnly, media: { transport: () => net[A]!, env: quietEnv } });
    await ex.attach(cx.state(), A);
    await vi.advanceTimersByTimeAsync(50);
    // B speaks: a frame reaches A, so A's per-peer output (and the loopback) is made.
    for (let seq = 0; seq < 4; seq++) net[B]!.send({ callId: CALL_ID, seq, ts: seq * 1920, data: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(300);
    const ctx = hx.contexts[0] as unknown as FakeWebAudioContext;
    return { hx, cx, ex, ctx };
  }

  it('B audio plays through one loopback pair: two ends, made by the loopback factory with no arguments (L2, L3)', async () => {
    const { hx, ctx, ex } = await bCall();
    expect(FakeLoopbackPC.made).toHaveLength(2);
    expect(FakeLoopbackPC.made.every((pc) => pc.args.length === 0)).toBe(true); // nothing to put ICE servers in
    expect(hx.pcs).toHaveLength(0); // no remote connection
    expect(ctx.destinations).toHaveLength(1);
    // The peer's gain feeds the loopback bus, not the speakers directly.
    const bus = ctx.gains.find((g) => g.out[0] === ctx.destinations[0]);
    expect(bus).toBeTruthy();
    expect(ctx.gains.some((g) => g.out[0] === bus)).toBe(true); // B's gain → the bus → the loopback's stream
    expect(ctx.gains.some((g) => g !== bus && g.out[0] === ctx.limiters[0])).toBe(false); // never straight to the speakers
    ex.dispose();
  });

  it('the pair negotiates only with itself: no core.sendSignal, its candidates go to the other end (L1, L5)', async () => {
    const { cx, ex } = await bCall();
    const [a, z] = FakeLoopbackPC.made;
    expect(a!.calls).toEqual(expect.arrayContaining(['addTrack', 'local:offer', 'remote:answer', 'ice']));
    expect(z!.calls).toEqual(expect.arrayContaining(['remote:offer', 'local:answer', 'ice']));
    expect(cx.sent).toEqual([]); // nothing of the pair reaches the core
    ex.dispose();
  });

  it('relay-only + B: never a REMOTE connection, but B still gets the loopback (AEC) playout (L3)', async () => {
    const { hx, cx, ex } = await bCall({ relayOnly: true });
    expect(hx.pcs).toHaveLength(0);
    expect(cx.sent).toEqual([]);
    expect(FakeLoopbackPC.made).toHaveLength(2);
    ex.dispose();
  });

  it('the remote factory throws under relay-only; the loopback one is a different factory (SL L3)', () => {
    const env = { createPeerConnection: vi.fn(() => ({}) as RTCPeerConnection) };
    expect(() => remotePeerConnection(env, true, { iceServers: [] })).toThrow(/relay-only/);
    expect(env.createPeerConnection).not.toHaveBeenCalled();
    expect(remotePeerConnection(env, false, { iceServers: [] })).toEqual({});
  });

  it('the chosen output reaches the loopback element; leaving the call closes the pair and stops its track (L4, L6)', async () => {
    const { hx, ctx, ex } = await bCall();
    await ex.setOutputDevice('spk1');
    const el = hx.audios.at(-1) as unknown as { sinks: string[] };
    expect(el.sinks.at(-1)).toBe('spk1');
    ex.detach();
    expect(FakeLoopbackPC.made.every((pc) => pc.closed)).toBe(true);
    expect(ctx.destinations[0]!.stream.getTracks()[0]!.stopped).toBe(true);
    ex.dispose();
  });
});
