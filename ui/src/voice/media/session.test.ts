// G-81 B: the media session end to end over the loopback transport, with
// fake WebCodecs and a fake audio clock (jsdom has neither).
import { describe, expect, it } from 'vitest';
import { FRAME_MS } from './frame';
import { BITRATE_RELAYED, MAX_MEDIA_PEERS, MediaSession, type DecodedAudio, type EncodedChunk, type MediaEnv } from './session';
import { loopback, type LoopbackLink } from './transport';

const CALL = 'c'.repeat(32);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'd'.repeat(64);
const F = FRAME_MS / 1000;

/** A fake mic frame: `mark` is what the fake codec carries through, `size` the encoded size. */
type FakeAudio = { mark: number; size?: number; closed: boolean; close(): void };
const mic = (mark: number, size = 100): FakeAudio => ({ mark, size, closed: false, close() { this.closed = true; } });

function env() {
  const queue: (FakeAudio | null)[] = [];
  let wake: (() => void) | null = null;
  const timers: (() => void)[] = [];
  const configs: AudioEncoderConfig[] = [];
  let encodes = 0;
  let encoderClosed = false;
  const e: MediaEnv = {
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
    createEncoder: ({ output }) => ({
      configure: (c) => void configs.push(c),
      encode(d) {
        encodes++;
        const a = d as unknown as FakeAudio;
        const size = a.size ?? 100;
        const chunk: EncodedChunk = { byteLength: size, timestamp: encodes * FRAME_MS * 1000, copyTo: (dest) => dest.fill(a.mark & 0xff) };
        output(chunk);
      },
      close: () => void (encoderClosed = true),
    }),
    createDecoder: ({ output }) => ({
      configure() {},
      decode(c) {
        const mark = c.data[0] ?? 0;
        const audio: DecodedAudio = { numberOfFrames: 1920, copyTo: (dest) => dest.fill(mark / 255), close() {} };
        output(audio);
      },
      close() {},
    }),
    setInterval: (fn) => (timers.push(fn), timers.length - 1),
    clearInterval: (h) => void (timers[h as number] = () => {}),
  };
  return {
    env: e,
    feed: async (...items: (FakeAudio | null)[]) => {
      queue.push(...items);
      wake?.();
      for (let i = 0; i < 100; i++) await Promise.resolve();
    },
    tick: () => timers.forEach((t) => t()),
    configs,
    encodes: () => encodes,
    encoderClosed: () => encoderClosed,
  };
}

/** A fake AudioContext: a settable clock, and every scheduled buffer recorded. */
function context() {
  const played: { at: number; mark: number; peer: string }[] = [];
  const ctx = {
    currentTime: 0,
    createBuffer: (_c: number, n: number) => {
      const data = new Float32Array(n);
      return { copyToChannel: (src: Float32Array) => data.set(src), data };
    },
    createBufferSource() {
      const node = {
        buffer: null as null | { data: Float32Array },
        out: null as null | { peer: string },
        connect(o: { peer: string }) {
          node.out = o;
        },
        start(at: number) {
          played.push({ at: +at.toFixed(3), mark: Math.round(node.buffer!.data[0]! * 255), peer: node.out!.peer });
        },
      };
      return node;
    },
  };
  return { ctx: ctx as unknown as AudioContext, raw: ctx, played };
}

async function pair(link: LoopbackLink = {}) {
  const net = loopback([A, B], link, (fn) => fn()); // synchronous delivery unless the link says otherwise
  const ea = env();
  const eb = env();
  const ca = context();
  const cb = context();
  const sa = new MediaSession({ env: ea.env, transport: net[A]!, context: ca.ctx, output: (peer) => ({ peer }) as unknown as AudioNode, accepts: (p) => p === B });
  const sb = new MediaSession({ env: eb.env, transport: net[B]!, context: cb.ctx, output: (peer) => ({ peer }) as unknown as AudioNode, accepts: (p) => p === A, jitter: { startMs: 80 } });
  sa.start(CALL, {} as MediaStreamTrack);
  sb.start(CALL, null);
  await Promise.resolve();
  return { sa, sb, ea, eb, ca, cb };
}

/** Runs B's playout clock forward, a tick at a time. */
function runClock(c: ReturnType<typeof context>, e: ReturnType<typeof env>, seconds: number) {
  for (let t = 0; t < seconds; t += 0.02) {
    c.raw.currentTime = +(c.raw.currentTime + 0.02).toFixed(3);
    e.tick();
  }
}

describe('media session (G-81 B)', () => {
  it('frames sent by A play on B in order, back to back, after the start depth', async () => {
    const { sb, ea, eb, cb } = await pair();
    for (const m of [1, 2, 3, 4, 5, 6]) {
      await ea.feed(mic(m)); // in real time: one frame per 40 ms
      runClock(cb, eb, F);
    }
    runClock(cb, eb, 0.3);
    expect(cb.played.map((p) => p.mark)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cb.played.every((p) => p.peer === A)).toBe(true);
    const gaps = cb.played.slice(1).map((p, i) => +(p.at - cb.played[i]!.at).toFixed(3));
    expect(gaps.every((g) => g === F)).toBe(true);
    expect(sb.stats().peers[A]).toMatchObject({ received: 6, played: 6, missing: 0 });
  });

  it('a lost frame leaves a 40 ms hole in the schedule, and the rest plays on time', async () => {
    const { ea, eb, cb } = await pair({ drop: (seq) => seq === 2 });
    await ea.feed(...[1, 2, 3, 4, 5].map((m) => mic(m)));
    runClock(cb, eb, 0.4);
    expect(cb.played.map((p) => p.mark)).toEqual([1, 2, 4, 5]);
    expect(+(cb.played[2]!.at - cb.played[1]!.at).toFixed(3)).toBe(+(2 * F).toFixed(3));
  });

  it('duplicates are played once', async () => {
    const { ea, eb, cb } = await pair({ duplicate: () => true });
    await ea.feed(...[1, 2, 3].map((m) => mic(m)));
    runClock(cb, eb, 0.3);
    expect(cb.played.map((p) => p.mark)).toEqual([1, 2, 3]);
  });

  it('muted: nothing is encoded or sent; unmuted, seq goes on', async () => {
    const { sa, sb, ea, eb, cb } = await pair();
    await ea.feed(mic(1), mic(2));
    sa.setMuted(true);
    await ea.feed(mic(3), mic(4));
    expect(ea.encodes()).toBe(2);
    expect(sa.stats()).toMatchObject({ sent: 2, muted: true });
    sa.setMuted(false);
    await ea.feed(mic(5));
    runClock(cb, eb, 0.3);
    expect(cb.played.map((p) => p.mark)).toEqual([1, 2, 5]);
    expect(sb.stats().peers[A]!.missing).toBe(0); // no seq gap from muting
  });

  it('an encoded frame over 400 B is never sent', async () => {
    const { sa, ea } = await pair();
    await ea.feed(mic(1, 401), mic(2, 400));
    expect(sa.stats()).toMatchObject({ sent: 1, oversize: 1 });
  });

  it('relayed links get 16 kbps', async () => {
    const { sa, ea } = await pair();
    sa.setBitrate(BITRATE_RELAYED);
    expect(ea.configs.map((c) => c.bitrate)).toEqual([24_000, 16_000]);
  });

  it('frames for another call, or from a peer not in the call, are dropped', async () => {
    const net = loopback([A, B, C], {}, (fn) => fn());
    const eb = env();
    const cb = context();
    const sb = new MediaSession({ env: eb.env, transport: net[B]!, context: cb.ctx, output: (peer) => ({ peer }) as unknown as AudioNode, accepts: (p) => p === A, jitter: { startMs: 40 } });
    sb.start(CALL, null);
    net[C]!.send({ callId: CALL, seq: 0, ts: 0, data: new Uint8Array([9]) }); // not in the call
    net[A]!.send({ callId: 'e'.repeat(32), seq: 0, ts: 0, data: new Uint8Array([8]) }); // another call
    net[A]!.send({ callId: CALL, seq: 0, ts: 0, data: new Uint8Array([7]) });
    runClock(cb, eb, 0.2);
    expect(cb.played.map((p) => [p.peer, p.mark])).toEqual([[A, 7]]);
    expect(Object.keys(sb.stats().peers)).toEqual([A]);
  });

  it('holds at most 8 peers', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(64, '0'));
    const net = loopback(['f'.repeat(64), ...ids], {}, (fn) => fn());
    const e = env();
    const s = new MediaSession({ env: e.env, transport: net['f'.repeat(64)]!, context: context().ctx, output: () => null, accepts: () => true });
    s.start(CALL, null);
    for (const id of ids) net[id]!.send({ callId: CALL, seq: 0, ts: 0, data: new Uint8Array([1]) });
    expect(Object.keys(s.stats().peers)).toHaveLength(MAX_MEDIA_PEERS);
  });

  it('encodes once per frame, whatever the number of peers', async () => {
    const net = loopback([A, B, C], {}, (fn) => fn());
    const ea = env();
    const sa = new MediaSession({ env: ea.env, transport: net[A]!, context: context().ctx, output: () => null, accepts: () => true });
    const got: string[] = [];
    net[B]!.onFrame((f) => got.push(`B${f.seq}`));
    net[C]!.onFrame((f) => got.push(`C${f.seq}`));
    sa.start(CALL, {} as MediaStreamTrack);
    await Promise.resolve();
    await ea.feed(mic(1), mic(2));
    expect(ea.encodes()).toBe(2);
    expect(got.sort()).toEqual(['B0', 'B1', 'C0', 'C1']);
  });

  it('stop(): the encoder closes, the mic reader ends, and nothing more plays', async () => {
    const { sa, sb, ea, eb, cb } = await pair();
    await ea.feed(mic(1), mic(2));
    sb.stop();
    sa.stop();
    expect(ea.encoderClosed()).toBe(true);
    await ea.feed(mic(3));
    runClock(cb, eb, 0.3);
    expect(cb.played).toEqual([]);
  });
});

describe('the shell bridge transport (#526)', () => {
  it('sends base64 frames fire-and-forget; checks what comes in; absent bridge = null', async () => {
    const { bridgeTransport, voiceBridge } = await import('./transport');
    expect(voiceBridge()).toBeNull();
    const sent: unknown[] = [];
    let listener: ((raw: unknown) => void) | null = null;
    const bridge = { send: (a: unknown) => void sent.push(a), onFrame: (cb: (raw: unknown) => void) => ((listener = cb), () => (listener = null)) };
    (globalThis as { mvs?: unknown }).mvs = { voice: bridge };
    try {
      expect(voiceBridge()).toBe(bridge);
      const t = bridgeTransport(bridge);
      t.send({ callId: CALL, seq: 1, ts: 1920, data: new Uint8Array([1, 2, 3]) });
      expect(sent).toEqual([{ callId: CALL, seq: 1, ts: 1920, data: 'AQID' }]);
      const got: unknown[] = [];
      const off = t.onFrame((f) => got.push(f));
      listener!({ callId: CALL, from: A, seq: 2, ts: 3840, data: 'AQID' });
      listener!({ callId: CALL, from: 'not-hex', seq: 2, ts: 3840, data: 'AQID' }); // dropped
      listener!({ callId: CALL, from: A, seq: 3, ts: 1, data: btoa('x'.repeat(401)) }); // over 400 B: dropped
      expect(got).toEqual([{ callId: CALL, from: A, seq: 2, ts: 3840, data: new Uint8Array([1, 2, 3]) }]);
      off();
      expect(listener).toBeNull();
    } finally {
      delete (globalThis as { mvs?: unknown }).mvs;
    }
  });
});

describe('media session: what the real-Electron smoke test caught', () => {
  it('a stereo mic is downmixed before encoding (the encoder is mono)', async () => {
    const e = env();
    const seen: unknown[] = [];
    const mono = { mark: 9, size: 50, closed: false, close() { this.closed = true; } };
    e.env.downmix = (d) => ((d as unknown as FakeAudio).mark === 1 ? (mono as unknown as AudioData) : null);
    const enc = e.env.createEncoder;
    e.env.createEncoder = (init) => {
      const real = enc(init);
      return { ...real, encode: (d) => (seen.push((d as unknown as FakeAudio).mark), real.encode(d)) };
    };
    const net = loopback([A, B], {}, (fn) => fn());
    const s = new MediaSession({ env: e.env, transport: net[A]!, context: context().ctx, output: () => null, accepts: () => true });
    s.start(CALL, {} as MediaStreamTrack);
    await Promise.resolve();
    const stereo = mic(1);
    await e.feed(stereo, mic(2));
    expect(seen).toEqual([9, 2]); // the mono copy for the stereo frame; mono frames as they are
    expect(mono.closed && stereo.closed).toBe(true);
  });

  it('an encoder failure stops sending and says why in stats, instead of failing silently', async () => {
    const e = env();
    e.env.createEncoder = ({ error }) => ({ configure() {}, encode: () => error(new Error('channels mismatch')), close() {} });
    const net = loopback([A, B], {}, (fn) => fn());
    const s = new MediaSession({ env: e.env, transport: net[A]!, context: context().ctx, output: () => null, accepts: () => true });
    s.start(CALL, {} as MediaStreamTrack);
    await Promise.resolve();
    await e.feed(mic(1), mic(2));
    expect(s.stats()).toMatchObject({ sent: 0, sendError: 'channels mismatch' });
  });
});

describe('media session: DTX and broken decoders (TL)', () => {
  it('an empty (DTX) frame is 40 ms of silence and never reaches the decoder', async () => {
    const net = loopback([A, B], {}, (fn) => fn());
    const eb = env();
    const decoded: number[] = [];
    const make = eb.env.createDecoder;
    eb.env.createDecoder = (init) => {
      const d = make(init);
      return { ...d, decode: (c) => (decoded.push(c.data.length), d.decode(c)) };
    };
    const cb = context();
    const sb = new MediaSession({ env: eb.env, transport: net[B]!, context: cb.ctx, output: (peer) => ({ peer }) as unknown as AudioNode, accepts: () => true, jitter: { startMs: 40 } });
    sb.start(CALL, null);
    for (const [seq, len] of [[0, 1], [1, 0], [2, 1]] as const) {
      net[A]!.send({ callId: CALL, seq, ts: seq * 1920, data: new Uint8Array(len).fill(5) });
      runClock(cb, eb, F);
    }
    runClock(cb, eb, 0.2);
    expect(decoded).toEqual([1, 1]);
    expect(cb.played).toHaveLength(2);
    expect(cb.played[1]!.at - cb.played[0]!.at).toBeGreaterThanOrEqual(2 * F - 1e-9); // its slot stays silent
  });

  it('a failing decoder is replaced, at most 5 times per peer; past that the peer is silent', async () => {
    const net = loopback([A, B], {}, (fn) => fn());
    const eb = env();
    let made = 0;
    eb.env.createDecoder = ({ error }) => {
      made++;
      return { configure() {}, decode: () => error(new Error('bad frame')), close() {} };
    };
    const cb = context();
    const sb = new MediaSession({ env: eb.env, transport: net[B]!, context: cb.ctx, output: () => null, accepts: () => true, jitter: { startMs: 40 } });
    sb.start(CALL, null);
    for (let seq = 0; seq < 20; seq++) {
      net[A]!.send({ callId: CALL, seq, ts: seq * 1920, data: new Uint8Array([1]) });
      runClock(cb, eb, F);
    }
    expect(made).toBe(1 + 5);
  });
});
