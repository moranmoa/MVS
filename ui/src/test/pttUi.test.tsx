// G-74 push to talk, the UI half: Settings → Voice, the stored prefs, and the
// call bar's hook wiring (the shell side and the hook itself are #444's).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { acceleratorFrom, cleanVoicePrefs, defaultVoicePrefs, keyLabel, pttKeyFrom } from '../app/voicePrefs';
import { MockCore } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const key = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

afterEach(() => {
  delete (window as { mvs?: unknown }).mvs;
});

describe('push-to-talk prefs (G-74)', () => {
  it('defaults to voice activity with no keys; stored values are checked', () => {
    expect(defaultVoicePrefs()).toEqual({ mode: 'open', pttKey: null, globalMute: null });
    expect(cleanVoicePrefs({ mode: 'ptt', pttKey: 'KeyV', globalMute: 'CommandOrControl+Shift+M' })).toEqual({ mode: 'ptt', pttKey: 'KeyV', globalMute: 'CommandOrControl+Shift+M' });
    expect(cleanVoicePrefs({ mode: 'loud', pttKey: '<b>', globalMute: 'rm -rf' })).toEqual(defaultVoicePrefs());
    expect(cleanVoicePrefs({ globalMute: 'Alt+M' }).globalMute).toBeNull();
    expect(cleanVoicePrefs({ globalMute: 'F13' }).globalMute).toBe('F13');
    expect(cleanVoicePrefs(null)).toEqual(defaultVoicePrefs());
  });

  it('the push-to-talk key: any code but OS keys, Escape and Enter', () => {
    expect(pttKeyFrom(key('KeyV'))).toBe('KeyV');
    expect(pttKeyFrom(key('ControlLeft'))).toBe('ControlLeft');
    expect(pttKeyFrom(key('F13'))).toBe('F13');
    for (const c of ['MetaLeft', 'OSRight', 'Escape', 'Enter', 'NumpadEnter', '']) expect(pttKeyFrom(key(c))).toBeNull();
    expect(keyLabel('KeyV')).toBe('V');
    expect(keyLabel('Digit5')).toBe('5');
  });

  it('the global toggle: two or three modifiers and a key, or F13–F24', () => {
    expect(acceleratorFrom(key('KeyM', { ctrlKey: true, shiftKey: true }))).toBe('CommandOrControl+Shift+M');
    expect(acceleratorFrom(key('Digit0', { ctrlKey: true, altKey: true }))).toBe('CommandOrControl+Alt+0');
    // One modifier would take over Ctrl+C, Alt+F4…: refused (Security Lead).
    expect(acceleratorFrom(key('KeyM', { metaKey: true }))).toBeNull();
    expect(acceleratorFrom(key('KeyC', { ctrlKey: true }))).toBeNull();
    expect(acceleratorFrom(key('F14', { shiftKey: true }))).toBe('Shift+F14');
    expect(acceleratorFrom(key('F13'))).toBe('F13');
    expect(acceleratorFrom(key('KeyM'))).toBeNull();
    expect(acceleratorFrom(key('F5'))).toBeNull();
    expect(acceleratorFrom(key('Space', { ctrlKey: true }))).toBeNull();
  });
});

describe('Settings → Voice (G-74)', () => {
  async function open(bridgeResult: 'ok' | 'shortcut-taken' | null) {
    const setPushToTalk = vi.fn(async () => bridgeResult ?? 'ok');
    if (bridgeResult) (window as { mvs?: unknown }).mvs = { setPushToTalk, onPushToTalk: () => () => {} };
    const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
    render(<App core={new MockCore({ demo: true, speed: 0, simulateActivity: false })} initialSettings={settings} />);
    await screen.findByRole('textbox', { name: /^Message / });
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Voice' }));
    return { setPushToTalk };
  }

  it('push to talk: pick the mode, capture a key (Esc cancels), see the focus-only line', async () => {
    await open('ok');
    fireEvent.click(screen.getByRole('radio', { name: 'Push to talk' }));
    expect(screen.getByText('Choose a key to turn this on.')).toBeTruthy();
    const capture = screen.getByRole('button', { name: 'Push-to-talk key' });
    fireEvent.click(capture);
    expect(capture.textContent).toBe('Press a key…');
    fireEvent.keyDown(capture, { key: 'Escape', code: 'Escape' });
    expect(capture.textContent).toBe('No key set');
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { key: 'Meta', code: 'MetaLeft' });
    expect(capture.textContent).toBe('Press a key…'); // refused: still waiting
    fireEvent.keyDown(capture, { key: 'v', code: 'KeyV' });
    expect(capture.querySelector('kbd')?.textContent).toBe('V');
    expect(screen.getByText('Works while the MVS window is active.')).toBeTruthy();
  });

  it('a combination the shell would refuse says why at once; a good one clears it', async () => {
    await open('ok');
    const capture = screen.getByRole('button', { name: 'Global mute toggle' });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect(screen.queryByRole('alert')).toBeNull(); // a lone modifier is the start, not an answer
    fireEvent.keyDown(capture, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(screen.getByRole('alert').textContent).toContain("That combination can't be used");
    expect(capture.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(capture, { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(capture.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+M');
  });

  it('a global shortcut another app holds is shown on its field', async () => {
    await open('shortcut-taken');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Another app already uses this shortcut'));
    expect(screen.getByRole('button', { name: 'Global mute toggle' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('outside the desktop app it says so and the controls are off', async () => {
    await open(null);
    await waitFor(() => expect(screen.getByRole('note').textContent).toBe('Push to talk works in the desktop app.'));
    expect((screen.getByRole('radio', { name: 'Push to talk' }) as HTMLInputElement).disabled).toBe(true);
    // UX: the line explains the disabled controls.
    expect(screen.getByRole('radio', { name: 'Push to talk' }).getAttribute('aria-describedby')).toBe('ptt-desktop-only');
    const toggle = screen.getByRole('button', { name: 'Global mute toggle' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-describedby')).toContain('ptt-desktop-only');
  });

  it('the shell gets the key only in push-to-talk mode', async () => {
    const { setPushToTalk } = await open('ok');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Push to talk' }));
    });
    const capture = screen.getByRole('button', { name: 'Push-to-talk key' });
    fireEvent.click(capture);
    await act(async () => {
      fireEvent.keyDown(capture, { key: 'v', code: 'KeyV' });
    });
    await waitFor(() => expect(setPushToTalk).toHaveBeenLastCalledWith({ key: 'KeyV', globalMute: null }));
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Voice activity' }));
    });
    await waitFor(() => expect(setPushToTalk).toHaveBeenLastCalledWith({ key: null, globalMute: null }));
  });
});
