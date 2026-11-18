// G-25: the Markdown parser (spec docs/ux/specs/markdown.md §1, §6).

import { describe, expect, it } from 'vitest';
import { parse, parseInline, plainText, SPOILER_MASK, type Inline } from '../markdown/parse';

const t = (v: string): Inline => ({ t: 'text', v });

describe('markdown: inline', () => {
  it('renders each supported marker', () => {
    expect(parseInline('**b**')).toEqual([{ t: 'bold', c: [t('b')] }]);
    expect(parseInline('*i*')).toEqual([{ t: 'italic', c: [t('i')] }]);
    expect(parseInline('_i_')).toEqual([{ t: 'italic', c: [t('i')] }]);
    expect(parseInline('~~s~~')).toEqual([{ t: 'strike', c: [t('s')] }]);
    expect(parseInline('`c`')).toEqual([{ t: 'code', v: 'c' }]);
    expect(parseInline('||x||')).toEqual([{ t: 'spoiler', c: [t('x')] }]);
    expect(parseInline('שלום **עולם** טוב')).toEqual([t('שלום '), { t: 'bold', c: [t('עולם')] }, t(' טוב')]);
  });

  it('nests: italic in bold, bold in a spoiler', () => {
    expect(parseInline('**a *b* c**')).toEqual([{ t: 'bold', c: [t('a '), { t: 'italic', c: [t('b')] }, t(' c')] }]);
    expect(parseInline('*a **b** c*')).toEqual([{ t: 'italic', c: [t('a '), { t: 'bold', c: [t('b')] }, t(' c')] }]);
    expect(parseInline('||**x**||')).toEqual([{ t: 'spoiler', c: [{ t: 'bold', c: [t('x')] }] }]);
  });

  it('criterion 2: maths, snake_case and spaced markers stay plain', () => {
    expect(parseInline('2*3*4')).toEqual([t('2*3*4')]);
    expect(parseInline('a*b*c')).toEqual([t('a'), { t: 'italic', c: [t('b')] }, t('c')]); // * counts inside a word
    expect(parseInline('* x *')).toEqual([t('* x *')]);
    expect(parseInline('a * b * c')).toEqual([t('a * b * c')]);
    expect(parseInline('snake_case_name')).toEqual([t('snake_case_name')]);
    expect(parseInline('** not bold **')).toEqual([t('** not bold **')]);
    expect(parseInline('unclosed **bold')).toEqual([t('unclosed **bold')]);
    expect(parseInline('a `tick')).toEqual([t('a `tick')]);
  });

  it('backslash escapes make markers literal', () => {
    expect(parseInline('\\*not\\*')).toEqual([t('*not*')]);
    expect(parseInline('\\*\\*a\\*\\*')).toEqual([t('**a**')]);
    expect(parseInline('a\\\\b')).toEqual([t('a\\b')]);
    expect(parseInline('\\||x||')).toEqual([t('||x||')]);
    expect(plainText('\\||x||')).toBe('||x||');
    // A backslash before anything else stays.
    expect(parseInline('C:\\dir')).toEqual([t('C:\\dir')]);
  });

  it('nothing is parsed inside code, including mentions and links', () => {
    expect(parseInline('`**x** https://a.example <@abc>`')).toEqual([{ t: 'code', v: '**x** https://a.example <@abc>' }]);
    expect(parseInline('``a ` b``')).toEqual([{ t: 'code', v: 'a ` b' }]);
  });

  it('links: https only, at a word start, trailing punctuation left out', () => {
    expect(parseInline('see https://example.org/a_b*c_d.')).toEqual([t('see '), { t: 'link', v: 'https://example.org/a_b*c_d' }, t('.')]);
    expect(parseInline('http://example.org')).toEqual([t('http://example.org')]);
    expect(parseInline('xhttps://example.org')).toEqual([t('xhttps://example.org')]);
    expect(parseInline('(https://example.org)')).toEqual([t('('), { t: 'link', v: 'https://example.org' }, t(')')]);
    expect(parseInline('**https://example.org**')).toEqual([{ t: 'bold', c: [{ t: 'link', v: 'https://example.org' }] }]);
    expect(parseInline('https://')).toEqual([t('https://')]);
  });

  it('criterion 3: mentions stay whole inside bold; markers never split them', () => {
    const id = '<@' + 'a'.repeat(64) + '>';
    expect(parseInline(`**hi ${id}**`)).toEqual([{ t: 'bold', c: [t(`hi ${id}`)] }]);
    expect(parseInline(`${id}_x_`)).toEqual([t(id), { t: 'italic', c: [t('x')] }]);
  });

  it('not in v1: headings, lists, link text and HTML stay as typed', () => {
    for (const s of ['# heading', '- item', '1. item', '[a](https://x.example)', '<b>x</b>', '__u__']) {
      const out = parseInline(s);
      const text = JSON.stringify(out);
      expect(text, s).not.toContain('"bold"');
    }
    expect(parseInline('[a](https://x.example)')).toEqual([t('[a]('), { t: 'link', v: 'https://x.example' }, t(')')]);
  });
});

describe('markdown: blocks', () => {
  it('code blocks: verbatim, the language tag ignored, nothing parsed inside', () => {
    expect(parse('before\n```js\nconst a = **1**;\n  x\n```\nafter')).toEqual([
      { t: 'line', c: [t('before')], raw: 'before' },
      { t: 'code', v: 'const a = **1**;\n  x' },
      { t: 'line', c: [t('after')], raw: 'after' },
    ]);
  });

  it('an unclosed fence stays as typed', () => {
    expect(parse('```\ncode')).toEqual([
      { t: 'line', c: [t('```')], raw: '```' },
      { t: 'line', c: [t('code')], raw: 'code' },
    ]);
  });

  it('quotes: one level, consecutive lines grouped, ">>" keeps its second ">"', () => {
    expect(parse('> a\n>b\nc')).toEqual([
      { t: 'quote', lines: [{ c: [t('a')], raw: 'a' }, { c: [t('b')], raw: 'b' }] },
      { t: 'line', c: [t('c')], raw: 'c' },
    ]);
    expect(parse('>> x')).toEqual([{ t: 'quote', lines: [{ c: [t('> x')], raw: '> x' }] }]);
    expect(parse('\\> not a quote')).toEqual([{ t: 'line', c: [t('> not a quote')], raw: '\\> not a quote' }]);
    expect(parse('a > b')[0]).toEqual({ t: 'line', c: [t('a > b')], raw: 'a > b' });
  });
});

describe('markdown: plain text (notifications, previews, copy)', () => {
  it('strips the markers and masks every spoiler, whatever its length', () => {
    expect(plainText('**bold** *it* ~~s~~ `c` ||secret words||')).toBe(`bold it s c ${SPOILER_MASK}`);
    expect(plainText('> q\n```\n**raw**\n```')).toBe('q\n**raw**');
    expect(plainText('||a **b** https://x.example||')).toBe(SPOILER_MASK);
    expect(plainText('plain')).toBe('plain');
  });
});

describe('markdown: hostile input', () => {
  it('HTML and script-looking input is only ever text or code tokens', () => {
    const inputs = [
      '<img src=x onerror=alert(1)>',
      '**<script>alert(1)</script>**',
      '[x](javascript:alert(1))',
      'javascript:alert(1)',
      'https://example.org/"onmouseover="alert(1)',
      "https://example.org/'><svg onload=alert(1)>",
      '`</code><script>x</script>`',
      '||<iframe src=https://evil.example>||',
      'data:text/html;base64,PHNjcmlwdD4=',
    ];
    const kinds = new Set<string>();
    const walk = (n: Inline[]) =>
      n.forEach((x) => {
        kinds.add(x.t);
        if (x.t === 'link') {
          expect(x.v.startsWith('https://')).toBe(true);
          expect(x.v).not.toMatch(/[\s<>"'`]/);
        }
        if ('c' in x) walk(x.c);
      });
    for (const s of inputs) walk(parseInline(s));
    expect([...kinds].every((k) => ['text', 'code', 'link', 'bold', 'spoiler'].includes(k))).toBe(true);
  });

  it('criterion 8: never throws on random input (fuzz)', () => {
    const alphabet = ['*', '_', '~', '`', '|', '>', '\\', '\n', ' ', 'a', 'א', 'https://x.example', '<@', '>', '```', '\u202e', '\u0000', '😀'];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    for (let n = 0; n < 2000; n++) {
      let s = '';
      const len = Math.floor(rnd() * 80);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(() => parse(s)).not.toThrow();
      expect(() => plainText(s)).not.toThrow();
    }
  });

  it('deep nesting stops at the depth cap instead of recursing on', () => {
    const s = '||'.repeat(50) + 'x' + '||'.repeat(50);
    expect(() => parse(s)).not.toThrow();
    const deep = '**'.repeat(1000) + 'x' + '**'.repeat(1000);
    expect(() => parse(deep)).not.toThrow();
  });

  it('criterion 8: a 4,000-character message with 50 markers parses in under 5 ms', () => {
    const unit = '**bold** some text _it_ `code` ~~s~~ ||sp|| words here and more. ';
    let msg = '';
    while (msg.length < 4000) msg += unit;
    msg = msg.slice(0, 4000);
    parse(msg); // warm up
    const runs = 20;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) parse(msg);
    expect((performance.now() - t0) / runs).toBeLessThan(5);
  });

  it('pathological input (unclosed markers everywhere) stays fast', () => {
    for (const s of ['*a '.repeat(1500), '`'.repeat(1) + ' ``'.repeat(1300), '_a '.repeat(1500), '**a '.repeat(1000), 'https://x.example/'.repeat(250), '\\'.repeat(4000)]) {
      const t0 = performance.now();
      parse(s);
      expect(performance.now() - t0, s.slice(0, 10)).toBeLessThan(50);
    }
  });
});
