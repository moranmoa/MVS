// Device link (device-link-slice.md): the new device's screen (QR, code,
// digits, states) and the signed-in device's Settings → Devices → Add a device.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanDeviceApproval, cleanDeviceLinkOffer, cleanDeviceLinkState } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/[⁨⁩]/g, '');
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

beforeEach(() => localStorage.clear());

async function newDevice() {
  const core = new MockCore({ speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await click(await screen.findByRole('button', { name: 'Sign in with another device' }));
  await screen.findByRole('img', { name: 'QR code to link this device' });
  return { core };
}

describe('device link: the new device', () => {
  it('shows the QR and the grouped code, then the digits, then asks only the agreement', async () => {
    const { core } = await newDevice();
    expect(screen.getByText('K7QX2 MZRF4')).toBeTruthy();
    expect(document.querySelector('.qr-code path')?.getAttribute('d')).toMatch(/^M\d/);
    act(() => core.simulateDeviceLink('confirm'));
    const digits = await screen.findByText('482 913');
    expect(plain(digits.getAttribute('aria-label'))).toBe('Digits to compare: 4 8 2 9 1 3');
    expect(screen.queryByRole('img', { name: 'QR code to link this device' })).toBeNull();
    act(() => core.simulateDeviceLink('done'));
    // The same account: no country, birth date or words; only the agreement.
    const accept = await screen.findByRole('checkbox');
    expect(await core.getIdentity()).not.toBeNull();
    fireEvent.click(accept);
    await click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
    expect(screen.queryByRole('heading', { name: /recovery words/i })).toBeNull();
  });

  it.each([
    ['expired', undefined, 'The code expired. You can make a new one.'],
    ['failed', 'refused', "The other device didn't approve it."],
    ['failed', 'network', "Couldn't reach the other device. You can try again."],
  ] as const)('%s (%s) says why, and "New code" starts again', async (state, reason, text) => {
    const { core } = await newDevice();
    act(() => core.simulateDeviceLink(state, reason));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    await click(screen.getByRole('button', { name: 'New code' }));
    await screen.findByRole('img', { name: 'QR code to link this device' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Cancel goes back to the first screen and cancels the link', async () => {
    const { core } = await newDevice();
    const cancel = vi.spyOn(core, 'cancelDeviceLink');
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Sign in with another device' })).toBeTruthy();
  });
});

describe('device link: the signed-in device', () => {
  async function openDevices() {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }));
    await click(screen.getByRole('button', { name: 'Add a device' }));
    const input = screen.getByRole('textbox', { name: 'The code shown on the new device' });
    const submit = async (value: string) => {
      fireEvent.change(input, { target: { value } });
      await click(screen.getByRole('button', { name: 'Continue' }));
    };
    return { core, input, submit };
  }

  it('checks the code, then asks with a full-access warning and the digits; approving adds the device', async () => {
    const { core, input, submit } = await openDevices();
    await submit('abc');
    expect(screen.getByRole('alert').textContent).toContain('10 characters');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await submit('zzzzz zzzzz');
    expect(screen.getByRole('alert').textContent).toContain('No device with this code');
    await submit('RRRRR-RRRRR');
    expect(screen.getByRole('alert').textContent).toContain('Too many tries');
    const begin = vi.spyOn(core, 'beginDeviceApproval');
    await submit('k7qx2-mzrf4');
    expect(begin).toHaveBeenCalledWith('K7QX2MZRF4');
    const group = screen.getByRole('group', { name: /gets full access to your account/ });
    expect(within(group).getByText('482 913')).toBeTruthy();
    const confirm = vi.spyOn(core, 'confirmDeviceApproval');
    await click(within(group).getByRole('button', { name: 'They match, sign it in' }));
    expect(confirm).toHaveBeenCalledWith(true);
    expect(screen.getByRole('status').textContent).toBe('The new device was added to your account.');
  });

  it("\"They don't match\" declines it", async () => {
    const { core, submit } = await openDevices();
    await submit('K7QX2MZRF4');
    const confirm = vi.spyOn(core, 'confirmDeviceApproval');
    await click(screen.getByRole('button', { name: "They don't match" }));
    expect(confirm).toHaveBeenCalledWith(false);
    expect(screen.getByText('The device was not signed in.')).toBeTruthy();
  });
});

describe('device link sanitizers', () => {
  it('deviceLink.state: known states and reasons; digits only with confirm', () => {
    expect(cleanDeviceLinkState({ state: 'waiting' })).toEqual({ state: 'waiting' });
    expect(cleanDeviceLinkState({ state: 'confirm', sas: '482913' })).toEqual({ state: 'confirm', sas: '482913' });
    expect(cleanDeviceLinkState({ state: 'failed', reason: 'refused' })).toEqual({ state: 'failed', reason: 'refused' });
    for (const bad of [
      null,
      'done',
      { state: 'linked' },
      { state: 'confirm' }, // no digits
      { state: 'confirm', sas: '48291' },
      { state: 'confirm', sas: '48291a' },
      { state: 'waiting', sas: '482913' }, // digits outside confirm
      { state: 'failed', reason: 'because' },
      { state: 'done', extra: 1 },
    ]) {
      expect(cleanDeviceLinkState(bad)).toBeNull();
    }
  });

  it('the offer and the approval: base32 code, 6 digits, printable QR text, a time', () => {
    const offer = { qr: 'mvs-link:v1:k7qx2mzrf4:x', code: 'K7QX2MZRF4', expiresAt: 1 };
    expect(cleanDeviceLinkOffer(offer)).toEqual(offer);
    for (const bad of [{ ...offer, code: 'K7QX2MZRF' }, { ...offer, code: 'K7QX2MZRF1' }, { ...offer, qr: 'a b' }, { ...offer, qr: 'x'.repeat(1025) }, { ...offer, expiresAt: -1 }, { ...offer, extra: 1 }]) {
      expect(cleanDeviceLinkOffer(bad)).toBeNull();
    }
    expect(cleanDeviceApproval({ sas: '000123', expiresAt: 5 })).toEqual({ sas: '000123', expiresAt: 5 });
    for (const bad of [{ sas: 482913, expiresAt: 5 }, { sas: '4829130', expiresAt: 5 }, { sas: '482913' }, { sas: '482913', expiresAt: 5, x: 1 }]) {
      expect(cleanDeviceApproval(bad)).toBeNull();
    }
  });
});
