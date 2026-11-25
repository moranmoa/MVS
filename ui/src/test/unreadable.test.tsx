// Core #527 (TODO #21): a message that can't be opened on this computer is a
// placeholder row: muted, no actions, no notification; a no-key one opens in
// place later (message.updated), an untrusted one has no author.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import type { Message } from '../core';
import { MockCore } from '../core/mock';
import { cleanMessage } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const base: Message = { id: 'm1', channelId: 'c', index: 4, authorId: 'u1', createdAt: 1_700_000_000_000, body: 'hello' };

describe('the placeholder sanitizer', () => {
  it('keeps only id, channel, index, time and (no-key) author; the body is empty', () => {
    const noKey = cleanMessage({ ...base, unreadable: 'no-key', body: 'leak?', reactions: [{ emoji: '👍', count: 1, mine: false }], mentionsMe: true });
    expect(noKey).toEqual({ id: 'm1', channelId: 'c', index: 4, authorId: 'u1', createdAt: base.createdAt, body: '', unreadable: 'no-key', mentionsMe: false });
    // untrusted: no author, even if one was sent.
    expect(cleanMessage({ ...base, unreadable: 'untrusted' }).authorId).toBe('');
    // An unknown kind is just a message.
    expect(cleanMessage({ ...base, unreadable: 'weird' as never }).unreadable).toBeUndefined();
  });
});

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const [server] = await core.listServers();
  const [channel] = await core.listChannels(server.id);
  await screen.findAllByRole('article');
  // A row near the top: jsdom renders only the first rows of the virtual list.
  return { core, channelId: channel.id, last: 3 };
}

describe('placeholder rows (core #527)', () => {
  it('no-key: a muted line with the author, no toolbar and no menu; it opens in place later', async () => {
    const { core, channelId, last } = await setup();
    act(() => core.simulateUnreadable(channelId, last, 'no-key'));
    const row = await waitFor(() => {
      const r = document.querySelector(`[data-index="${last}"] .msg.unreadable`);
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row.textContent).toContain("This message can't be opened on this computer yet. It may open later.");
    expect(row.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(row.closest('[data-index]')!.querySelector('[role="toolbar"]')).toBeNull();
    fireEvent.contextMenu(row.closest('[role="article"]') ?? row);
    expect(screen.queryByRole('menu')).toBeNull();
    // The key arrived: the same row becomes the message.
    act(() => core.simulateUnreadable(channelId, last, null));
    await waitFor(() => expect(document.querySelector(`[data-index="${last}"] .msg.unreadable`)).toBeNull());
  });

  it('untrusted: no author name, the untrusted wording', async () => {
    const { core, channelId, last } = await setup();
    act(() => core.simulateUnreadable(channelId, last, 'untrusted'));
    const row = await waitFor(() => {
      const r = document.querySelector(`[data-index="${last}"] .msg.unreadable`);
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row.textContent).toBe("This message can't be verified, so it isn't shown.");
    expect(row.classList.contains('untrusted')).toBe(true);
  });
});

describe('a placeholder that opens later (PO rule on #558)', () => {
  it('is new to me once: the store tells the notifier, and an edit after that does not', async () => {
    const { Store } = await import('../app/store');
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const store = new Store(core);
    const stop = store.start();
    await store.init();
    const [server] = await core.listServers();
    const [channel] = await core.listChannels(server.id);
    const opened = vi.fn();
    store.onPlaceholderOpened(opened);
    core.simulateUnreadable(channel.id, 3, 'no-key');
    expect(opened).not.toHaveBeenCalled();
    core.simulateUnreadable(channel.id, 3, null);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]).toMatchObject({ channelId: channel.id, index: 3 });
    expect(opened.mock.calls[0][0].unreadable).toBeUndefined();
    // Another update of the same, now readable, message isn't "new" again.
    core.simulateUnreadable(channel.id, 3, null);
    expect(opened).toHaveBeenCalledTimes(1);
    stop();
  });
});
