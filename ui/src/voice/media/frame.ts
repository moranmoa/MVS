// G-81 B (docs/design/g81-p2p-calls.md §2.3): the renderer's side of the
// frozen frame contract. The core builds the 26-byte wire header from these
// fields; here a frame is the JSON-channel shape: `voiceFrame(callId, seq,
// ts, data)` out, `voice.frame { callId, from, seq, ts, data }` in.

/** Opus payload bytes, at most (§2.3; the core closes the stream above it). */
export const MAX_OPUS_BYTES = 400;
/** Samples per second: `ts` counts 48 kHz samples. */
export const SAMPLE_RATE = 48_000;
/** Frame length in ms (40 ms Opus frames, §2.3). */
export const FRAME_MS = 40;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const U32 = 2 ** 32;

/** One outgoing frame: what `voiceFrame` carries. `data` is empty for DTX. */
export interface OutFrame {
  callId: string;
  seq: number;
  ts: number;
  data: Uint8Array;
}

/** One incoming frame, from the core's `voice.frame` event. */
export interface InFrame extends OutFrame {
  from: string;
}

const isU32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < U32;
const CALL_ID = /^[0-9a-f]{32}$/;
const PEER_ID = /^[0-9a-f]{64}$/;

/** Base64 (standard) to bytes; null when it isn't base64 or decodes over the cap. */
export function fromBase64(s: unknown, max = MAX_OPUS_BYTES): Uint8Array | null {
  if (typeof s !== 'string' || s.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  try {
    const bin = atob(s);
    if (bin.length > max) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * A `voice.frame` event payload, checked: hex ids, u32 seq and ts, base64
 * Opus of at most 400 bytes (0 = DTX). Anything else is null (dropped).
 */
export function cleanInFrame(raw: unknown): InFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.callId !== 'string' || !CALL_ID.test(r.callId)) return null;
  if (typeof r.from !== 'string' || !PEER_ID.test(r.from)) return null;
  if (!isU32(r.seq) || !isU32(r.ts)) return null;
  const data = fromBase64(r.data);
  if (!data) return null;
  return { callId: r.callId, from: r.from, seq: r.seq, ts: r.ts, data };
}

/** The `voiceFrame` arguments for an outgoing frame. */
export function outArgs(f: OutFrame): { callId: string; seq: number; ts: number; data: string } {
  if (f.data.length > MAX_OPUS_BYTES) throw new Error('opus frame over 400 bytes');
  return { callId: f.callId, seq: f.seq >>> 0, ts: f.ts >>> 0, data: toBase64(f.data) };
}

/** a - b for u32 counters that wrap (seq, ts): positive when a is after b. */
export function u32Diff(a: number, b: number): number {
  const d = (a - b) >>> 0;
  return d >= U32 / 2 ? d - U32 : d;
}
