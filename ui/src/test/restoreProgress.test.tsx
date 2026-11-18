// G-91 (#457, PO #426): after a restore or a device link, the restore screen says how far
// the servers are from coming back, with the invite-link hint; and the sanitizer.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanServerRestore } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

beforeEach(() => localStorage.clear());

/** A device link is the shortest way to the restored screen in the mock. */
async function linked(options: ConstructorParameters<typeof MockCore>[0] = {}) {
  const core = new MockCore({ speed: 0, simulateActivity: false, ...options });
  render(<App core={core} initialSettings={en} />);
  await click(await screen.findByRole('button', { name: 'Sign in with another device' }));
  await screen.findByRole('img', { name: 'QR code to link this device' });
  act(() => core.simulateDeviceLink('confirm'));
  await click(await screen.findByRole('button', { name: 'The digits match' }));
  act(() => core.simulateDeviceLink('done'));
  fireEvent.click(await screen.findByRole('checkbox'));
  await click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Your account is restored' });
  return { core };
}
const status = () => screen.getByRole('status');

describe('servers coming back after a restore (G-91)', () => {
  it('says "Looking for your servers…", then how many came back, then all; the invite-link hint stays', async () => {
    const { core } = await linked({ restore: 'searching' });
    expect(status().textContent).toBe('Looking for your servers…');
    expect(screen.getByText(/open an invite link to it/)).toBeTruthy();
    act(() => core.simulateServerRestore({ state: 'waiting', found: 3, waiting: 2 }));
    expect(status().textContent).toBe('Found 3 servers; 1 back. The rest come back when someone from those servers is online.');
    act(() => core.simulateServerRestore({ state: 'waiting', found: 1, waiting: 1 }));
    expect(status().textContent).toBe('Found 1 server; none back yet. The rest come back when someone from those servers is online.');
    act(() => core.simulateServerRestore({ state: 'done', found: 3, waiting: 0 }));
    expect(status().textContent).toBe('All your servers are back.');
    expect(screen.getByText(/open an invite link to it/)).toBeTruthy();
  });

  it('done with nothing found says so', async () => {
    const { core } = await linked({ restore: 'searching' });
    act(() => core.simulateServerRestore({ state: 'done', found: 0, waiting: 0 }));
    expect(status().textContent).toBe('No servers to bring back were found.');
  });

  it('Continue opens the app while the servers keep coming back', async () => {
    await linked({ restore: 'searching' });
    const step = screen.getByRole('heading', { name: 'Your account is restored' }).closest('.onb-step')!;
    await click(within(step as HTMLElement).getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('heading', { name: 'Your account is restored' })).toBeNull();
  });

  it('cleanServerRestore: a known state, whole counts, waiting ≤ found', () => {
    expect(cleanServerRestore({ state: 'waiting', found: 3, waiting: 2 })).toEqual({ state: 'waiting', found: 3, waiting: 2 });
    expect(cleanServerRestore({ state: 'none', found: 0, waiting: 0 })).toEqual({ state: 'none', found: 0, waiting: 0 });
    for (const bad of [
      null,
      'done',
      { state: 'lost', found: 0, waiting: 0 },
      { state: 'waiting', found: 1, waiting: 2 },
      { state: 'waiting', found: -1, waiting: 0 },
      { state: 'waiting', found: 1.5, waiting: 0 },
      { state: 'waiting', found: '3', waiting: 0 },
      { state: 'done', found: 3, waiting: 0, servers: ['x'] },
    ]) {
      expect(cleanServerRestore(bad)).toBeNull();
    }
  });
});
