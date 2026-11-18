// G-25 §3: composer shortcuts, Enter inside a ``` fence, and the one-time hint.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { applyEdit, hintDue, insideOpenFence, shortcutMarker, wrapEdit } from '../markdown/composer';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const key = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('composer helpers', () => {
  it('Ctrl+B / I / E / Shift+X by physical key (a Hebrew layout too); nothing else', () => {
    expect(shortcutMarker(key('KeyB', { ctrlKey: true }))).toBe('**');
    expect(shortcutMarker(key('KeyI', { ctrlKey: true }))).toBe('*');
    expect(shortcutMarker(key('KeyE', { metaKey: true }))).toBe('`');
    expect(shortcutMarker(key('KeyX', { ctrlKey: true, shiftKey: true }))).toBe('~~');
    expect(shortcutMarker(key('KeyX', { ctrlKey: true }))).toBeNull(); // cut
    expect(shortcutMarker(key('KeyB'))).toBeNull();
    expect(shortcutMarker(key('KeyB', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(shortcutMarker(key('KeyB', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('wraps the selection and keeps it selected; no selection inserts a pair with the caret between', () => {
    const e = wrapEdit('say hello now', 4, 9, '**');
    expect(applyEdit('say hello now', e)).toBe('say **hello** now');
    expect([e.selStart, e.selEnd]).toEqual([6, 11]);
    const p = wrapEdit('ab', 1, 1, '`');
    expect(applyEdit('ab', p)).toBe('a``b');
    expect([p.selStart, p.selEnd]).toEqual([2, 2]);
  });

  it('a second press unwraps (a toggle); * does not unwrap half of a **', () => {
    const e = wrapEdit('say **hello** now', 6, 11, '**');
    expect(applyEdit('say **hello** now', e)).toBe('say hello now');
    expect([e.selStart, e.selEnd]).toEqual([4, 9]);
    expect(applyEdit('a **x** b', wrapEdit('a **x** b', 4, 5, '*'))).toBe('a ***x*** b');
    expect(applyEdit('a *x* b', wrapEdit('a *x* b', 3, 4, '*'))).toBe('a x b');
  });

  it('knows when the caret is inside an open fence', () => {
    expect(insideOpenFence('```js\nconst a', 13)).toBe(true);
    expect(insideOpenFence('```\nx\n```', 9)).toBe(false);
    expect(insideOpenFence('plain `code`', 12)).toBe(false);
    expect(insideOpenFence('```\nx\n```\n```\ny', 15)).toBe(true);
  });

  it('the hint is due on a marker pair, until dismissed', () => {
    localStorage.removeItem('mvs.md.hint.v1');
    expect(hintDue('a single * star')).toBe(false);
    expect(hintDue('**b')).toBe(true);
    expect(hintDue('`x`')).toBe(true);
    localStorage.setItem('mvs.md.hint.v1', 'dismissed');
    expect(hintDue('**b**')).toBe(false);
    localStorage.removeItem('mvs.md.hint.v1');
  });
});

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

describe('the composer (G-25 §3)', () => {
  beforeEach(() => localStorage.removeItem('mvs.md.hint.v1'));
  afterEach(() => localStorage.removeItem('mvs.md.hint.v1'));

  async function composer() {
    render(<App core={new MockCore({ demo: true, speed: 0, simulateActivity: false })} initialSettings={en} />);
    return (await screen.findByRole('textbox', { name: /^Message / })) as HTMLTextAreaElement;
  }

  it('Ctrl+B wraps the selection in ** (jsdom has no execCommand: the fallback path)', async () => {
    const box = await composer();
    fireEvent.change(box, { target: { value: 'make this bold' } });
    box.setSelectionRange(10, 14);
    await act(async () => {
      fireEvent.keyDown(box, { key: 'b', code: 'KeyB', ctrlKey: true });
    });
    expect(box.value).toBe('make this **bold**');
  });

  it('a Hebrew layout: Ctrl+נ (KeyB) still makes bold', async () => {
    const box = await composer();
    fireEvent.change(box, { target: { value: 'שלום' } });
    box.setSelectionRange(0, 4);
    await act(async () => {
      fireEvent.keyDown(box, { key: 'נ', code: 'KeyB', ctrlKey: true });
    });
    expect(box.value).toBe('**שלום**');
  });

  it('Enter inside an open ``` fence does not send; after the fence closes it does', async () => {
    const box = await composer();
    fireEvent.change(box, { target: { value: '```\nconst a = 1;' } });
    box.setSelectionRange(box.value.length, box.value.length);
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(box.value).toBe('```\nconst a = 1;');
    fireEvent.change(box, { target: { value: '```\nconst a = 1;\n```' } });
    box.setSelectionRange(box.value.length, box.value.length);
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(box.value).toBe('');
  });

  it('the hint shows once markers are typed, and ✕ dismisses it for good', async () => {
    const box = await composer();
    expect(screen.queryByText(/You can format/)).toBeNull();
    fireEvent.change(box, { target: { value: '**hi' } });
    expect(screen.getByText(/You can format/)).toBeTruthy();
    const hint = screen.getByText(/You can format/).closest('.composer-hint')!;
    await act(async () => {
      fireEvent.click(hint.querySelector('button')!);
    });
    expect(screen.queryByText(/You can format/)).toBeNull();
    expect(localStorage.getItem('mvs.md.hint.v1')).toBe('dismissed');
    fireEvent.change(box, { target: { value: '**hi** `x`' } });
    expect(screen.queryByText(/You can format/)).toBeNull();
  });
});
