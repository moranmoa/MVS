// G-62: the unread count on the taskbar / dock. The page tells main the
// total through one IPC call, `badge:set` (window.mvs.setUnreadCount), and
// main checks it: a whole number 0..9999, nothing else from the page reaches
// the OS. Windows gets an overlay icon we draw here (a red dot with 1-9 or
// "9+"; nothing at 0); macOS and Linux get the OS badge count.
'use strict';

const MAX = 9999;
/** At most this many OS updates a second; the last value always lands. */
const PER_SECOND = 4;

/** The count as the page sent it, or null if it isn't a whole number 0..MAX. */
function cleanCount(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX ? v : null;
}

/** What the overlay shows: '' (nothing), '1'..'9' or '9+'. */
function label(n) {
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

// A 3x5 pixel font, rows top to bottom, 3 bits each (left = 4).
const GLYPHS = {
  0: [7, 5, 5, 5, 7],
  1: [2, 6, 2, 2, 7],
  2: [7, 1, 7, 4, 7],
  3: [7, 1, 3, 1, 7],
  4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7],
  6: [7, 4, 7, 5, 7],
  7: [7, 1, 2, 2, 2],
  8: [7, 5, 7, 5, 7],
  9: [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0],
};

/** Overlay size in pixels; shown at 16x16 (scale factor 2). */
const SIZE = 32;
const RED = [0x23, 0x2d, 0xda]; // BGR of #da2d23
const WHITE = [0xff, 0xff, 0xff];

/**
 * The overlay for `text` as a SIZE x SIZE BGRA bitmap (premultiplied alpha),
 * for nativeImage.createFromBitmap. A red disc with white glyphs, centred.
 */
function drawBadge(text) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const r = SIZE / 2;
  // Disc, with 4x4 supersampling on its edge.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - r;
          const dy = y + (sy + 0.5) / 4 - r;
          if (dx * dx + dy * dy <= r * r) inside++;
        }
      }
      const a = inside / 16;
      const i = (y * SIZE + x) * 4;
      buf[i] = Math.round(RED[0] * a);
      buf[i + 1] = Math.round(RED[1] * a);
      buf[i + 2] = Math.round(RED[2] * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  // Glyphs: scale 4 for one character, 3 for two, one glyph pixel apart.
  const chars = [...text];
  const scale = chars.length > 1 ? 3 : 4;
  const width = (chars.length * 3 + (chars.length - 1)) * scale;
  const left = Math.round((SIZE - width) / 2);
  const top = Math.round((SIZE - 5 * scale) / 2);
  chars.forEach((c, k) => {
    const rows = GLYPHS[c];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (!(rows[gy] & (4 >> gx))) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const x = left + (k * 4 + gx) * scale + px;
            const y = top + gy * scale + py;
            const i = (y * SIZE + x) * 4;
            buf[i] = WHITE[0];
            buf[i + 1] = WHITE[1];
            buf[i + 2] = WHITE[2];
            buf[i + 3] = 255;
          }
        }
      }
    }
  });
  return buf;
}

/**
 * Applies counts to the OS. `apply(n)` does the platform work (main.js);
 * the same value twice is skipped, and at most PER_SECOND updates a second
 * go through: in between, only the latest waits and lands when the second is up.
 */
function createBadge({ apply, now = Date.now, setTimer = setTimeout }) {
  let current = 0;
  let wanted = 0;
  let times = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const t = now();
    times = times.filter((s) => t - s < 1000);
    if (wanted === current) return;
    if (times.length >= PER_SECOND) {
      timer = setTimer(flush, 1000 - (t - times[0]));
      return;
    }
    times.push(t);
    current = wanted;
    apply(current);
  };
  return {
    /** Returns false if the value was refused. */
    set(raw) {
      const n = cleanCount(raw);
      if (n === null) return false;
      wanted = n;
      if (!timer) flush();
      return true;
    },
    get current() {
      return current;
    },
  };
}

module.exports = { cleanCount, label, drawBadge, createBadge, SIZE, MAX, PER_SECOND };
