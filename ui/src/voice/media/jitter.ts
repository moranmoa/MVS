// G-81 B: one peer's jitter buffer. Frames arrive out of order and in bursts
// (a TCP stream stalls on loss and then catches up); playout takes one frame
// every FRAME_MS in sequence order. Bounded in frames and in ms (§2.3: ≤ 200
// ms), so a flood or a long stall never grows memory or delay.

import { FRAME_MS, u32Diff } from './frame';

export interface JitterOptions {
  /** Delay to build before playout starts and after an underrun. */
  startMs?: number;
  /** Never more delay than this: older frames are dropped to catch up. */
  maxMs?: number;
  /** Never less than this. */
  minMs?: number;
  /** Good pulls in a row before the target shrinks by a frame. */
  shrinkAfter?: number;
}

export type Pull = { kind: 'frame'; seq: number; data: Uint8Array } | { kind: 'missing'; seq: number } | { kind: 'wait' };

export interface JitterStats {
  received: number;
  played: number;
  missing: number;
  late: number;
  duplicate: number;
  dropped: number;
  depthFrames: number;
  targetMs: number;
}

export class JitterBuffer {
  private readonly frames = new Map<number, Uint8Array>();
  private next: number | null = null;
  /** Once playout has begun: the first slot not yet passed. Nothing before it is accepted again. */
  private floor: number | null = null;
  private started = false;
  private targetFrames: number;
  private readonly maxFrames: number;
  private readonly minFrames: number;
  private readonly shrinkAfter: number;
  private good = 0;
  /** Waits while not started with frames held (see pull). */
  private waited = 0;
  private readonly s: Omit<JitterStats, 'depthFrames' | 'targetMs'> = { received: 0, played: 0, missing: 0, late: 0, duplicate: 0, dropped: 0 };

  constructor(o: JitterOptions = {}) {
    this.maxFrames = Math.max(1, Math.floor((o.maxMs ?? 200) / FRAME_MS));
    this.minFrames = Math.max(1, Math.min(this.maxFrames, Math.round((o.minMs ?? 40) / FRAME_MS)));
    this.targetFrames = Math.max(this.minFrames, Math.min(this.maxFrames, Math.round((o.startMs ?? 80) / FRAME_MS)));
    this.shrinkAfter = o.shrinkAfter ?? 250; // 10 s of 40 ms frames
  }

  /** Adds a frame; it is dropped when already played (late), already held, or the buffer is full. */
  push(seq: number, data: Uint8Array): 'ok' | 'late' | 'duplicate' {
    seq >>>= 0;
    // Late only once playout has passed its slot; before playout starts, an
    // earlier frame becomes the first one (below).
    if (this.floor !== null && u32Diff(seq, this.floor) < 0) {
      this.s.late++;
      return 'late';
    }
    if (this.frames.has(seq)) {
      this.s.duplicate++;
      return 'duplicate';
    }
    this.frames.set(seq, data);
    this.s.received++;
    if (this.next === null) this.next = seq;
    else if (!this.started && u32Diff(seq, this.next) < 0) this.next = seq; // floor (above) keeps it from rewinding past played slots
    this.trim();
    return 'ok';
  }

  /** The span from the next frame to play to the newest held one, in frames. */
  private span(): number {
    if (this.next === null || !this.frames.size) return 0;
    let newest = this.next;
    for (const k of this.frames.keys()) if (u32Diff(k, newest) > 0) newest = k;
    return u32Diff(newest, this.next) + 1;
  }

  /** Over the ms cap: skip ahead to the newest frames (old audio is worth less than low delay). */
  private trim(): void {
    while (this.next !== null && this.span() > this.maxFrames) {
      if (this.frames.delete(this.next)) this.s.dropped++;
      this.next = (this.next + 1) >>> 0;
      if (this.floor !== null) this.floor = this.next;
    }
  }

  /**
   * Called by the player for each playout slot (about once per FRAME_MS, and
   * again after a 'wait' on its next tick).
   */
  pull(): Pull {
    if (this.next === null) return { kind: 'wait' };
    if (!this.started) {
      // Build up the target depth, but don't hold what we have forever: the
      // end of a sentence (or the last frames before mute) plays after a
      // short wait even if no more come.
      if (this.span() < this.targetFrames && this.frames.size && ++this.waited <= this.targetFrames * 2) return { kind: 'wait' };
      if (!this.frames.size) return { kind: 'wait' };
      this.started = true;
      this.waited = 0;
    }
    const seq = this.next;
    const data = this.frames.get(seq);
    if (data !== undefined) {
      this.frames.delete(seq);
      this.next = (seq + 1) >>> 0;
      this.floor = this.next;
      this.s.played++;
      if (++this.good >= this.shrinkAfter && this.targetFrames > this.minFrames) {
        this.targetFrames--;
        this.good = 0;
      }
      return { kind: 'frame', seq, data };
    }
    // Nothing for this slot.
    this.good = 0;
    if (!this.frames.size) {
      // Ran dry (an underrun, or the sender went quiet): buffer up again, a frame deeper.
      this.started = false;
      this.targetFrames = Math.min(this.maxFrames, this.targetFrames + 1);
      return { kind: 'wait' };
    }
    // A gap with later frames held: that frame is lost; play on.
    this.next = (seq + 1) >>> 0;
    this.floor = this.next;
    this.s.missing++;
    return { kind: 'missing', seq };
  }

  stats(): JitterStats {
    return { ...this.s, depthFrames: this.span(), targetMs: this.targetFrames * FRAME_MS };
  }
}
