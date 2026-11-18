// G-78: the lock screens (docs/ux/specs/app-lock.md) against a stand-in for
// the desktop bridge's `lock` (desktop/src/preload.js).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanLockState } from '../core/ipc';
import { newPasscodeProblem } from './AppLockSection';
import { formatWait, lockScreenFromUrl } from './useLock';
import en from '../i18n/en.json';
import he from '../i18n/he.json';

const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

type Listener = (event: string, payload: unknown) => void;

function bridge(initial: Record<string, unknown>) {
  const listeners = new Set<Listener>();
  let state = initial;
  const b = {
    onEvent: (cb: Listener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    lock: {
      state: vi.fn(async () => state),
      unlock: vi.fn(async (_input: unknown): Promise<string> => 'wrong'),
      now: vi.fn(async () => true),
      config: vi.fn(async (): Promise<unknown> => ({ enabled: false, idleMinutes: 5, lockOnSleep: true, method: 'passcode' })),
      set: vi.fn(async (_input: unknown): Promise<unknown> => ({ result: 'ok' })),
      clear: vi.fn(async (_input: unknown): Promise<unknown> => ({ result: 'ok' })),
    },
    emit(next: Record<string, unknown>) {
      state = next;
      act(() => listeners.forEach((cb) => cb('lock.state', next)));
    },
  };
  (window as unknown as { mvs: unknown }).mvs = b;
  return b;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'mvs');
  sessionStorage.clear();
});

const LOCKED_A = { enabled: true, locked: true, pending: false, path: 'A', inCall: false };

describe('locale files', () => {
  // UTF-8 read as Windows-1252 and written back (e.g. a PowerShell write
  // without -Encoding utf8) turns "…" into "â€¦" and Hebrew into "×…".
  it('hold no double-encoded text', () => {
    for (const [name, messages] of Object.entries({ he, en } as Record<string, Record<string, string>>)) {
      const bad = Object.entries(messages).filter(([, v]) => /×|â€|Ã|Â/.test(v));
      expect(bad, name).toEqual([]);
    }
  });
});

describe('helpers', () => {
  it('reads the lock screen from the URL', () => {
    expect(lockScreenFromUrl('?locked')).toBe('locked');
    expect(lockScreenFromUrl('?locked=pending')).toBe('pending');
    expect(lockScreenFromUrl('?demo=1')).toBeNull();
  });
  it('formats the wait', () => {
    expect(formatWait(45)).toBe('45');
    expect(formatWait(90)).toBe('1:30');
    expect(formatWait(900)).toBe('15:00');
  });
  it('cleans what main sends', () => {
    expect(cleanLockState({ locked: true, pending: false, path: 'B', enabled: true, retryAfter: 29.2 })).toEqual({ enabled: true, locked: true, pending: false, path: 'B', inCall: false, retryAfter: 30 });
    expect(cleanLockState({ locked: 'yes' })).toBeNull();
    expect(cleanLockState(null)).toBeNull();
  });
  it('checks a new passcode like the core', () => {
    expect(newPasscodeProblem('2468')).toBeNull();
    expect(newPasscodeProblem('246')).toBe('tooShort');
    expect(newPasscodeProblem('1234567890123')).toBe('tooLong');
    expect(newPasscodeProblem('abc12')).toBe('tooShort');
    expect(newPasscodeProblem('סוד שלי')).toBeNull();
    expect(newPasscodeProblem(' 123456')).toBe('spaces');
    expect(newPasscodeProblem('x'.repeat(65))).toBe('tooLong');
  });
});

describe('path A: the lock screen', () => {
  it('shows nothing personal, and the store never loads', async () => {
    bridge(LOCKED_A);
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const listServers = vi.spyOn(core, 'listServers');
    render(<App core={core} initialSettings={settings} lockScreen="locked" />);
    expect(await screen.findByRole('heading', { name: 'MVS is locked' })).toBeTruthy();
    expect(screen.getByLabelText('Passcode')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Minecraft|general|גיימינג/);
    expect(listServers).not.toHaveBeenCalled();
  });

  it('wrong: cleared, focused, said; ok leaves it to main', async () => {
    const b = bridge(LOCKED_A);
    render(<App core={new MockCore({ speed: 0 })} initialSettings={settings} lockScreen="locked" />);
    const field = (await screen.findByLabelText('Passcode')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '1357' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Wrong passcode.');
    expect(field.value).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(b.lock.unlock).toHaveBeenCalledWith({ passcode: '1357' });
    // The show toggle.
    const show = screen.getByRole('button', { name: 'Show passcode' });
    fireEvent.click(show);
    expect(field.type).toBe('text');
    expect(show.getAttribute('aria-pressed')).toBe('true');
  });

  it('rate-limited: disabled with the countdown; the words stay available', async () => {
    bridge({ ...LOCKED_A, retryAfter: 90 });
    render(<App core={new MockCore({ speed: 0 })} initialSettings={settings} lockScreen="locked" />);
    expect(await screen.findByText('Too many tries. Try again in 1:30.')).toBeTruthy();
    expect((screen.getByLabelText('Passcode') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /12 words/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('forgot: the 12 words go to main as one string; ok leaves a notice for after the reload', async () => {
    const b = bridge(LOCKED_A);
    b.lock.unlock.mockResolvedValue('ok');
    render(<App core={new MockCore({ speed: 0 })} initialSettings={settings} lockScreen="locked" />);
    fireEvent.click(await screen.findByRole('button', { name: /12 words/ }));
    expect(screen.getByRole('heading', { name: 'Unlock with your 12 words' })).toBeTruthy();
    const first = screen.getByLabelText('Word 1');
    fireEvent.paste(first, { clipboardData: { getData: () => Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ') } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(b.lock.unlock).toHaveBeenCalledWith({ words: Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ') }));
    expect(sessionStorage.getItem('mvs.lock.notice')).toBe('lock.words.done');
  });

  it('pending: just "Loading…"', async () => {
    bridge({ ...LOCKED_A, pending: true });
    render(<App core={new MockCore({ speed: 0 })} initialSettings={settings} lockScreen="pending" />);
    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.queryByLabelText('Passcode')).toBeNull();
  });
});

describe('path B: locked during a call', () => {
  it('unmounts the content, shows the call card without names, and comes back on unlock', async () => {
    const b = bridge({ enabled: true, locked: false, pending: false, path: null });
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    render(<App core={core} initialSettings={settings} />);
    await screen.findByRole('textbox', { name: /^Message / });
    expect(document.body.textContent).toMatch(/Minecraft IL/);
    // "Lock now" sits beside my settings, only with the lock on.
    expect(screen.getAllByRole('button', { name: /Lock now/ }).length).toBeGreaterThan(0);

    b.emit({ enabled: true, locked: true, pending: false, path: 'B', inCall: true });
    expect(await screen.findByRole('dialog', { name: 'MVS is locked' })).toBeTruthy();
    expect(screen.getByText('Your mic is off')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Minecraft IL/);
    expect(screen.queryByRole('textbox', { name: /^Message / })).toBeNull();

    const leave = vi.spyOn(core, 'leaveCall');
    fireEvent.click(screen.getByRole('button', { name: 'Leave call' }));
    expect(leave).toHaveBeenCalled();

    b.emit({ enabled: true, locked: false, pending: false, path: null });
    await screen.findByRole('textbox', { name: /^Message / });
    expect(await screen.findByText('Your mic is still off. Turn it on from the call bar.')).toBeTruthy();
  });

  it('Tab stays inside the overlay', async () => {
    const b = bridge({ enabled: true, locked: false, pending: false, path: null });
    render(<App core={new MockCore({ demo: true, speed: 0, simulateActivity: false })} initialSettings={settings} />);
    await screen.findByRole('textbox', { name: /^Message / });
    b.emit({ enabled: true, locked: true, pending: false, path: 'B', inCall: true });
    const dialog = await screen.findByRole('dialog', { name: 'MVS is locked' });
    const leave = screen.getByRole('button', { name: 'Leave call' });
    const forgot = screen.getByRole('button', { name: /12 words/ });
    forgot.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(leave);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(forgot);
  });
});

describe('Settings → Privacy → App lock', () => {
  async function openPrivacy() {
    render(<App core={new MockCore({ demo: true, speed: 0, simulateActivity: false })} initialSettings={settings} />);
    await screen.findByRole('textbox', { name: /^Message / });
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Privacy' }));
  }

  it('is not there outside the desktop app', async () => {
    await openPrivacy();
    expect(screen.queryByRole('switch', { name: 'App lock' })).toBeNull();
  });

  it('turning it on sets a passcode (checked twice, then by main)', async () => {
    const b = bridge({ enabled: false, locked: false, pending: false, path: null });
    await openPrivacy();
    fireEvent.click(await screen.findByRole('switch', { name: 'App lock' }));
    const first = await screen.findByLabelText('New passcode');
    fireEvent.change(first, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That passcode is too short.');
    fireEvent.change(first, { target: { value: '246810' } });
    fireEvent.change(screen.getByLabelText('Again, to confirm'), { target: { value: '246811' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe("The passcodes don't match.");
    expect(b.lock.set).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Again, to confirm'), { target: { value: '246810' } });
    b.lock.config.mockResolvedValue({ enabled: true, idleMinutes: 5, lockOnSleep: true, method: 'passcode' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(b.lock.set).toHaveBeenCalledWith({ passcode: '246810', idleMinutes: 5, lockOnSleep: true }));
    expect(await screen.findByRole('combobox', { name: /Lock when idle/ })).toBeTruthy();
    expect(screen.getByText(/BitLocker/)).toBeTruthy();
  });

  it('changing the idle time asks for the current passcode once, and sends it as typed', async () => {
    const b = bridge({ enabled: true, locked: false, pending: false, path: null });
    b.lock.config.mockResolvedValue({ enabled: true, idleMinutes: 5, lockOnSleep: true, method: 'passcode' });
    await openPrivacy();
    const select = await screen.findByRole('combobox', { name: /Lock when idle/ });
    fireEvent.change(select, { target: { value: '15' } });
    const current = await screen.findByLabelText('Current passcode', { selector: 'input' });
    fireEvent.change(current, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(b.lock.set).toHaveBeenCalledWith({ current: '2468', passcode: '2468', idleMinutes: 15, lockOnSleep: true }));
    // Once per visit: the sleep switch doesn't ask again.
    fireEvent.click(screen.getByRole('switch', { name: /computer locks or sleeps/ }));
    await waitFor(() => expect(b.lock.set).toHaveBeenCalledTimes(2));
    expect(b.lock.set).toHaveBeenLastCalledWith({ current: '2468', passcode: '2468', idleMinutes: 5, lockOnSleep: false });
  });

  it('turning it off with a wrong current says so, and asks again next time', async () => {
    const b = bridge({ enabled: true, locked: false, pending: false, path: null });
    b.lock.config.mockResolvedValue({ enabled: true, idleMinutes: 5, lockOnSleep: true, method: 'passcode' });
    b.lock.clear.mockResolvedValue({ result: 'wrong' });
    await openPrivacy();
    fireEvent.click(await screen.findByRole('switch', { name: 'App lock' }));
    fireEvent.change(await screen.findByLabelText('Current passcode', { selector: 'input' }), { target: { value: '1111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong passcode.');
    expect(b.lock.clear).toHaveBeenCalledWith({ current: '1111' });
    fireEvent.click(screen.getByRole('switch', { name: 'App lock' }));
    expect(await screen.findByLabelText('Current passcode', { selector: 'input' })).toBeTruthy();
  });
});
