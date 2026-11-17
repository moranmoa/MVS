// G-62: the taskbar / dock unread count, sent through the desktop bridge.

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { channelMuteKey, MUTE_FOREVER, serverMuteKey } from '../app/mute';
import type { Settings } from '../app/settings';
import { unreadTotal } from '../app/unreadBadge';
import { MockCore } from '../core/mock';
import type { Channel } from '../core/types';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const ch = (id: string, unread: boolean, mentions = 0) => ({ id, unread, mentions }) as unknown as Channel;

describe('unread badge (G-62)', () => {
  afterEach(() => {
    delete (window as { mvs?: unknown }).mvs;
  });

  it('counts mentions, or 1 for an unread channel without any; muted servers and channels are left out', () => {
    const channels = { s1: [ch('a', true, 3), ch('b', true), ch('c', false)], s2: [ch('d', true, 2)], s3: [ch('e', true, 5)] };
    expect(unreadTotal(channels, {})).toBe(3 + 1 + 2 + 5);
    expect(unreadTotal(channels, { [serverMuteKey('s3')]: MUTE_FOREVER })).toBe(6);
    expect(unreadTotal(channels, { [channelMuteKey('a')]: MUTE_FOREVER })).toBe(1 + 2 + 5);
    // An expired mute counts again.
    expect(unreadTotal(channels, { [serverMuteKey('s3')]: 1000 }, 2000)).toBe(11);
    expect(unreadTotal({ s: [ch('x', true, 50_000)] }, {})).toBe(9999);
  });

  it('sends the total to the shell while signed in, and 0 when the shell goes away', async () => {
    const setUnreadCount = vi.fn(async (_n: number) => true);
    // Only the badge call: without invoke the app stays the web build.
    (window as { mvs?: unknown }).mvs = { setUnreadCount };
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
    const { unmount } = render(<App core={core} initialSettings={settings} />);
    await screen.findByRole('textbox', { name: /^Message / });
    await waitFor(() => expect(setUnreadCount).toHaveBeenCalled());
    const sent = setUnreadCount.mock.calls.at(-1)![0];
    expect(Number.isInteger(sent) && sent >= 0 && sent <= 9999).toBe(true);
    act(() => unmount());
    expect(setUnreadCount).toHaveBeenLastCalledWith(0);
  });

  it('outside the desktop app nothing breaks (no bridge)', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
    render(<App core={core} initialSettings={settings} />);
    expect(await screen.findByRole('textbox', { name: /^Message / })).toBeTruthy();
  });
});
