// G-81 B (docs/design/g81-p2p-calls.md §2.3): a call's audio over the P2P
// network instead of WebRTC. Behind a flag; nothing here starts unless the
// engine asks for it.
//
// Sending:   mic track → AudioData (MediaStreamTrackProcessor) → Opus
//            (WebCodecs, 40 ms, DTX) → one frame to the transport, which the
//            core sends to every B peer in the call. Encoded once, not per peer.
//            Nothing is encoded or sent while muted (TL A4).
// Receiving: frame → this peer's jitter buffer → pulled every 40 ms in
//            order → Opus decode → an AudioBuffer scheduled on the context's
//            clock → the peer's output node (the engine's gain, later).
//
// Every browser API comes through MediaEnv, so tests run with fakes and the
// spike runs the real ones.

import { FRAME_MS, FRAME_SAMPLES, MAX_OPUS_BYTES, SAMPLE_RATE, type InFrame } from './frame';
import { JitterBuffer, type JitterOptions, type JitterStats } from './jitter';
import type { MediaTransport } from './transport';

/** A chunk as WebCodecs' AudioEncoder hands it out. */
export interface EncodedChunk {
  byteLength: number;
  timestamp: number; // µs
  copyTo(dest: Uint8Array): void;
}

export interface EncoderLike {
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  close(): void;
}

export interface DecoderLike {
  configure(config: AudioDecoderConfig): void;
  decode(chunk: { type: 'key'; timestamp: number; data: Uint8Array }): void;
  close(): void;
}

/** Decoded PCM, as AudioData offers it (mono, f32). */
export interface DecodedAudio {
  numberOfFrames: number;
  copyTo(dest: Float32Array, options: { planeIndex: number; format?: 'f32-planar' }): void;
  close(): void;
}

export interface MediaEnv {
  /** Reads AudioData from a microphone track; read() resolves null when it ends. */
  readTrack(track: MediaStreamTrack): { read(): Promise<AudioData | null>; cancel(): void };
  createEncoder(init: { output: (chunk: EncodedChunk) => void; error: (e: Error) => void }): EncoderLike;
  createDecoder(init: { output: (data: DecodedAudio) => void; error: (e: Error) => void }): DecoderLike;
  /** A mono copy of multichannel mic audio (the encoder is mono); null when the input is mono already. */
  downmix?(data: AudioData): AudioData | null;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function browserMediaEnv(): MediaEnv {
  return {
    readTrack(track) {
      const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> } }).MediaStreamTrackProcessor;
      const reader = new Processor({ track }).readable.getReader();
      return {
        read: async () => {
          const r = await reader.read();
          return r.done ? null : r.value;
        },
        cancel: () => void reader.cancel().catch(() => {}),
      };
    },
    createEncoder: (init) => new AudioEncoder({ output: (c) => init.output(c as unknown as EncodedChunk), error: init.error }),
    createDecoder: (init) => {
      const d = new AudioDecoder({ output: (a) => init.output(a as unknown as DecodedAudio), error: init.error });
      return {
        configure: (c) => d.configure(c),
        decode: (c) => d.decode(new EncodedAudioChunk(c)),
        close: () => d.state !== 'closed' && d.close(),
      };
    },
    downmix(data) {
      if (data.numberOfChannels <= 1) return null;
      const n = data.numberOfFrames;
      const mix = new Float32Array(n);
      const plane = new Float32Array(n);
      for (let c = 0; c < data.numberOfChannels; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mix[i]! += plane[i]! / data.numberOfChannels;
      }
      return new AudioData({ format: 'f32-planar', sampleRate: data.sampleRate, numberOfFrames: n, numberOfChannels: 1, timestamp: data.timestamp, data: mix });
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}

/** The mic audio as mono for the encoder (a stereo mic or a mixed track is averaged). */
function toMono(data: AudioData, env: MediaEnv): AudioData {
  return env.downmix?.(data) ?? data;
}

/** Opus bitrates (§2.3): full on direct and LAN links, lower when relayed. */
export const BITRATE_DIRECT = 24_000;
export const BITRATE_RELAYED = 16_000;

export function encoderConfig(bitrate: number): AudioEncoderConfig {
  return { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate, opus: { frameDuration: FRAME_MS * 1000, usedtx: true } } as AudioEncoderConfig;
}
const DECODER_CONFIG: AudioDecoderConfig = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 };

/** How far ahead of the clock audio is scheduled, and the tick that pulls frames. */
const LOOKAHEAD_S = 0.05;
const TICK_MS = 20;
/** Peers held at once (the room cap, TL A6). */
export const MAX_MEDIA_PEERS = 8;
/** Fresh decoders per peer per call after a decode error (TL). */
export const MAX_DECODER_RESTARTS = 5;

export interface MediaSessionOptions {
  env: MediaEnv;
  transport: MediaTransport;
  /** The playback context: frames are scheduled on its clock. */
  context: AudioContext;
  /** Where a peer's audio goes (the engine's per-peer gain); null drops it. */
  output(peer: string): AudioNode | null;
  jitter?: JitterOptions;
  bitrate?: number;
  /** A peer this session accepts frames from (the call's B peers, from the core's call state). */
  accepts(peer: string): boolean;
}

export interface MediaStats {
  sent: number;
  oversize: number;
  /** Why sending stopped, if it did (the encoder or the mic reader failed). */
  sendError: string | null;
  muted: boolean;
  peers: Record<string, JitterStats & { level: number }>;
}

interface PeerPlayer {
  jitter: JitterBuffer;
  decoder: DecoderLike;
  /** What the decoder will hand back, in order: a frame's audio or a lost slot's silence. */
  slots: ('frame' | 'gap')[];
  /** Pulled up to here (context seconds). */
  planned: number;
  /** Scheduled up to here (context seconds). */
  cursor: number;
  level: number;
  pullTs: number;
  decoderRestarts: number;
}

export class MediaSession {
  private readonly o: MediaSessionOptions;
  private callId: string | null = null;
  private encoder: EncoderLike | null = null;
  private reader: { read(): Promise<AudioData | null>; cancel(): void } | null = null;
  private muted = false;
  private seq = 0;
  private sent = 0;
  private oversize = 0;
  private sendError: string | null = null;
  private readonly peers = new Map<string, PeerPlayer>();
  private tick: unknown = null;
  private off: (() => void) | null = null;

  constructor(o: MediaSessionOptions) {
    this.o = o;
  }

  /** Starts sending (if a track is given) and receiving for this call. */
  start(callId: string, track: MediaStreamTrack | null): void {
    this.stop();
    this.callId = callId;
    this.seq = 0;
    this.off = this.o.transport.onFrame((f) => this.receive(f));
    this.tick = this.o.env.setInterval(() => this.pump(), TICK_MS);
    if (track) void this.send(track, callId);
  }

  stop(): void {
    this.callId = null;
    this.off?.();
    this.off = null;
    if (this.tick !== null) this.o.env.clearInterval(this.tick);
    this.tick = null;
    this.reader?.cancel();
    this.reader = null;
    try {
      this.encoder?.close();
    } catch {
      // already closed
    }
    this.encoder = null;
    for (const p of this.peers.values()) this.closePeer(p);
    this.peers.clear();
  }

  /** Muted: nothing is encoded or sent (TL A4). The seq goes on where it was. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** 24 kbps on direct links, 16 kbps relayed (§2.3). */
  setBitrate(bitrate: number): void {
    this.encoder?.configure(encoderConfig(bitrate));
  }

  /** A peer left the call: its buffer and decoder go. */
  dropPeer(peer: string): void {
    const p = this.peers.get(peer);
    if (p) this.closePeer(p);
    this.peers.delete(peer);
  }

  stats(): MediaStats {
    const peers: MediaStats['peers'] = {};
    for (const [id, p] of this.peers) peers[id] = { ...p.jitter.stats(), level: p.level };
    return { sent: this.sent, oversize: this.oversize, sendError: this.sendError, muted: this.muted, peers };
  }

  /** The level of a peer's latest decoded audio, 0..1 (for the speaking indicator). */
  level(peer: string): number {
    return this.peers.get(peer)?.level ?? 0;
  }

  // ---- sending ----

  private async send(track: MediaStreamTrack, callId: string) {
    const encoder = this.o.env.createEncoder({
      output: (chunk) => {
        if (this.callId !== callId || this.muted) return;
        if (chunk.byteLength > MAX_OPUS_BYTES) {
          this.oversize++;
          return;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const ts = Math.round((chunk.timestamp * SAMPLE_RATE) / 1_000_000) >>> 0;
        this.o.transport.send({ callId, seq: this.seq, ts, data });
        this.seq = (this.seq + 1) >>> 0;
        this.sent++;
      },
      error: (e) => {
        // The encoder died: this side stops sending (reported in stats); receiving goes on.
        this.sendError = e?.message || 'encoder error';
        this.encoder = null;
      },
    });
    try {
      encoder.configure(encoderConfig(this.o.bitrate ?? BITRATE_DIRECT));
      this.encoder = encoder;
      const reader = this.o.env.readTrack(track);
      this.reader = reader;
      for (;;) {
        const data = await reader.read();
        if (!data) break;
        if (this.callId !== callId || this.encoder !== encoder) {
          data.close();
          break;
        }
        if (!this.muted) {
          const mono = toMono(data, this.o.env);
          encoder.encode(mono);
          if (mono !== data) mono.close();
        }
        data.close();
      }
    } catch (e) {
      this.sendError = (e as Error)?.message || 'send failed';
    }
  }

  // ---- receiving ----

  private receive(f: InFrame) {
    if (f.callId !== this.callId || !this.o.accepts(f.from)) return;
    let p = this.peers.get(f.from);
    if (!p) {
      if (this.peers.size >= MAX_MEDIA_PEERS) return;
      p = this.newPeer(f.from);
      this.peers.set(f.from, p);
    }
    p.jitter.push(f.seq, f.data);
  }

  private newPeer(id: string): PeerPlayer {
    const p: PeerPlayer = { jitter: new JitterBuffer(this.o.jitter), decoder: null as unknown as DecoderLike, slots: [], planned: 0, cursor: 0, level: 0, pullTs: 0, decoderRestarts: 0 };
    const make = (): DecoderLike => {
      const d = this.o.env.createDecoder({
        output: (audio) => this.play(id, p, audio),
        error: () => {
          // A bad frame broke the decoder: a fresh one, the buffer goes on.
          // Capped, so a peer sending garbage can't make us rebuild forever;
          // past the cap this peer stays silent for the rest of the call.
          if (p.decoder !== d) return;
          p.slots = [];
          if (++p.decoderRestarts > MAX_DECODER_RESTARTS) {
            p.decoder = { configure() {}, decode() {}, close() {} };
            return;
          }
          p.decoder = make();
        },
      });
      d.configure(DECODER_CONFIG);
      return d;
    };
    p.decoder = make();
    return p;
  }

  private closePeer(p: PeerPlayer) {
    try {
      p.decoder.close();
    } catch {
      // already closed
    }
  }

  /** Every tick: pull each peer's frames up to the lookahead and hand them to its decoder in order. */
  private pump() {
    const now = this.o.context.currentTime;
    for (const p of this.peers.values()) {
      if (p.planned < now) p.planned = p.cursor = now + FRAME_MS / 1000 / 2; // (re)start just ahead of the clock
      while (p.planned < now + LOOKAHEAD_S) {
        const r = p.jitter.pull();
        if (r.kind === 'wait') break;
        p.planned += FRAME_MS / 1000;
        // A lost slot, or a DTX frame (empty: WebCodecs rejects 0-byte chunks): 40 ms of silence.
        if (r.kind === 'missing' || !r.data.length) {
          if (p.slots.length) p.slots.push('gap');
          else p.cursor += FRAME_MS / 1000; // silence: nothing to play for this slot
          continue;
        }
        p.slots.push('frame');
        p.pullTs += FRAME_SAMPLES;
        try {
          p.decoder.decode({ type: 'key', timestamp: Math.round((p.pullTs * 1_000_000) / SAMPLE_RATE), data: r.data });
        } catch {
          p.slots.pop();
        }
      }
    }
  }

  /** A decoded frame: schedule it right after what this peer has scheduled. */
  private play(id: string, p: PeerPlayer, audio: DecodedAudio) {
    try {
      while (p.slots[0] === 'gap') {
        p.slots.shift();
        p.cursor += FRAME_MS / 1000;
      }
      p.slots.shift();
      const n = audio.numberOfFrames;
      if (!n || this.callId === null) return;
      const pcm = new Float32Array(n);
      audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
      let sum = 0;
      for (const v of pcm) sum += v * v;
      p.level = Math.min(1, Math.sqrt(sum / n) * 4);
      const out = this.o.output(id);
      if (!out) return;
      const ctx = this.o.context;
      const buf = ctx.createBuffer(1, n, SAMPLE_RATE);
      buf.copyToChannel(pcm, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(out);
      const at = Math.max(p.cursor, ctx.currentTime);
      src.start(at);
      p.cursor = at + n / SAMPLE_RATE;
    } finally {
      audio.close();
    }
  }
}
