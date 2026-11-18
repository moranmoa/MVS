// G-25: Markdown as React elements: what reaches the DOM.

import { act, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntlProvider } from 'react-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import he from '../i18n/he.json';
import { MarkdownBody, safeHref } from '../markdown/render';

describe('markdown: hidden spoiler CSS (source rule)', () => {
  // color: transparent alone leaks colour emoji and chip/code backgrounds.
  it('hides the content outright, not just its colour', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'markdown.css'), 'utf8');
    expect(css).toMatch(/\.md-spoiler:not\(\.revealed\) > span \{\s*visibility: hidden;\s*\}/);
  });
});

describe('markdown: safeHref', () => {
  it('https with a host only; credentials and other schemes refused', () => {
    expect(safeHref('https://example.org/a?b=1#c')).toBe('https://example.org/a?b=1#c');
    for (const bad of ['http://example.org', 'javascript:alert(1)', 'https://user:pw@example.org', 'https://user@example.org', 'data:text/html,x', 'mvs://invite/x', 'https://', 'not a url'])
      expect(safeHref(bad), bad).toBeNull();
    // Look-alike hosts come out in punycode, as the shell's prompt shows them.
    expect(safeHref('https://exаmple.org')).toMatch(/^https:\/\/xn--/);
  });
});

const show = (text: string, opts: { locale?: 'en' | 'he'; renderText?: (t: string) => React.ReactNode; trailing?: React.ReactNode } = {}) => {
  const locale = opts.locale ?? 'en';
  return render(
    <IntlProvider locale={locale} messages={locale === 'he' ? he : en}>
      <div className="msg-body">
        <MarkdownBody text={text} uiDir={locale === 'he' ? 'rtl' : 'ltr'} renderText={opts.renderText ?? ((t) => t)} trailing={opts.trailing} />
      </div>
    </IntlProvider>,
  ).container;
};

afterEach(() => {
  vi.useRealTimers();
  delete (window as { mvs?: unknown }).mvs;
});

describe('markdown: rendering', () => {
  it('criterion 1: each marker as its element', () => {
    const c = show('**b** *i* ~~s~~ `c` > not quote');
    expect(c.querySelector('strong.md-bold')!.textContent).toBe('b');
    expect(c.querySelector('em')!.textContent).toBe('i');
    expect(c.querySelector('s')!.textContent).toBe('s');
    const code = c.querySelector('code.md-code')!;
    expect(code.textContent).toBe('c');
    expect(code.parentElement!.tagName).toBe('BDI');
    expect(code.parentElement!.getAttribute('dir')).toBe('ltr');
  });

  it('one .msg-line per line with its own direction (B17), trailing on the last', () => {
    const c = show('שלום **עולם**\nhello there', { locale: 'he', trailing: <span className="edited">(edited)</span> });
    const lines = [...c.querySelectorAll('.msg-body > .msg-line')];
    expect(lines.map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(lines[1]!.querySelector('.edited')).not.toBeNull();
    expect(lines[0]!.querySelector('.edited')).toBeNull();
  });

  it('a plain message renders as plain lines (the fast path)', () => {
    const c = show('just text\nsecond');
    expect([...c.querySelectorAll('.msg-line')].map((l) => l.textContent)).toEqual(['just text', 'second']);
  });

  it('criterion 5: a Hebrew quote in an English message is RTL (bar on the right)', () => {
    const c = show('Look:\n> זה ציטוט בעברית\nok');
    const q = c.querySelector('blockquote.md-quote')!;
    expect(q.getAttribute('dir')).toBe('rtl');
    expect(q.textContent).toBe('זה ציטוט בעברית');
  });

  it('code blocks: LTR, verbatim, with a copy button that copies exactly the block', async () => {
    const copied: string[] = [];
    (window as { mvs?: unknown }).mvs = { copyText: async (t: string) => (copied.push(t), true) };
    const long = 'x'.repeat(200);
    const c = show(`שלום\n\`\`\`sh\nnpm i **x**\n${long}\n\`\`\``, { locale: 'he' });
    const block = c.querySelector('.md-code-block')!;
    expect(block.getAttribute('dir')).toBe('ltr');
    expect(block.querySelector('pre')!.textContent).toBe(`npm i **x**\n${long}`);
    expect(block.querySelector('strong')).toBeNull();
    const btn = block.querySelector('button.md-copy')!;
    expect(btn.getAttribute('aria-label')).toBe('העתקה');
    await act(async () => fireEvent.click(btn));
    expect(copied).toEqual([`npm i **x**\n${long}`]);
    expect(btn.getAttribute('aria-label')).toBe('הועתק');
  });

  it('spoiler: hidden from screen readers until revealed, then shown', () => {
    const c = show('the end: ||he was the ghost||');
    const btn = c.querySelector('button.md-spoiler')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Spoiler, click to reveal');
    expect(btn.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(btn);
    expect(c.querySelector('button.md-spoiler')).toBeNull();
    const shown = c.querySelector('span.md-spoiler.revealed')!;
    expect(shown.textContent).toBe('he was the ghost');
    expect(shown.closest('[aria-hidden]')).toBeNull();
  });

  it('a link inside a hidden spoiler is not clickable until revealed', () => {
    const c = show('||https://example.org/x||');
    expect(c.querySelector('a')).toBeNull();
    fireEvent.click(c.querySelector('button.md-spoiler')!);
    expect(c.querySelector('a')!.getAttribute('href')).toBe('https://example.org/x');
  });

  it('criterion 3: mentions render inside bold, not inside code', () => {
    const chip = (t: string) => t.replace(/<@\w+>/g, '@Dana');
    const id = '<@' + 'a'.repeat(64) + '>';
    const c = show(`**hi ${id}** \`${id}\``, { renderText: chip });
    expect(c.querySelector('strong')!.textContent).toBe('hi @Dana');
    expect(c.querySelector('code')!.textContent).toBe(id);
  });

  it('links open in a new window (the shell asks first), https only, noopener', () => {
    const c = show('see https://example.org/a and http://plain.example');
    const links = [...c.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.org/a');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('markdown: hostile input never becomes markup', () => {
  const hostile = [
    '<img src=x onerror="window.__pwned=1">',
    '**<script>window.__pwned=1</script>**',
    '[x](javascript:window.__pwned=1)',
    '> <svg onload="window.__pwned=1">',
    '```\n</code></pre><img src=x onerror="window.__pwned=1">\n```',
    '||<iframe srcdoc="<script>parent.__pwned=1</script>">||',
    'https://example.org/"><img src=x onerror="window.__pwned=1">',
    "https://example.org/'onmouseover='window.__pwned=1",
    'javascript:window.__pwned=1',
    '`<b>x</b>` ~~<a href="javascript:window.__pwned=1">y</a>~~',
  ];

  it.each(hostile)('%s', (s) => {
    const c = show(s);
    // Only the elements the renderer makes, nothing from the text.
    const allowed = new Set(['DIV', 'SPAN', 'STRONG', 'EM', 'S', 'CODE', 'BDI', 'PRE', 'BLOCKQUOTE', 'BUTTON', 'A', 'SVG', 'RECT', 'PATH']);
    for (const el of c.querySelectorAll('*')) expect(allowed.has(el.tagName.toUpperCase()), el.tagName).toBe(true);
    for (const a of c.querySelectorAll('a')) {
      expect(a.getAttribute('href')!.startsWith('https://')).toBe(true);
      expect(a.getAttribute('href')).not.toMatch(/[\s<>"'`]/);
    }
    for (const el of c.querySelectorAll('*'))
      for (const attr of el.getAttributeNames()) expect(attr.startsWith('on'), `${el.tagName} ${attr}`).toBe(false);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // The text is all still there, as text.
    expect(c.textContent).toContain('pwned');
  });
});
