// G-81 B: the frame contract (§2.3) and the jitter buffer.
import { describe, expect, it } from 'vitest';
import { cleanInFrame, fromBase64, MAX_OPUS_BYTES, outArgs, toBase64, u32Diff } from './frame';
import { JitterBuffer, type Pull } from './jitter';

const CALL = 'c'.repeat(32);
const PEER = 'b'.repeat(64);
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);

describe('frame contract', () => {
  it('a good voice.frame passes; DTX (empty) is allowed', () => {
    expect(cleanInFrame({ callId: CALL, from: PEER, seq: 7, ts: 1920 * 7, data: toBase64(bytes(110)) })).toEqual({ callId: CALL, from: PEER, seq: 7, ts: 13440, data: bytes(110) });
    expect(cleanInFrame({ callId: CALL, from: PEER, seq: 0, ts: 0, data: '' })?.data).toEqual(new Uint8Array(0));
  });

  it('anything off is dropped: ids, counters, base64, the 400 B cap after decoding', () => {
    const ok = { callId: CALL, from: PEER, seq: 1, ts: 1, data: toBase64(bytes(10)) };
    for (const bad of [
      null,
      'x',
      { ...ok, callId: 'C'.repeat(32) },
      { ...ok, callId: 'c'.repeat(31) },
      { ...ok, from: 'b'.repeat(63) },
      { ...ok, seq: -1 },
      { ...ok, seq: 2 ** 32 },
      { ...ok, seq: 1.5 },
      { ...ok, ts: '1' },
      { ...ok, data: 'not base64!' },
      { ...ok, data: 'abc' },
      { ...ok, data: toBase64(bytes(MAX_OPUS_BYTES + 1)) },
      { ...ok, data: 7 },
    ])
      expect(cleanInFrame(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    expect(cleanInFrame({ ...ok, data: toBase64(bytes(MAX_OPUS_BYTES)) })).not.toBeNull();
    expect(fromBase64('A'.repeat(4000))).toBeNull(); // too long before decoding
  });

  it('outgoing frames: u32 counters, base64, never over 400 B', () => {
    expect(outArgs({ callId: CALL, seq: 2 ** 32 + 5, ts: 3, data: bytes(3) })).toEqual({ callId: CALL, seq: 5, ts: 3, data: 'AQEB' });
    expect(() => outArgs({ callId: CALL, seq: 0, ts: 0, data: bytes(401) })).toThrow();
  });

  it('counters compare across the u32 wrap', () => {
    expect(u32Diff(2, 0xffff_fffe)).toBe(4);
    expect(u32Diff(0xffff_fffe, 2)).toBe(-4);
    expect(u32Diff(5, 5)).toBe(0);
  });
});

describe('jitter buffer', () => {
  const pulls = (j: JitterBuffer, n: number): Pull['kind'][] => Array.from({ length: n }, () => j.pull().kind);

  it('waits for the start depth, then plays in order, reordering what arrived out of order', () => {
    const j = new JitterBuffer({ startMs: 80 }); // 2 frames
    j.push(11, bytes(1, 11));
    expect(j.pull().kind).toBe('wait');
    j.push(10, bytes(1, 10)); // earlier, before playout started: becomes the first
    const a = j.pull();
    const b = j.pull();
    expect([a, b].map((p) => (p.kind === 'frame' ? p.seq : p.kind))).toEqual([10, 11]);
  });

  it('a gap with later frames held is a missing slot; late and duplicate frames are dropped', () => {
    const j = new JitterBuffer({ startMs: 40 });
    j.push(1, bytes(1));
    j.push(3, bytes(1));
    expect(j.pull()).toMatchObject({ kind: 'frame', seq: 1 });
    expect(j.pull()).toEqual({ kind: 'missing', seq: 2 });
    expect(j.push(2, bytes(1))).toBe('late'); // its slot has passed
    expect(j.push(3, bytes(1))).toBe('duplicate');
    expect(j.pull()).toMatchObject({ kind: 'frame', seq: 3 });
    expect(j.stats()).toMatchObject({ received: 2, played: 2, missing: 1, late: 1, duplicate: 1 });
  });

  it('never holds more than maxMs: a burst skips ahead to the newest frames', () => {
    const j = new JitterBuffer({ startMs: 80, maxMs: 200 }); // 5 frames at most
    for (let s = 0; s < 50; s++) j.push(s, bytes(1));
    expect(j.stats().depthFrames).toBe(5);
    expect(j.stats().dropped).toBe(45);
    const first = j.pull();
    expect(first).toMatchObject({ kind: 'frame', seq: 45 });
  });

  it('a flood with huge seq jumps stays bounded too', () => {
    const j = new JitterBuffer();
    for (let s = 0; s < 2000; s++) j.push((s * 7919) >>> 0, bytes(1));
    expect(j.stats().depthFrames).toBeLessThanOrEqual(5);
  });

  it('runs dry: waits (no "missing" spam), then rebuilds a frame deeper', () => {
    const j = new JitterBuffer({ startMs: 40, maxMs: 200 });
    j.push(0, bytes(1));
    expect(j.pull().kind).toBe('frame');
    expect(pulls(j, 3)).toEqual(['wait', 'wait', 'wait']);
    expect(j.stats().targetMs).toBe(80);
    j.push(1, bytes(1));
    expect(j.pull().kind).toBe('wait'); // needs 2 now
    j.push(2, bytes(1));
    expect(pulls(j, 2)).toEqual(['frame', 'frame']);
  });

  it('shrinks the target after a long good run, not below minMs', () => {
    const j = new JitterBuffer({ startMs: 120, minMs: 40, shrinkAfter: 10 });
    let s = 0;
    for (; s < 3; s++) j.push(s, bytes(1));
    for (let i = 0; i < 60; i++) {
      j.push(s++, bytes(1));
      j.pull();
    }
    expect(j.stats().targetMs).toBe(40);
  });

  it('plays across the u32 seq wrap', () => {
    const j = new JitterBuffer({ startMs: 40 });
    const seqs = [0xffff_fffe, 0xffff_ffff, 0, 1];
    for (const s of seqs) j.push(s, bytes(1));
    const got = [0, 1, 2, 3].map(() => {
      const p = j.pull();
      return p.kind === 'frame' ? p.seq : p.kind;
    });
    expect(got).toEqual(seqs);
  });
});

describe('jitter buffer: no replays', () => {
  it('after running dry, a frame that already played (a retransmit) is late, not played again', () => {
    const j = new JitterBuffer({ startMs: 40 });
    j.push(5, bytes(1));
    expect(j.pull()).toMatchObject({ kind: 'frame', seq: 5 });
    expect(j.pull().kind).toBe('wait'); // dry
    expect(j.push(5, bytes(1))).toBe('late');
    expect(j.push(4, bytes(1))).toBe('late');
    j.push(6, bytes(1));
    j.push(7, bytes(1));
    expect(j.pull()).toMatchObject({ kind: 'frame', seq: 6 });
  });
});

describe('jitter buffer: the end of a sentence', () => {
  it('frames below the start depth still play after a short wait (no more are coming)', () => {
    const j = new JitterBuffer({ startMs: 120 }); // 3 frames
    j.push(0, bytes(1));
    const got: string[] = [];
    for (let i = 0; i < 10; i++) got.push(j.pull().kind);
    expect(got.indexOf('frame')).toBe(6); // 2 × the target in waits, then it plays
    expect(got.filter((k) => k === 'frame')).toHaveLength(1);
  });
});

describe('jitter buffer: a huge seq jump costs one pass (SL)', () => {
  it.each([2 ** 31 - 1, 0xffff_ffff, 1e8])('push(0) then push(%d) finishes in a few ms, and the buffer stays bounded', (jump) => {
    const j = new JitterBuffer();
    j.push(0, bytes(1));
    const t0 = performance.now();
    j.push(jump >>> 0, bytes(1));
    expect(performance.now() - t0).toBeLessThan(20);
    expect(j.stats().depthFrames).toBeLessThanOrEqual(5);
  });

  it('after playout started, a jump far ahead skips to it and the next pull plays it', () => {
    const j = new JitterBuffer({ startMs: 40 });
    j.push(0, bytes(1));
    expect(j.pull()).toMatchObject({ kind: 'frame', seq: 0 });
    const t0 = performance.now();
    j.push(2 ** 31 - 1, bytes(1));
    expect(performance.now() - t0).toBeLessThan(20);
    const kinds = [j.pull(), j.pull(), j.pull(), j.pull(), j.pull()].map((p) => (p.kind === 'frame' ? p.seq : p.kind));
    expect(kinds).toContain(2 ** 31 - 1);
    expect(j.push(5, bytes(1))).toBe('late'); // everything before the new window is passed
  });
});

describe('jitter buffer: no big rewind before playout (TL)', () => {
  it('a frame claiming seq − 2^30 before start is refused at once; a near-earlier one becomes the first', () => {
    const j = new JitterBuffer({ startMs: 80 });
    j.push(2 ** 30 + 10, bytes(1));
    const t0 = performance.now();
    expect(j.push(10, bytes(1))).toBe('late');
    expect(performance.now() - t0).toBeLessThan(20);
    expect(j.push(2 ** 30 + 9, bytes(1))).toBe('ok');
    expect(j.pull()).toMatchObject({ kind: 'frame', seq: 2 ** 30 + 9 });
  });
});
