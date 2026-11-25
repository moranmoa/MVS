// #589: a member of this server runs a newer MVS (a record kind this version
// doesn't know): the chat says to update, only in that server.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanServer } from '../core/sanitize';
import type { ServerSummary } from '../core/types';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const TEXT = 'Some members of this server are on a newer version of MVS. Update MVS to keep getting and sending messages here.';

describe('server update-needed (#589)', () => {
  it('the sanitizer keeps it only as true', () => {
    const base = { id: 's', name: 'S', initials: 'S', color: '#123456', ageRestriction: 'none', ownerId: 'o', inviteLink: '', unread: false, mentions: 0 } as ServerSummary;
    expect(cleanServer({ ...base, updateNeeded: true }).updateNeeded).toBe(true);
    expect(cleanServer({ ...base, updateNeeded: 'yes' as never }).updateNeeded).toBe(false);
    expect(cleanServer(base).updateNeeded).toBe(false);
  });

  it('the open server shows the line when the core says so, and not before', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    await act(async () => {});
    expect(screen.queryByText(TEXT)).toBeNull();
    const [server] = await core.listServers();
    act(() => (core as unknown as { emit(e: string, p: unknown): void }).emit('server.updated', { ...server, updateNeeded: true }));
    expect(await screen.findByText(TEXT)).toBeTruthy();
  });

  it('"Restart and update" shows only once an update is staged, and restarts', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const restart = vi.spyOn(core, 'restartToUpdate').mockResolvedValue(undefined as never);
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    await act(async () => {});
    const emit = (e: string, p: unknown) => (core as unknown as { emit(e: string, p: unknown): void }).emit(e, p);
    const [server] = await core.listServers();
    act(() => emit('server.updated', { ...server, updateNeeded: true }));
    await screen.findByText(TEXT);
    expect(screen.queryByRole('button', { name: 'Restart and update' })).toBeNull();
    act(() => emit('update.ready', { version: '9.9.9', waitingForCall: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' }));
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
