// G-72 part 2: Settings → Voice (UX spec #427 §4, option (a)): the speaker
// and a test sound outside a call; the microphone is tested during a call.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { DEVICES_EVENT, loadDevices } from '../voice/devices';

const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function openVoice(devices: Partial<MediaDeviceInfo>[]) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: async () => devices, addEventListener: () => {}, removeEventListener: () => {} },
  });
  render(<App core={new MockCore({ demo: true, speed: 0, simulateActivity: false })} initialSettings={settings} />);
  await screen.findByRole('textbox', { name: /^Message / });
  fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
  fireEvent.click(await screen.findByRole('button', { name: 'Voice' }));
}

afterEach(() => {
  localStorage.removeItem('mvs.voice.devices.v1');
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('Settings → Voice', () => {
  it('lists the speakers (unnamed before the mic was ever allowed), and says where to test the mic', async () => {
    await openVoice([
      { kind: 'audiooutput', deviceId: 'default', label: '' },
      { kind: 'audiooutput', deviceId: 'spk-a', label: '' },
      { kind: 'audiooutput', deviceId: 'spk-b', label: '' },
      { kind: 'audioinput', deviceId: 'mic-a', label: '' },
    ]);
    const select = (await screen.findByRole('combobox', { name: 'Speakers' })) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.text)).toEqual(['System default', 'Speaker 1', 'Speaker 2']));
    expect(screen.getByRole('button', { name: 'Play test sound' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('You can test your microphone during a call.');
    // No microphone controls outside a call.
    expect(screen.queryByRole('combobox', { name: 'Microphone' })).toBeNull();
  });

  it('remembers the chosen speaker on this computer and tells a running call', async () => {
    await openVoice([{ kind: 'audiooutput', deviceId: 'spk-a', label: 'Headphones' }]);
    const select = (await screen.findByRole('combobox', { name: 'Speakers' })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    const told = vi.fn();
    window.addEventListener(DEVICES_EVENT, told);
    await act(async () => {
      fireEvent.change(select, { target: { value: 'spk-a' } });
    });
    window.removeEventListener(DEVICES_EVENT, told);
    expect(loadDevices().output).toBe('spk-a');
    expect(told).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('spk-a');
  });

  it('G-64: the join/leave sound switch is on by default and can be turned off', async () => {
    await openVoice([]);
    const sw = (await screen.findByRole('switch', { name: 'Play a sound when people join or leave the call' })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    expect(sw.checked).toBe(false);
  });

  it('a remembered speaker that is not plugged in shows as the system default', async () => {
    localStorage.setItem('mvs.voice.devices.v1', JSON.stringify({ output: 'spk-gone' }));
    await openVoice([{ kind: 'audiooutput', deviceId: 'spk-a', label: 'Headphones' }]);
    const select = (await screen.findByRole('combobox', { name: 'Speakers' })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    expect(select.value).toBe('');
  });
});
