// G-113: a new message, while I'm at the bottom of the channel on screen, is
// read out politely; the wording follows the notification-preview choice.

import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { defaultNotifyPrefs } from '../app/notify';
import type { Settings } from '../app/settings';
import type { CoreEvents } from '../core/api';
import { MockCore } from '../core/mock';
import type { Message } from '../core/types';
import { ANNOUNCE_GAP_MS } from '../screens/shell/MessageList';

async function setup(preview: boolean) {
  const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15, notify: { ...defaultNotifyPrefs(), preview } };
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={settings} />);
  const box = await screen.findByRole('textbox', { name: /^Message / });
  const channelId = 'c-general';
  await waitFor(() => expect(document.querySelector('.message-area [aria-live="polite"]')).toBeTruthy());
  const members = await core.listMembers('s-gamers');
  const author = members.find((m) => !m.blocked && !m.isOwner && m.presence === 'online')!;
  const me = (await core.getIdentity())!;
  let index = await core.getMessageCount(channelId);
  const add = (over: Partial<Message> = {}) =>
    act(() =>
      (core as unknown as { emit: <E extends keyof CoreEvents>(e: E, p: CoreEvents[E]) => void }).emit('message.added', {
        id: `m-${index}`,
        channelId,
        index: index++,
        authorId: author.id,
        body: 'Anyone   up tonight?',
        createdAt: Date.now(),
        ...over,
      } as Message),
    );
  const live = () => document.querySelector('.message-area [aria-live="polite"]')!.textContent;
  return { add, live, author, me, box };
}

describe('G-113: new messages for screen readers', () => {
  it('with previews on: "{name}: {text}" (spaces collapsed); nothing for what was there already', async () => {
    const { add, live, author } = await setup(true);
    expect(live()).toBe('');
    await add();
    expect(live()).toBe(`⁨${author.displayName}⁩: ⁨Anyone up tonight?⁩`);
  });

  it('with previews off (the default): only "New message from {name}"', async () => {
    const { add, live, author } = await setup(false);
    await add({ body: 'a secret' });
    expect(live()).toBe(`New message from ⁨${author.displayName}⁩`);
    expect(live()).not.toContain('secret');
  });

  it('long text is cut to 100 characters; my own messages are not read', async () => {
    const { add, live, me } = await setup(true);
    await add({ authorId: me.id, body: 'mine' });
    expect(live()).toBe('');
    await add({ body: 'x'.repeat(150) });
    expect(live()).toMatch(new RegExp(`: ⁨${'x'.repeat(100)}…⁩$`));
  });

  it('several within 1.5 s become one "{count} new messages"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { add, live } = await setup(true);
      await add({ body: 'one' });
      expect(live()).toMatch(/: ⁨one⁩$/);
      await add({ body: 'two' });
      await add({ body: 'three' });
      expect(live()).toMatch(/: ⁨one⁩$/); // held
      await act(async () => {
        vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
      });
      expect(live()).toBe('2 new messages');
    } finally {
      vi.useRealTimers();
    }
  });
});
