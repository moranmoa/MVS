// G-25: basic Markdown in messages (spec docs/ux/specs/markdown.md).
//
// Display only: the message stays plain text on the wire and in the store.
// This module turns that text into a small token tree; render.tsx turns the
// tree into React elements. Nothing here produces HTML, and no input makes
// it throw (a fuzz test checks that).
//
// Supported: **bold**, *italic* / _italic_, ~~strike~~, `code`, ``` blocks,
// one level of "> quote", ||spoiler||, backslash escapes, and bare https://
// links. Everything else (headings, lists, [text](url), HTML) stays as typed.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string }
  | { t: 'bold' | 'italic' | 'strike' | 'spoiler'; c: Inline[] };

export type Block =
  | { t: 'line'; c: Inline[]; raw: string }
  | { t: 'quote'; lines: { c: Inline[]; raw: string }[] }
  | { t: 'code'; v: string };

/** Characters a backslash makes literal. */
const ESCAPABLE = new Set(['*', '_', '~', '`', '|', '>', '\\']);
/** Bold inside italic inside a spoiler...: deeper nesting stays as typed. */
const MAX_DEPTH = 5;
/** A bare link: only https (the desktop shell opens nothing else). */
// No format characters (LRM, RLM, ZWJ...) either: the shown link is its href.
const LINK = /^https:\/\/[^\s<>"'`\p{Cf}]+/u;
/** Trailing characters that end a sentence rather than the link. */
const LINK_TRAIL = new Set([...'.,;:!?)]}\'"*_~|']);
const MENTION = /^<@[^>\s]{1,128}>/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

const isWord = (ch: string | undefined) => ch !== undefined && WORD.test(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';
const isSpace = (ch: string | undefined) => ch === undefined || SPACE.test(ch);

/** The run of `ch` starting at i. */
function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/**
 * For the string last searched: per run length, the earliest position from
 * which no closing run exists. A run with no closer from i has none from any
 * later i either, so unclosed backticks cost one scan, not one per marker.
 */
let codeMemo: { s: string; none: Map<number, number> } = { s: '', none: new Map() };

/** Where a closing run of exactly n backticks starts after i, or -1. */
function codeCloser(s: string, from: number, n: number): number {
  if (codeMemo.s !== s) codeMemo = { s, none: new Map() };
  const none = codeMemo.none.get(n);
  if (none !== undefined && from >= none) return -1;
  let k = s.indexOf('`', from);
  while (k !== -1) {
    const r = runLength(s, k, '`');
    if (r === n) return k;
    k = s.indexOf('`', k + r);
  }
  codeMemo.none.set(n, none === undefined ? from : Math.min(from, none));
  return -1;
}

/** Trailing punctuation off a link, keeping a ")" that closes a "(" in it: Foo_(bar). */
function trimLink(url: string): string {
  // Counted once, then kept up to date: linear in the URL's length (SL review).
  let open = 0;
  let close = 0;
  for (const ch of url) {
    if (ch === '(') open++;
    else if (ch === ')') close++;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1]!;
    if (!LINK_TRAIL.has(last)) break;
    if (last === ')') {
      if (open >= close) break;
      close--;
    }
    end--;
  }
  return url.slice(0, end);
}

/** A link at i (when it starts a word), with its trailing punctuation left out. */
function linkAt(s: string, i: number): string | null {
  if (!s.startsWith('https://', i) || isWord(s[i - 1])) return null;
  const m = LINK.exec(s.slice(i, i + 2048));
  if (!m) return null;
  const url = trimLink(m[0]);
  return url.length > 'https://'.length ? url : null;
}

/**
 * The end of an atomic token at i (an escape, a code span, a link or a
 * mention), which no emphasis marker can split; -1 when there is none.
 */
function atomEnd(s: string, i: number): number {
  const ch = s[i];
  if (ch === '\\' && ESCAPABLE.has(s[i + 1] ?? '')) return i + 2;
  if (ch === '`') {
    const n = runLength(s, i, '`');
    const k = codeCloser(s, i + n, n);
    return k === -1 ? -1 : k + n;
  }
  if (ch === 'h') {
    const url = linkAt(s, i);
    return url ? i + url.length : -1;
  }
  if (ch === '<') {
    const m = MENTION.exec(s.slice(i, i + 140));
    return m ? i + m[0].length : -1;
  }
  return -1;
}

type Marker = { d: string; t: 'bold' | 'italic' | 'strike' | 'spoiler' };

/** The emphasis marker that opens at i, if the text right after it isn't a space. */
function openerAt(s: string, i: number): Marker | null {
  const two = s.slice(i, i + 2);
  let m: Marker | null = null;
  if (two === '**') m = { d: '**', t: 'bold' };
  else if (two === '~~') m = { d: '~~', t: 'strike' };
  else if (two === '||') m = { d: '||', t: 'spoiler' };
  // Between two digits a * is maths (2*3*4), not a marker.
  else if (s[i] === '*' && !(isDigit(s[i - 1]) && isDigit(s[i + 1]))) m = { d: '*', t: 'italic' };
  // "_" counts only at the start of a word: snake_case_name stays plain.
  else if (s[i] === '_' && !isWord(s[i - 1])) m = { d: '_', t: 'italic' };
  if (!m || isSpace(s[i + m.d.length])) return null;
  return m;
}

/** Where the closer for `m` (opened at `open`) starts, or -1. */
function findCloser(s: string, open: number, m: Marker): number {
  let k = open + m.d.length + 1; // at least one character inside
  while (k < s.length) {
    const end = atomEnd(s, k);
    if (end !== -1) {
      k = end;
      continue;
    }
    if (s.startsWith(m.d, k) && !isSpace(s[k - 1])) {
      if (m.d === '*') {
        // A single * next to another is part of a ** pair, not this closer.
        if (s[k + 1] !== '*' && s[k - 1] !== '*') return k;
      } else if (m.d === '_') {
        if (!isWord(s[k + 1])) return k;
      } else {
        return k;
      }
    }
    k++;
  }
  return -1;
}

/** One line (or the inside of a marker) as inline tokens. */
export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  // A marker with no closer from i has none from any later i either.
  const noCloser = new Set<string>();
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && ESCAPABLE.has(s[i + 1] ?? '')) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const n = runLength(s, i, '`');
      const k = codeCloser(s, i + n, n);
      if (k !== -1) {
        flush();
        out.push({ t: 'code', v: s.slice(i + n, k) });
        i = k + n;
      } else {
        text += s.slice(i, i + n); // no closer: the backticks stay as typed
        i += n;
      }
      continue;
    }
    const url = linkAt(s, i);
    if (url) {
      flush();
      out.push({ t: 'link', v: url });
      i += url.length;
      continue;
    }
    if (ch === '<') {
      const m = MENTION.exec(s.slice(i, i + 140));
      if (m) {
        text += m[0]; // left whole for the mention chips
        i += m[0].length;
        continue;
      }
    }
    const m = depth < MAX_DEPTH ? openerAt(s, i) : null;
    if (m && !noCloser.has(m.d)) {
      const k = findCloser(s, i, m);
      if (k !== -1) {
        flush();
        out.push({ t: m.t, c: parseInline(s.slice(i + m.d.length, k), depth + 1) });
        i = k + m.d.length;
        continue;
      }
      noCloser.add(m.d);
    }
    // An unmatched marker stays as typed (both characters of a pair).
    const step = m ? m.d.length : 1;
    text += s.slice(i, i + step);
    i += step;
  }
  flush();
  return out;
}

const FENCE_OPEN = /^\s{0,3}```[^`]*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;

/** The quote's text when the line is a quote (">" at its start), else null. */
function quoteText(line: string): string | null {
  if (!line.startsWith('>')) return null;
  return line.slice(line[1] === ' ' ? 2 : 1);
}

/** A whole message as blocks: lines, quotes (one level) and code blocks. */
export function parse(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_OPEN.test(line)) {
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (FENCE_CLOSE.test(lines[j]!)) {
          end = j;
          break;
        }
      }
      if (end !== -1) {
        // The language tag after the fence is ignored in v1.
        out.push({ t: 'code', v: lines.slice(i + 1, end).join('\n') });
        i = end;
        continue;
      }
      // An unclosed fence: shown as typed.
    }
    const q = quoteText(line);
    if (q !== null) {
      const last = out[out.length - 1];
      const entry = { c: parseInline(q), raw: q };
      if (last?.t === 'quote') last.lines.push(entry);
      else out.push({ t: 'quote', lines: [entry] });
      continue;
    }
    out.push({ t: 'line', c: parseInline(line), raw: line });
  }
  return out;
}

/** What a hidden spoiler shows in plain text, whatever its length. */
export const SPOILER_MASK = '▮▮▮▮';

function inlinePlain(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' || n.t === 'link' ? n.v : n.t === 'spoiler' ? SPOILER_MASK : inlinePlain(n.c)))
    .join('');
}

/**
 * The message as plain text with the markers gone and every spoiler masked:
 * for notifications, reply previews, screen-reader announcements and copy.
 */
export function plainText(text: string): string {
  return parse(text)
    .map((b) => (b.t === 'code' ? b.v : b.t === 'quote' ? b.lines.map((l) => inlinePlain(l.c)).join('\n') : inlinePlain(b.c)))
    .join('\n');
}

/**
 * A reply excerpt as plain text. The excerpt is cut at EXCERPT_MAX, which can
 * fall inside a spoiler and drop its closing "||": then the hidden text would
 * show. So on a cut excerpt (ending in "…"), everything from the first "||"
 * of its last line is masked, whatever the pairing. On any other excerpt, a
 * "||" left over after parsing (an unpaired one, however it got cut) masks
 * the rest too. Over-masking a preview is fine; leaking a spoiler is not.
 */
export function excerptText(excerpt: string): string {
  if (excerpt.endsWith('…')) {
    const bars = excerpt.indexOf('||', excerpt.lastIndexOf('\n') + 1);
    if (bars !== -1) return plainText(excerpt.slice(0, bars)) + SPOILER_MASK;
  }
  const out = plainText(excerpt);
  const left = out.indexOf('||', out.lastIndexOf('\n') + 1);
  return left === -1 ? out : out.slice(0, left) + SPOILER_MASK;
}

/** True when the text has anything this module would format (a fast path for plain messages). */
export function hasMarkdown(text: string): boolean {
  return /[*_~`|>\\]|https:\/\//.test(text);
}
