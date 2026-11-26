// #577 / #622 (docs/ux/specs/update-required.md §1–3): a required update makes
// the app read-only under a banner that can't be closed. The banner's line
// follows the update (downloading, ready, offline, check-clock, not available,
// failed); the composer keeps its draft but can't send; controls that write or
// connect stay in place with aria-disabled and the reason.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import type { CoreEvents } from '../core/api';
import { MockCore, type MockOptions } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {}, inputLevel: () => 0, deafened: false, setDeafened: () => {}, volumes: {}, setVolume: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const REASON = 'Update MVS to do this.';
const REQUIRED: CoreEvents['update.gate'] = { required: true, version: '0.6.0', active: true, phase: 'gated', endedCall: false };

type Emit = { emit: <E extends keyof CoreEvents>(e: E, p: CoreEvents[E]) => void };
const emit = <E extends keyof CoreEvents>(core: MockCore, e: E, p: CoreEvents[E]) => act(() => (core as unknown as Emit).emit(e, p));

async function setup(options: MockOptions = {}) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false, ...options });
  const check = vi.spyOn(core, 'checkUpdate');
  const restart = vi.spyOn(core, 'restartToUpdate').mockResolvedValue();
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  await act(async () => {});
  return { core, check, restart };
}

const banner = () => screen.queryByRole('region', { name: 'An update is required' });
const composer = () => screen.getByRole('textbox', { name: /^Message / }) as HTMLTextAreaElement;

describe('the update-required banner (#577)', () => {
  it('a required start: the banner, downloading, Update off; no close and no "later"', async () => {
    const { check } = await setup({ updateRequired: 'downloading' });
    const b = banner()!;
    expect(b).toBeTruthy();
    expect(within(b).getByRole('status').textContent).toBe('An update is required');
    expect(within(b).getByText("Until you update, you can read what's on this computer, but not send or connect.")).toBeTruthy();
    expect(within(b).getByText('Downloading the update…')).toBeTruthy();
    expect((within(b).getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(b).getByRole('button', { name: 'Quit' })).toBeTruthy();
    expect(within(b).queryByRole('button', { name: /close|later/i })).toBeNull();
    // It checks once at start (main throttles), while nothing is staged.
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('ready: Update restarts into the new version', async () => {
    const { restart } = await setup({ updateRequired: 'ready' });
    const b = banner()!;
    await within(b).findByText('The update is ready.');
    const update = within(b).getByRole('button', { name: 'Update' }) as HTMLButtonElement;
    expect(update.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(update);
    });
    expect(restart).toHaveBeenCalled();
  });

  it('offline, check-clock and failed each show their line and Try again; not available shows Quit only', async () => {
    for (const [state, text] of [
      ['offline', "Can't reach updates right now. Check your internet connection."],
      ['check-clock', "Your computer's clock is off, so the update can't be verified. Fix the time and try again."],
      ['failed', "The update didn't work. Try again, or download it manually."],
    ] as const) {
      const { check } = await setup({ updateRequired: state });
      const b = banner()!;
      await within(b).findByText(text);
      expect(within(b).queryByRole('button', { name: 'Update' })).toBeNull();
      await act(async () => {
        fireEvent.click(within(b).getByRole('button', { name: 'Try again' }));
      });
      expect(check).toHaveBeenCalledTimes(2);
      document.body.innerHTML = '';
    }
    await setup({ updateRequired: 'not-available' });
    const b = banner()!;
    await within(b).findByText("There's no new version for this computer yet. We keep checking every 15 minutes.");
    expect(within(b).getAllByRole('button').map((x) => x.textContent)).toEqual(['Quit']);
  });

  it('the composer keeps its draft, read-only and selectable, and nothing sends', async () => {
    const { core } = await setup();
    const send = vi.spyOn(core, 'sendMessage');
    fireEvent.change(composer(), { target: { value: 'half a thought' } });
    emit(core, 'update.gate', REQUIRED);
    const box = composer();
    expect(box.value).toBe('half a thought');
    expect(box.readOnly).toBe(true);
    expect(box.placeholder).toBe(REASON);
    expect(box.getAttribute('aria-describedby')).toContain('update-required-reason');
    expect(document.getElementById('update-required-reason')?.textContent).toBe(REASON);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
  });

  it('writing controls stay in place with the reason, and a click does nothing', async () => {
    await setup({ updateRequired: 'downloading' });
    // Calls: the room entry says why.
    const join = screen.getByRole('button', { name: /^New room|^Join chat/ });
    expect(join.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(REASON).length).toBeGreaterThan(0);
    // A new channel: in place, off.
    const create = screen.getByRole('button', { name: 'Create channel' });
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(create.getAttribute('title')).toBe(REASON);
    fireEvent.click(create);
    expect(screen.queryByRole('dialog')).toBeNull();
    // On a message: adding a reaction is off, and no picker opens.
    const react = screen.getAllByRole('button', { name: 'Add reaction' })[0];
    expect(react.getAttribute('aria-disabled')).toBe('true');
    expect(react.getAttribute('aria-describedby')).toBe('update-required-reason');
    fireEvent.click(react);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a later "not required" never clears it; the recovery reminder waits', async () => {
    const { core } = await setup({ demoUnchecked: true });
    expect(screen.queryByText(/recovery words/i)).toBeTruthy();
    emit(core, 'update.gate', REQUIRED);
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(screen.queryByText(/recovery words/i)).toBeNull();
    emit(core, 'update.gate', { ...REQUIRED, required: false, active: false, phase: 'none' });
    expect(banner()).toBeTruthy();
  });
});
