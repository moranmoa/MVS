// "A new device was added to your account" (device link follow-up): the notice
// on my other devices, "It was me" / "It wasn't me", and its sanitizer.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanDeviceAdded } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  return { core };
}
const notices = () => screen.queryAllByRole('alert').filter((a) => a.classList.contains('device-notice'));

describe('new device added notice', () => {
  it('shows the device and the time; "It was me" acknowledges it to the core and it goes', async () => {
    const { core } = await setup();
    const ack = vi.spyOn(core, 'ackDeviceNotice');
    const at = new Date(2026, 10, 17, 9, 5).getTime();
    act(() => core.simulateDeviceAdded('Windows laptop', at));
    const [notice] = notices();
    expect(within(notice).getByText('A new device was added to your account')).toBeTruthy();
    // Untrusted text from the new device: quoted, never the headline.
    expect(notice.textContent?.replace(/[\u2068\u2069]/g, '')).toContain('a device that calls itself “Windows laptop”');
    expect(within(notice).getByText('“Windows laptop”').tagName).toBe('BDI');
    // UX: at the top, not over the composer.
    expect(notice.parentElement?.className).toBe('device-notices');
    expect(notice.textContent).toMatch(/Nov 17/);
    // Re-sent until acknowledged: one notice per device, not two.
    act(() => core.simulateDeviceAdded('Windows laptop', at));
    expect(notices()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'It was me' }));
    });
    expect(ack).toHaveBeenCalledWith(at);
    expect(notices()).toHaveLength(0);
  });

  it('no label (the core sends none yet) says "A new device"', async () => {
    const { core } = await setup();
    act(() => core.simulateDeviceAdded(''));
    expect(notices()[0].textContent).toContain('A new device');
  });

  it('"It wasn\'t me" explains what to do, and the notice stays', async () => {
    const { core } = await setup();
    act(() => core.simulateDeviceAdded('Linux'));
    fireEvent.click(within(notices()[0]).getByRole('button', { name: "It wasn't me" }));
    const dialog = screen.getByRole('dialog', { name: 'An unknown device was added' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    expect(dialog.textContent).toContain('full access to your account');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(notices()).toHaveLength(1);
  });

  it('cleanDeviceAdded: a time and a cleaned label; anything else is dropped', () => {
    expect(cleanDeviceAdded({ at: 5, label: 'Windows' })).toEqual({ at: 5, label: 'Windows' });
    expect(cleanDeviceAdded({ at: 5 })).toEqual({ at: 5 });
    expect(cleanDeviceAdded({ at: 5, label: '' })).toEqual({ at: 5 });
    expect(cleanDeviceAdded({ at: 5, label: 'Win\u202edows' })).toEqual({ at: 5, label: 'Windows' });
    expect(cleanDeviceAdded({ at: 5, label: 'x'.repeat(80) })?.label).toHaveLength(64);
    for (const bad of [null, 'x', { at: -1, label: 'a' }, { at: '5', label: 'a' }, { at: 5, label: 7 }, { at: 5, label: 'a', ip: '10.0.0.1' }]) {
      expect(cleanDeviceAdded(bad)).toBeNull();
    }
  });
});
