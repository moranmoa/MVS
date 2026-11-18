// G-82: the level → speaking state machine.

import { describe, expect, it } from 'vitest';
import { quiet, rms, SPEAK_OFF_MS, SPEAK_ON_MS, stepSpeaking, type SpeakState } from './speaking';

const T = 0.02;
/** Feeds one sample every 100 ms (the engine's rate); returns the "on" after each. */
function run(samples: number[], from: SpeakState = quiet(), start = 0): { on: boolean[]; last: SpeakState } {
  let s = from;
  const on: boolean[] = [];
  samples.forEach((x, i) => {
    s = stepSpeaking(s, x, start + i * 100, T);
    on.push(s.on);
  });
  return { on, last: s };
}

describe('G-82 speaking', () => {
  it('turns on only after the level stays up for 150 ms', () => {
    expect(SPEAK_ON_MS).toBe(150);
    // Samples at 0, 100, 200 ms: on at the third (200 ms >= 150 ms).
    expect(run([0.2, 0.2, 0.2]).on).toEqual([false, false, true]);
  });

  it('a single click or pop never lights it', () => {
    expect(run([0.5, 0, 0, 0, 0.5, 0, 0]).on.every((x) => !x)).toBe(true);
  });

  it('stays on through short pauses, and turns off after 400 ms of quiet', () => {
    expect(SPEAK_OFF_MS).toBe(400);
    const talking = run([0.2, 0.2, 0.2, 0.2]).last; // on, last loud at 300 ms
    // A 200 ms breath, then talking again: never off.
    expect(run([0, 0, 0.2, 0.2], talking, 400).on).toEqual([true, true, true, true]);
    // Then silence: the smoothed level drops under the threshold, and 400 ms after
    // the last loud sample the ring goes off.
    const after = run([0, 0, 0, 0, 0, 0, 0, 0], talking, 400).on;
    expect(after.slice(0, 2)).toEqual([true, true]);
    expect(after.at(-1)).toBe(false);
    expect(after.indexOf(false)).toBeGreaterThan(0);
  });

  it('smooths the level: a noisy signal near the threshold doesn’t flicker', () => {
    // Alternating just over and just under: the smoothed level stays between.
    const { on } = run(Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.03 : 0.025)));
    const flips = on.slice(1).filter((x, i) => x !== on[i]).length;
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('ignores junk samples', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(run([bad, bad, bad, bad]).on.every((x) => !x), String(bad)).toBe(true);
    }
  });

  it('rms', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
