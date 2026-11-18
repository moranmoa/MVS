// G-82: who is speaking, from an audio level sampled about 10 times a second.
// Local only: nothing here is ever sent. The level must stay over the
// threshold for SPEAK_ON_MS before someone counts as speaking, and under it
// for SPEAK_OFF_MS before they stop, so a click doesn't light the ring and a
// breath between words doesn't make it flicker.

/** Over the threshold this long before "speaking". */
export const SPEAK_ON_MS = 150;
/** Quiet this long before "not speaking". */
export const SPEAK_OFF_MS = 400;
/** The weight of a new sample in the smoothed level (an exponential moving average). */
export const LEVEL_SMOOTHING = 0.4;

export interface SpeakState {
  /** Shown as speaking now. */
  on: boolean;
  /** The smoothed level, 0..1 (for display). */
  level: number;
  /** When the level went over the threshold (this run), or null while under it. */
  loudSince: number | null;
  /** The last time the level was over the threshold. */
  lastLoud: number;
}

export const quiet = (): SpeakState => ({ on: false, level: 0, loudSince: null, lastLoud: -Infinity });

/** The next state after a raw level sample (RMS, 0..1) taken at `now` (ms). */
export function stepSpeaking(s: SpeakState, sample: number, now: number, threshold: number): SpeakState {
  const raw = Number.isFinite(sample) && sample > 0 ? sample : 0;
  // Loud or quiet by the raw sample; the 150 ms onset and the 400 ms release
  // are what keep a click from lighting it and a pause from flickering it.
  // The smoothed level is for display only.
  const level = s.level + (raw - s.level) * LEVEL_SMOOTHING;
  if (raw > threshold) {
    const loudSince = s.loudSince ?? now;
    return { level, loudSince, lastLoud: now, on: s.on || now - loudSince >= SPEAK_ON_MS };
  }
  return { level, loudSince: null, lastLoud: s.lastLoud, on: s.on && now - s.lastLoud < SPEAK_OFF_MS };
}

/** The RMS level of a block of samples. */
export function rms(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!;
  return buffer.length ? Math.sqrt(sum / buffer.length) : 0;
}
