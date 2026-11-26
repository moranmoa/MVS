// #622 (docs/ux/specs/update-required.md §4): a required update ends the call
// at once. Main sends `update.gate` with endedCall; the page shows the
// update.required.callEnded toast for 8 s, with "Restart and update" when the
// update is already staged. The gate is re-sent on every page load, so the toast
// shows only when I was in a call.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import type { CoreEvents } from '../core/api';
import { MockCore } from '../core/mock';
import { guardCore } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {}, inputLevel: () => 0, deafened: false, setDeafened: () => {}, volumes: {}, setVolume: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const ENDED: CoreEvents['update.gate'] = { required: true, version: '0.6.0', active: true, phase: 'gated', endedCall: true };
const TEXT = 'Your call ended because MVS needs an update. You can rejoin after updating.';

type Emit = { emit: <E extends keyof CoreEvents>(e: E, p: CoreEvents[E]) => void };
const emit = <E extends keyof CoreEvents>(core: MockCore, e: E, p: CoreEvents[E]) => (core as unknown as Emit).emit(e, p);

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  const restart = vi.spyOn(core, 'restartToUpdate');
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  await act(async () => {});
  return { core, restart };
}

async function joinCall(core: MockCore) {
  const [server] = await core.listServers();
  const [room] = await core.listVoiceRooms(server.id);
  await act(async () => {
    await core.joinCall(room.roomId);
  });
}

const toast = () => screen.queryAllByRole('alert').find((a) => a.textContent?.includes(TEXT));

afterEach(() => vi.useRealTimers());

describe('the call-ended toast (#622)', () => {
  it('in a call: the toast says why, with no restart while nothing is staged, and closes after 8 s', async () => {
    const { core } = await setup();
    await joinCall(core);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => emit(core, 'update.gate', ENDED));
    const t = toast()!;
    expect(t).toBeTruthy();
    expect(t.querySelector('button')).toBeNull();
    act(() => vi.advanceTimersByTime(7900));
    expect(toast()).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    expect(toast()).toBeUndefined();
  });

  it('with the update staged, "Restart and update" restarts', async () => {
    const { core, restart } = await setup();
    await joinCall(core);
    act(() => emit(core, 'update.ready', { version: '0.6.0', waitingForCall: false }));
    act(() => emit(core, 'update.gate', ENDED));
    const button = toast()!.querySelector('button')!;
    expect(button.textContent).toBe('Restart and update');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(restart).toHaveBeenCalled();
  });

  it('not in a call (the gate re-sent on a page load): no toast', async () => {
    const { core } = await setup();
    act(() => emit(core, 'update.gate', ENDED));
    expect(toast()).toBeUndefined();
  });

  it('a gate that ended no call: no toast', async () => {
    const { core } = await setup();
    await joinCall(core);
    act(() => emit(core, 'update.gate', { ...ENDED, endedCall: false }));
    expect(toast()).toBeUndefined();
  });

  it('the sanitizer takes only exact booleans and a short version', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const seen: CoreEvents['update.gate'][] = [];
    guardCore(core).on('update.gate', (g) => seen.push(g));
    (core as unknown as { emit: (e: string, p: unknown) => void }).emit('update.gate', {
      required: 'yes',
      version: 42,
      active: 1,
      phase: 'call',
      endedCall: 'true',
      extra: '<b>x</b>',
    });
    expect(seen).toEqual([{ required: false, version: null, active: false, phase: 'none', endedCall: false }]);
  });
});
