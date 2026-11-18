// G-81 (docs/design/g81-p2p-calls.md §2.3, SL B3): voice frames between the
// page and the core on their own channel, never through core:invoke.
//
// - page -> core: `voice:frame` (fire-and-forget). Main checks the shape and
//   the caps, then writes one `voiceFrame` line to the core with no request
//   id; the core's fast path takes it before dispatch and writes no reply.
//   The core sends it to every peer in my call that is on B: the page names
//   no target.
// - core -> page: the core's `voice.frame` event, checked the same way, goes
//   to the page on `voice:frame` (not the generic core:event stream).
//
// Nothing from a frame is ever logged.
'use strict';

/** Opus payload, after base64 decoding (§2.3: ≤ 400 B; 0 = DTX). */
const MAX_PAYLOAD = 400;
/** The longest base64 for MAX_PAYLOAD bytes. */
const MAX_B64 = Math.ceil(MAX_PAYLOAD / 3) * 4;
/** Global cap, each direction (§2.3, SL B2): 480 frames/s with a short burst. */
const FRAMES_PER_SEC = 480;
const BURST = 120;
const U32 = 0xffffffff;
/** call_id is 16 bytes on the wire: 32 lowercase hex characters here. */
const CALL_ID = /^[0-9a-f]{32}$/;
/** A member identity, as everywhere else in the API. */
const IDENTITY = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const u32 = (v) => Number.isInteger(v) && v >= 0 && v <= U32;

/** Decoded size of a well-formed base64 string, or -1. */
function payloadBytes(b64) {
  if (typeof b64 !== 'string' || b64.length > MAX_B64 || !BASE64.test(b64)) return -1;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** A frame from the page: exactly { callId, seq, ts, data }, or null. */
function cleanOutgoing(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 4 || !['callId', 'seq', 'ts', 'data'].every((k) => keys.includes(k))) return null;
  if (typeof v.callId !== 'string' || !CALL_ID.test(v.callId)) return null;
  if (!u32(v.seq) || !u32(v.ts)) return null;
  const n = payloadBytes(v.data);
  if (n < 0 || n > MAX_PAYLOAD) return null;
  return { callId: v.callId, seq: v.seq, ts: v.ts, data: v.data };
}

/** A frame from the core: exactly { callId, from, seq, ts, data }, or null. */
function cleanIncoming(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.from !== 'string' || !IDENTITY.test(v.from)) return null;
  const rest = { callId: v.callId, seq: v.seq, ts: v.ts, data: v.data };
  const keys = Object.keys(v);
  if (keys.length !== 5) return null;
  const out = cleanOutgoing(rest);
  return out ? { ...out, from: v.from } : null;
}

/** A token bucket: `take()` is false once the rate (and burst) is used up. */
function createBucket({ perSec = FRAMES_PER_SEC, burst = BURST, now = Date.now } = {}) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/**
 * The two directions. `canSend()`: in a call AND unlocked (the mic is forced
 * off under the G-78 lock, so nothing goes out then). `canReceive()`: in a
 * call, unlocked or locked on path B (the call's audio keeps playing behind
 * the lock). `send(line args)` writes the fire-and-forget line to the core;
 * `deliver(frame)` hands a frame to the page. Both return nothing.
 */
function createVoiceFrames({ canSend, canReceive, send, deliver, now = Date.now }) {
  const out = createBucket({ now });
  const inn = createBucket({ now });
  const counts = { sent: 0, delivered: 0, refused: 0, dropped: 0 };
  return {
    counts,
    /** From the page. True if it went to the core. */
    fromPage(frame) {
      if (!canSend()) return (counts.refused++, false);
      const f = cleanOutgoing(frame);
      if (!f) return (counts.refused++, false);
      if (!out.take()) return (counts.dropped++, false);
      if (send(f) === false) return (counts.dropped++, false);
      counts.sent++;
      return true;
    },
    /** From the core (the voice.frame event). True if it went to the page. */
    fromCore(payload) {
      if (!canReceive()) return (counts.refused++, false);
      const f = cleanIncoming(payload);
      if (!f) return (counts.refused++, false);
      if (!inn.take()) return (counts.dropped++, false);
      deliver(f);
      counts.delivered++;
      return true;
    },
  };
}

module.exports = { MAX_PAYLOAD, FRAMES_PER_SEC, BURST, cleanOutgoing, cleanIncoming, createBucket, createVoiceFrames, payloadBytes };
