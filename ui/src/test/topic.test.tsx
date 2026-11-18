// G-14: the channel topic (docs/design/channel-topic.md): the sanitizer, the
// header line, the dialog (view, edit, clear, errors) and the channel menu item.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import type { Channel } from '../core';
import { MockCore } from '../core/mock';
import { cleanChannel } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const base: Channel = { id: 'c', serverId: 's', name: 'general', adult: false, isDefault: true, unread: false, mentions: 0 };

describe('the topic sanitizer', () => {
  it('keeps one line of plain text, drops controls and line breaks, caps 256, and drops an empty topic', () => {
    expect(cleanChannel({ ...base, topic: 'Game night on Thursdays' }).topic).toBe('Game night on Thursdays');
    expect(cleanChannel({ ...base, topic: 'a\nb‮c' }).topic).not.toMatch(/[\n‮]/);
    expect([...(cleanChannel({ ...base, topic: 'x'.repeat(400) }).topic ?? '')].length).toBe(256);
    expect('topic' in cleanChannel({ ...base, topic: '   ' })).toBe(false);
    expect('topic' in cleanChannel({ ...base, topic: 42 as unknown as string })).toBe(false);
  });
});

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const [server] = await core.listServers();
  const [channel] = await core.listChannels(server.id);
  return { core, channel };
}

describe('channel topic (G-14)', () => {
  it('shows the topic after the channel name; it opens the full text, plain, with the visibility hint', async () => {
    const { channel } = await setup();
    const topicButton = screen.getByRole('button', { name: `Channel topic: ${channel.topic}` });
    fireEvent.click(topicButton);
    const dialog = await screen.findByRole('dialog', { name: 'Channel topic' });
    expect(within(dialog).getByText(channel.topic!)).toBeTruthy();
    expect(within(dialog).getByText('The topic is visible to every member of the server.')).toBeTruthy();
    // Plain text: no links, nothing rendered as Markdown.
    expect(dialog.querySelector('a')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Edit topic' })).toBeTruthy();
  });

  it('the owner edits it: line breaks become spaces, it is trimmed, and the header follows', async () => {
    const { core, channel } = await setup();
    const set = vi.spyOn(core, 'setChannelTopic');
    fireEvent.click(screen.getByRole('button', { name: `Channel topic: ${channel.topic}` }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Channel topic' })).getByRole('button', { name: 'Edit topic' }));
    const field = screen.getByRole('textbox', { name: 'Channel topic' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '  Ranked tonight\nbring snacks  ' } });
    expect(field.value).toBe('  Ranked tonight bring snacks  ');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(set).toHaveBeenLastCalledWith(channel.id, 'Ranked tonight bring snacks');
    expect(await screen.findByRole('button', { name: 'Channel topic: Ranked tonight bring snacks' })).toBeTruthy();
  });

  it('removing the topic leaves "Add a topic" for the owner', async () => {
    const { channel } = await setup();
    fireEvent.click(screen.getByRole('button', { name: `Channel topic: ${channel.topic}` }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Channel topic' })).getByRole('button', { name: 'Edit topic' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove topic' }));
    });
    expect(await screen.findByRole('button', { name: 'Add a topic' })).toBeTruthy();
  });

  it('says why when members need to update first, and stays open', async () => {
    const { core, channel } = await setup();
    vi.spyOn(core, 'setChannelTopic').mockRejectedValueOnce({ code: 'update-needed' });
    fireEvent.click(screen.getByRole('button', { name: `Channel topic: ${channel.topic}` }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Channel topic' })).getByRole('button', { name: 'Edit topic' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Channel topic' }), { target: { value: 'New' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Some members of this server need to update MVS before a topic can be set.');
    expect(screen.getByRole('dialog', { name: 'Channel topic' })).toBeTruthy();
  });

  it('the counter shows from 200 characters, and over 256 Save is off', async () => {
    const { channel } = await setup();
    fireEvent.click(screen.getByRole('button', { name: `Channel topic: ${channel.topic}` }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Channel topic' })).getByRole('button', { name: 'Edit topic' }));
    const field = screen.getByRole('textbox', { name: 'Channel topic' });
    fireEvent.change(field, { target: { value: 'x'.repeat(199) } });
    expect(screen.queryByText('199 / 256')).toBeNull();
    fireEvent.change(field, { target: { value: 'x'.repeat(257) } });
    expect(screen.getByText('257 / 256')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the channel menu has "Edit topic" for the owner', async () => {
    await setup();
    const row = document.querySelector('.channel-list li.channel-row button.channel')!;
    fireEvent.contextMenu(row);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit topic' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Channel topic' })).toBeTruthy());
  });
});
