// G-30: links to a message (docs/design/g30-message-links.md): the link format,
// the sanitizer, "Copy message link", and opening a link (found, not here, not a member).

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { messageLink, parseMessageLink } from '../app/messageLink';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { guardCore } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const hex = (c: string) => c.repeat(64);

afterEach(() => {
  delete (window as { mvs?: unknown }).mvs;
});

describe('the link format', () => {
  it('builds mvs://m/<server>/<channel>/<message> and parses back only the exact form', () => {
    const link = messageLink(hex('a'), hex('b'), hex('c'));
    expect(link).toBe(`mvs://m/${hex('a')}/${hex('b')}/${hex('c')}`);
    expect(parseMessageLink(link)).toEqual({ serverId: hex('a'), channelId: hex('b'), messageId: hex('c') });
    expect(parseMessageLink(`${link}/`)).not.toBeNull();
    expect(parseMessageLink(` ${link.toUpperCase().replace('MVS://M/', 'mvs://m/')} `)).not.toBeNull();
    for (const bad of [
      `${link}/x`,
      `${link}?a=1`,
      `${link}#x`,
      `https://example.com/m/${hex('a')}/${hex('b')}/${hex('c')}`,
      `mvs://join/${hex('a')}/${hex('b')}/${hex('c')}`,
      `mvs://m/${hex('a')}/${hex('b')}`,
      `mvs://m/${hex('a')}/${hex('b')}/${'c'.repeat(63)}`,
      `mvs://m/${hex('a')}/${hex('b')}/${'g'.repeat(64)}`,
      `mvs://m/${hex('a')}/${hex('b')}/%63${'c'.repeat(62)}`,
      `${link}${' '.repeat(300)}x`,
      null,
      42,
    ]) {
      expect(parseMessageLink(bad), String(bad)).toBeNull();
    }
  });

  it('the sanitizer drops a link.message event without all three ids, and locateMessage returns only an index', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const guarded = guardCore(core);
    const seen: unknown[] = [];
    guarded.on('link.message', (p) => seen.push(p));
    const emit = (p: unknown) => (core as unknown as { emit: (e: string, p: unknown) => void }).emit('link.message', p);
    act(() => {
      emit({ serverId: 's', channelId: '', messageId: 'm' });
      emit({ serverId: 's', channelId: 'c', messageId: 'm', extra: 'x' });
      // Only 64 lower-case hex (or the demo's short ids): no case, slashes, spaces or URLs.
      for (const bad of ['S', 'a/b', 'a b', 'mvs://x', 'x'.repeat(65), 'ABCDEF'.repeat(11)]) emit({ serverId: bad, channelId: 'c', messageId: 'm' });
      emit({ serverId: 'a'.repeat(64), channelId: 'b'.repeat(64), messageId: 'c'.repeat(64) });
    });
    expect(seen).toEqual([
      { serverId: 's', channelId: 'c', messageId: 'm' },
      { serverId: 'a'.repeat(64), channelId: 'b'.repeat(64), messageId: 'c'.repeat(64) },
    ]);
    const [server] = await core.listServers();
    const [channel] = await core.listChannels(server.id);
    const { index } = await guarded.locateMessage(server.id, channel.id, `${channel.id}#3`);
    expect(index).toBe(3);
    await expect(guarded.locateMessage(server.id, channel.id, `${channel.id}#999999`)).rejects.toMatchObject({ code: 'not-found' });
    await expect(guarded.locateMessage('nope', channel.id, `${channel.id}#3`)).rejects.toMatchObject({ code: 'not-found' });
  });
});

/** Spies go on `core` before this: the app wraps the core and keeps the methods it was given. */
async function setup(core = new MockCore({ demo: true, speed: 0, simulateActivity: false })) {
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const servers = await core.listServers();
  return { core, servers };
}

describe('Copy message link and opening a link (G-30)', () => {
  it('"Copy message link" copies the mvs:// link and says so', async () => {
    const copied: string[] = [];
    (window as { mvs?: unknown }).mvs = { copyText: async (t: string) => (copied.push(t), true) };
    const { servers } = await setup();
    const rows = await screen.findAllByRole('article');
    const row = rows.filter((r) => r.querySelector('.msg:not(.skeleton):not(.deleted)')).at(-1)!;
    fireEvent.contextMenu(row);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Copy message link' }));
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(new RegExp(`^mvs://m/${servers[0].id}/[^/]+/[^/]+$`));
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  it('a link to a message here: opens that channel, scrolls to it and highlights it', async () => {
    const { core, servers } = await setup();
    // Another server and its second channel, so the link really navigates.
    const server = servers[1];
    const channels = await core.listChannels(server.id);
    const channel = channels[1] ?? channels[0];
    const index = 5;
    act(() => core.simulateMessageLink(server.id, channel.id, `${channel.id}#${index}`));
    await screen.findByRole('textbox', { name: (n) => n.startsWith('Message ') && n.includes(channel.name) });
    await waitFor(() => expect(document.querySelector('.row.target')).not.toBeNull());
    // The highlight goes away by itself.
    await waitFor(() => expect(document.querySelector('.row.target')).toBeNull(), { timeout: 4000 });
  });

  it('a link to a message that is not on this computer: the channel opens, and a toast says why', async () => {
    const { core, servers } = await setup();
    const [channel] = await core.listChannels(servers[0].id);
    act(() => core.simulateMessageLink(servers[0].id, channel.id, `${channel.id}#999999`));
    expect(await screen.findByText(/That message isn't on this computer/)).toBeTruthy();
    expect(document.querySelector('.row.target')).toBeNull();
  });

  it('a channel I am not given (hidden or missing) looks exactly like a message not found, and opens nothing new (SL R1)', async () => {
    const { core, servers } = await setup();
    const box = screen.getByRole('textbox', { name: /^Message / });
    const before = box.getAttribute('aria-label');
    act(() => core.simulateMessageLink(servers[0].id, 'not-a-channel-of-mine', 'not-a-channel-of-mine#1'));
    expect(await screen.findByText(/That message isn't on this computer/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /^Message / }).getAttribute('aria-label')).toBe(before);
    expect(screen.queryByRole('dialog', { name: 'A message in another server' })).toBeNull();
  });

  it('the index is a snapshot: if the id there moved, it locates again', async () => {
    // Spied before render (see setup), so the app really calls these.
    const mock = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const real = mock.locateMessage.bind(mock);
    // The first answer is stale (the message moved); the second is right.
    const locate = vi.spyOn(mock, 'locateMessage').mockImplementationOnce(async () => ({ index: 2 }));
    locate.mockImplementation(real);
    const { core, servers } = await setup(mock);
    // A channel that isn't open yet, so it opens fresh near the linked row
    // (an open channel sits at its bottom, far from row 5 in jsdom's virtual list).
    const server = servers[1];
    const channels = await core.listChannels(server.id);
    const channel = channels[1] ?? channels[0];
    act(() => core.simulateMessageLink(server.id, channel.id, `${channel.id}#5`));
    await screen.findByRole('textbox', { name: (n) => n.startsWith('Message ') && n.includes(channel.name) });
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('[data-index="5"].row.target')).not.toBeNull());
  });

  it('a link into a server I am not in: one dialog, no ids shown, nothing opened', async () => {
    const mock = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const locate = vi.spyOn(mock, 'locateMessage');
    const { core } = await setup(mock);
    act(() => core.simulateMessageLink(hex('a'), hex('b'), hex('c')));
    const dialog = await screen.findByRole('dialog', { name: 'A message in another server' });
    expect(dialog.textContent).not.toContain(hex('a'));
    expect(locate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'A message in another server' })).toBeNull());
  });
});
