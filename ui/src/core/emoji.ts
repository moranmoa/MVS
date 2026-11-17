/**
 * G-26: the reaction emoji check. It must match the core's
 * (`core/api/src/reaction.rs`, `normalize` and `valid_emoji`) exactly:
 * the core refuses on write and ignores on fold what this refuses.
 *
 * - One trailing U+FE0F is dropped first, so 👍 and 👍+FE0F are one chip.
 * - 1–32 UTF-8 bytes and at most 10 scalars.
 * - Elements joined by single ZWJs (never first, never last, never doubled).
 *   An element is an emoji base with at most one VS16 or skin tone straight
 *   after it, a pair of regional indicators, or a keycap `[0-9#*] FE0F? 20E3`.
 * - Never a control, bidi, whitespace or tag character (no subdivision flags
 *   in v1), and no custom emoji.
 */

export const MAX_EMOJI_BYTES = 32;
export const MAX_EMOJI_SCALARS = 10;

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;

const isSkinTone = (c: number) => c >= 0x1f3fb && c <= 0x1f3ff;
const isRegionalIndicator = (c: number) => c >= 0x1f1e6 && c <= 0x1f1ff;
const isKeycapBase = (c: number) => (c >= 0x30 && c <= 0x39) || c === 0x23 || c === 0x2a;

const BASE_RANGES: [number, number][] = [
  [0x00a9, 0x00a9], [0x00ae, 0x00ae], [0x203c, 0x203c], [0x2049, 0x2049], [0x2122, 0x2122],
  [0x2139, 0x2139], [0x2194, 0x2199], [0x21a9, 0x21aa], [0x231a, 0x231b], [0x2328, 0x2328],
  [0x23cf, 0x23cf], [0x23e9, 0x23f3], [0x23f8, 0x23fa], [0x24c2, 0x24c2], [0x25aa, 0x25ab],
  [0x25b6, 0x25b6], [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x27bf], [0x2934, 0x2935],
  [0x2b05, 0x2b07], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x3030, 0x3030],
  [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299], [0x1f000, 0x1faff],
];

function isEmojiBase(c: number): boolean {
  if (isSkinTone(c) || isRegionalIndicator(c)) return false;
  return BASE_RANGES.some(([lo, hi]) => c >= lo && c <= hi);
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** The v1 check on an already-normalized emoji. */
export function validEmoji(emoji: string): boolean {
  if (!emoji || utf8Length(emoji) > MAX_EMOJI_BYTES) return false;
  const cs = [...emoji].map((c) => c.codePointAt(0)!);
  if (cs.length > MAX_EMOJI_SCALARS) return false;
  let i = 0;
  for (;;) {
    const c = cs[i++];
    if (c === undefined) return false;
    if (isKeycapBase(c)) {
      if (cs[i] === VS16) i++;
      if (cs[i] !== KEYCAP) return false;
      i++;
    } else if (isRegionalIndicator(c)) {
      if (cs[i] === undefined || !isRegionalIndicator(cs[i])) return false;
      i++;
    } else if (isEmojiBase(c)) {
      if (cs[i] === VS16 || (cs[i] !== undefined && isSkinTone(cs[i]))) i++;
    } else {
      return false;
    }
    if (i === cs.length) return true;
    if (cs[i] !== ZWJ) return false;
    i++;
  }
}

/** The stored form of `emoji`, or `null` if the core would refuse it. */
export function normalizeEmoji(emoji: string): string | null {
  const e = emoji.endsWith('️') ? emoji.slice(0, -1) : emoji;
  return !e.endsWith('️') && validEmoji(e) ? e : null;
}
