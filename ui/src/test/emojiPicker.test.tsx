// G-27: the full emoji picker (docs/ux/specs/emoji-picker.md §7): the bundle,
// search in both languages, the keyboard, the two modes and the bottom sheet.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from '../components/EmojiPicker';
import { normalizeEmoji } from '../core/emoji';
import { GROUPS, loadEmoji, search } from '../emoji';
import raw from '../emoji/data.json';
import en from '../i18n/en.json';
import he from '../i18n/he.json';

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.documentElement.dir = '';
});

describe('the emoji bundle', () => {
  it('has all 9 groups, and every emoji passes the reaction check, without skin tones or tag flags', async () => {
    const data = await loadEmoji();
    expect(raw.emoji.length).toBe(data.list.length);
    for (const g of GROUPS) expect(data.list.some((e) => e.group === g)).toBe(true);
    for (const [glyph] of raw.emoji as [string][]) {
      expect(normalizeEmoji(glyph), glyph).not.toBeNull();
      const cps = [...glyph].map((c) => c.codePointAt(0)!);
      expect(cps.some((c) => (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0xe0020 && c <= 0xe007f)), glyph).toBe(false);
    }
    expect(data.list.every((e) => e.he && e.en)).toBe(true);
  });

  it('"לב", "heart" and "Heart" all find ❤️; niqqud and case are ignored', async () => {
    const data = await loadEmoji();
    for (const q of ['לב', 'heart', 'Heart', 'לֵב', 'red heart']) {
      expect(search(data, q).map((e) => e.glyph), q).toContain('❤️');
    }
    expect(search(data, 'zzzz-nothing')).toEqual([]);
  });
});

function Harness({ locale = 'en', mode = 'composer', selected, onPick = () => {} }: { locale?: 'en' | 'he'; mode?: 'composer' | 'reaction'; selected?: Set<string>; onPick?: (e: string, keep: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <IntlProvider locale={locale} messages={locale === 'he' ? he : en}>
      <div dir={locale === 'he' ? 'rtl' : 'ltr'}>
        <button ref={btn} type="button" onClick={() => setOpen(true)}>
          open
        </button>
        <EmojiPicker mode={mode} open={open} anchor={btn.current} selected={selected} onClose={() => setOpen(false)} onPick={onPick} />
      </div>
    </IntlProvider>
  );
}

async function openPicker(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
  });
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('grid');
  return dialog;
}

describe('EmojiPicker (G-27)', () => {
  it('opens with focus in search, sections with headings, and tabs; a tab click marks nothing new without layout but scrolls', async () => {
    const dialog = await openPicker();
    expect(document.activeElement).toBe(within(dialog).getByRole('searchbox', { name: 'Search emoji' }));
    expect(within(dialog).getByRole('heading', { name: 'Smileys & emotion' })).toBeTruthy();
    // No recent yet: no recent tab; 9 group tabs, the first selected.
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Smileys & emotion', 'People & body', 'Animals & nature', 'Food & drink', 'Travel & places', 'Activities', 'Objects', 'Symbols', 'Flags']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    // The first cell is the one tab stop of the grid (roving).
    const cells = within(dialog).getAllByRole('gridcell');
    expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(cells[0].getAttribute('aria-label')).toBe('grinning face');
  });

  it('search replaces the sections, dims the tabs, says when nothing is found; Enter picks the first', async () => {
    const onPick = vi.fn();
    const dialog = await openPicker({ onPick });
    const box = within(dialog).getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'heart' } });
    expect(within(dialog).queryByRole('heading')).toBeNull();
    expect(within(dialog).getAllByRole('gridcell').map((c) => c.textContent)).toContain('❤️');
    expect(within(dialog).getAllByRole('tab').every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.change(box, { target: { value: 'zzzz-nothing' } });
    expect(within(dialog).getByRole('status').textContent).toBe('No emoji found');
    fireEvent.change(box, { target: { value: 'red heart' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('❤️', false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keyboard only: ↓ enters the grid, ← moves forward in Hebrew, Enter picks, Esc closes back to the trigger', async () => {
    document.documentElement.dir = 'rtl';
    const onPick = vi.fn();
    const dialog = await openPicker({ locale: 'he', onPick });
    const box = within(dialog).getByRole('searchbox', { name: "חיפוש אמוג'י" });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const cells = () => within(dialog).getAllByRole('gridcell');
    await waitFor(() => expect(document.activeElement).toBe(cells()[0]));
    expect(cells()[0].getAttribute('aria-label')).toBe('חיוך רחב');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(cells()[1]));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(cells()[9]));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(cells()[15]));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect(document.activeElement).toBe(cells()[8]));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(cells()[0]));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', shiftKey: true });
    expect(onPick).toHaveBeenLastCalledWith('😀', true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Recent shows straight away after a kept-open pick.
    expect(within(dialog).getByRole('tab', { name: 'אחרונים' })).toBeTruthy();
    await act(async () => {
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'open' }));
  });

  it('composer mode: a click inserts and closes; Shift+click keeps it open', async () => {
    const onPick = vi.fn();
    const dialog = await openPicker({ onPick });
    fireEvent.click(within(dialog).getAllByRole('gridcell')[1], { shiftKey: true });
    expect(onPick).toHaveBeenLastCalledWith('😃', true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('gridcell').find((c) => c.textContent === '😀')!);
    expect(onPick).toHaveBeenLastCalledWith('😀', false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reaction mode: mine shows selected, and the pick hands back the reaction form', async () => {
    const onPick = vi.fn();
    const dialog = await openPicker({ mode: 'reaction', selected: new Set(['😃']), onPick });
    const cells = within(dialog).getAllByRole('gridcell');
    expect(cells[1].getAttribute('aria-selected')).toBe('true');
    expect(cells[1].classList.contains('mine')).toBe(true);
    expect(cells[0].getAttribute('aria-selected')).toBe('false');
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'red heart' } });
    fireEvent.click(within(dialog).getByRole('gridcell', { name: 'red heart' }));
    // ❤️ → ❤ (one trailing VS16 dropped), as the core keys it.
    expect(onPick).toHaveBeenLastCalledWith('❤', false);
  });

  it('a tab scrolls its section to the top', async () => {
    const dialog = await openPicker();
    const scroll = dialog.querySelector('.emoji-scroll') as HTMLElement;
    const spy = vi.fn();
    scroll.scrollTo = spy as unknown as typeof scroll.scrollTo;
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Flags' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('on a 375px-wide window it opens as a bottom sheet', async () => {
    const w = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    try {
      const dialog = await openPicker();
      expect(dialog.classList.contains('sheet')).toBe(true);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    }
  });
});
