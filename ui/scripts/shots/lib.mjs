// Shared setup and helpers for the screenshot scripts in this folder (see
// ../screenshots.mjs, the runner). Importing it builds the app, starts
// `vite preview` and launches Chromium, once.

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { preview } from 'vite';

export const OUT = 'screenshots';
export const PORT = 4173;
export const BASE = `http://localhost:${PORT}/`;

mkdirSync(OUT, { recursive: true });
if (!process.argv.includes('--no-build')) execSync('npx vite build', { stdio: 'inherit' });
export const server = await preview({ preview: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn' });
// A fake microphone, so the voice engine (piece D) finds one in call shots.
export const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

// Problems found while driving the built app; any of them fails the run.
export const problems = [];

export async function page(query, { width = 1366, height = 800, colorScheme = 'light', phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    locale: 'he-IL',
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  // The build carries a Content-Security-Policy; the app must run without breaking it.
  p.on('console', (m) => {
    if (m.type() === 'error' && /Content.Security.Policy/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  await p.goto(BASE + query);
  return p;
}

export const shot = async (p, name) => {
  await p.waitForTimeout(250);
  // Nothing may stick out sideways, in the page or in an open dialog.
  const overflow = await p.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll('dialog[open]')].map((el) => el.scrollWidth - el.clientWidth).find((d) => d > 1),
  );
  if (overflow) problems.push(`${name}: content is ${overflow}px wider than its box`);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', name);
};

export const PHONE_ROOMS = { width: 375, height: 812, phone: true };

export async function chat(query, name, opts) {
  const p = await page(query, opts);
  await p.getByRole('article').first().waitFor();
  await p.waitForTimeout(800);
  return p;
}

// Joining: the first room's row, then the one-time IP notice (243-244, docs/ux/specs/voice-ip-notice.md).
export async function joinRoom(p, ok = 'הבנתי') {
  await p.locator('.voice-room-row').first().click();
  await p.getByRole('dialog').getByRole('button', { name: ok }).click();
}

// ?bidi=1 adds the 9 messages of the spec's §2 table to "כללי".
export const BIDI_EXPECTED = [
  ['lol זה היה מטורף', 'rtl'],
  ['GG על המשחק אתמול, 3:1 לנו!', 'rtl'],
  ['@Itamar תבדוק את ה-patch החדש', 'rtl'],
  ['version 2.4.1 fixed the crash', 'ltr'],
  ['https://youtu.be/abcdefg תראו את זה', 'rtl'],
  ['\u200fok', 'rtl'],
  ['שלום לכולם', 'rtl'],
  ['npm run build', 'ltr'],
];

export async function checkBidi(p, name, lang, partial = false) {
  const lines = await p.evaluate(() =>
    [...document.querySelectorAll('.msg-line')].map((el) => ({
      // The whole line: since G-25 a link is its own element inside it.
      text: el.textContent ?? '',
      dir: el.getAttribute('dir'),
      align: getComputedStyle(el).textAlign,
    })),
  );
  const side = lang === 'he' ? 'right' : 'left';
  for (const [text, dir] of BIDI_EXPECTED) {
    // An edited line ends with the edited tag after the text.
    const line = lines.find((l) => l.text === text || l.text.startsWith(text + ' '));
    if (!line) {
      if (!partial) problems.push(`${name}: no message line "${text}"`);
    } else if (line.dir !== dir || line.align !== side) problems.push(`${name}: "${text}" is ${line.dir}/${line.align}, expected ${dir}/${side}`);
  }
  for (const text of ['🎉🎉', '3:1']) {
    const line = lines.find((l) => l.text === text);
    if (line && line.dir !== (lang === 'he' ? 'rtl' : 'ltr')) problems.push(`${name}: "${text}" should follow the interface`);
  }
}

export const PHONE = { width: 375, height: 812, phone: true };

export const ROOMS = '?demo=1&still=1&lang=he&theme=light&update=999999';

export async function sidebarShot(p, name) {
  await p.waitForTimeout(250);
  const box = await p.locator('nav:has(.voice-rooms)').boundingBox();
  await p.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 760) } });
  console.log('saved', name);
}
