// G-92 (UX on #546's thread): Home says "Your account is ready. What now?" on
// the first visit after sign-up only, and its join card takes a pasted invite
// link in place: not a link → the error under the field; a link → the join
// dialog carries on from where Home started it.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { markFirstRun, takeFirstRun } from '../app/firstRun';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

beforeEach(() => localStorage.clear());

async function home(core = new MockCore({ demo: true, speed: 0, simulateActivity: false })) {
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  fireEvent.click(screen.getByRole('button', { name: 'Home' }));
  await screen.findByRole('heading', { level: 1 });
  return core;
}

describe('the first-run flag', () => {
  it('is taken once', () => {
    expect(takeFirstRun()).toBe(false);
    markFirstRun();
    expect(takeFirstRun()).toBe(true);
    expect(takeFirstRun()).toBe(false);
  });
});

describe('Home after sign-up (G-92)', () => {
  it('the first visit says the account is ready; the next one is the usual Home', async () => {
    markFirstRun();
    await home();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your account is ready. What now?');
    expect(screen.getByText('Create a new server, or join one with a link you got.')).toBeTruthy();
    // Away and back: the usual title.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.rail button[data-server-id]')!);
    await screen.findByRole('textbox', { name: /^Message / });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Welcome');
  });

  it('without the flag, Home is as before', async () => {
    await home();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome');
  });

  it('a pasted text that is not a link: the error under the field, no dialog, and nothing read from the clipboard', async () => {
    const read = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: read, writeText: vi.fn() } });
    await home();
    const field = screen.getByRole('textbox', { name: 'Paste an invite link' });
    expect(field.getAttribute('dir')).toBe('ltr');
    fireEvent.change(field, { target: { value: 'hello there' } });
    await act(async () => {
      fireEvent.submit(field.closest('form')!);
    });
    expect((await screen.findByRole('alert')).textContent).toBe("That doesn't look like an invite link. Check it was copied in full.");
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('dialog', { name: 'Join a server' })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    // Typing again clears it.
    fireEvent.change(field, { target: { value: 'mvp://join/' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a link: Enter joins through the usual dialog, which carries on from Home', async () => {
    // Spied before the app wraps the core (guardCore keeps the method it was given).
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const join = vi.spyOn(core, 'joinServer');
    await home(core);
    const field = screen.getByRole('textbox', { name: 'Paste an invite link' });
    fireEvent.change(field, { target: { value: '  mvp://join/abc123  ' } });
    await act(async () => {
      fireEvent.submit(field.closest('form')!);
    });
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenLastCalledWith('mvp://join/abc123');
    const dialog = await screen.findByRole('dialog', { name: 'Join a server' });
    expect((within(dialog).getByRole('textbox', { name: 'Invite link' }) as HTMLInputElement).value).toBe('mvp://join/abc123');
    // The dialog carries on from Home's join: it doesn't start a second one.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(join).toHaveBeenCalledTimes(1);
  });
});
