// B20 (UX-13, G-112): WCAG AA contrast for the theme tokens. Reads theme.css
// itself, so a token change that drops below 4.5:1 fails here. It also checks
// that the system-dark block is the same as the dark one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'styles', 'theme.css'), 'utf8');

function tokens(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = tokens(":root,\n:root[data-theme='light']");
const dark = tokens(":root[data-theme='dark']");
const systemDark = tokens("  :root[data-theme='system']");

type Rgb = [number, number, number];
function rgb(value: string, under: Rgb): Rgb {
  if (value.startsWith('#')) {
    const h = value.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) throw new Error(`colour? ${value}`);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return [r, g, b].map((v, i) => Math.round(v * a + under[i] * (1 - a))) as Rgb;
}
const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Text tokens and the surfaces text sits on (the rail only has icons). */
const TEXT = ['text', 'text-muted', 'text-faint', 'accent', 'danger', 'success', 'warning-text'];
const SURFACES = ['bg-main', 'bg-elevated', 'bg-sidebar', 'bg-app', 'bg-input'];

describe.each([
  ['light', light],
  ['dark', dark],
])('AA contrast, %s theme (B20)', (_name, t) => {
  const surface = (name: string): Rgb => rgb(t[name], [255, 255, 255]);
  const on = (fg: string, bg: Rgb): number => ratio(rgb(t[fg] ?? fg, bg), bg);

  it.each(TEXT)('--%s is at least 4.5:1 on every surface', (fg) => {
    for (const s of SURFACES) expect(on(fg, surface(s)), `${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it('text on filled backgrounds: buttons, badges, the update pill, the warning bar', () => {
    const pairs: [string, string][] = [
      ['accent-text', 'accent'],
      ['on-danger', 'danger'],
      ['#ffffff', 'badge'],
      ['accent-text', 'update'],
      ['warning-text', 'warning-bg'],
    ];
    for (const [fg, bg] of pairs) expect(on(fg, rgb(t[bg], surface('bg-main'))), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('status dots and the focus ring are at least 3:1 (non-text, WCAG 1.4.11)', () => {
    for (const fg of ['online', 'offline', 'focus']) {
      for (const s of ['bg-main', 'bg-elevated', 'bg-sidebar']) expect(on(fg, surface(s)), `${fg} on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('accent on accent-soft (mention chips) on the chat and the sidebar', () => {
    for (const s of ['bg-main', 'bg-sidebar']) {
      expect(on('accent', rgb(t['accent-soft'], surface(s))), `accent on accent-soft over ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('theme blocks', () => {
  it('the system-dark block has exactly the dark tokens', () => {
    expect(systemDark).toEqual(dark);
  });
});
