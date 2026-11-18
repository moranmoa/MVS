// G-29: "is typing…" (g29-typing-design.md, UX #427 §1, PO #426): the line above
// the composer, the 6 s backstop, sending while typing, and the privacy switch.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanCoreSettings, cleanTyping } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/[⁨⁩]/g, '');
const line = () => document.querySelector('.typing-line')!;

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  const box = (await screen.findByRole('textbox', { name: /^Message / })) as HTMLTextAreaElement;
  const [server] = await core.listServers();
  const [channel] = await core.listChannels(server.id);
  const members = (await core.listMembers(server.id)).filter((m) => m.id !== (core as unknown as { identity: { id: string } }).identity.id);
  return { core, box, channelId: channel.id, members };
}

afterEach(() => vi.useRealTimers());

describe('typing indicator (G-29)', () => {
  it('shows one, two, then "Several people"; not announced; the line keeps its place', async () => {
    const { core, channelId, members } = await setup();
    expect(line().getAttribute('aria-live')).toBe('off');
    expect(line().textContent).toBe('');
    act(() => core.simulateTyping(channelId, [members[0].id]));
    expect(plain(line().textContent)).toBe(`${members[0].displayName} is typing…`);
    act(() => core.simulateTyping(channelId, [members[0].id, members[1].id]));
    expect(plain(line().textContent)).toBe(`${members[0].displayName} and ${members[1].displayName} are typing…`);
    act(() => core.simulateTyping(channelId, members.slice(0, 3).map((m) => m.id)));
    expect(line().textContent).toBe('Several people are typing…');
    act(() => core.simulateTyping(channelId, []));
    expect(line().textContent).toBe('');
  });

  it('a typer the core stops refreshing is gone after 6 s (the backstop)', async () => {
    const { core, channelId, members } = await setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => core.simulateTyping(channelId, [members[0].id]));
    expect(line().textContent).not.toBe('');
    await act(async () => {
      vi.advanceTimersByTime(6100);
    });
    expect(line().textContent).toBe('');
  });

  it('blocked accounts and I are never shown', async () => {
    const { core, channelId, members } = await setup();
    const me = (await core.getIdentity())!;
    await core.blockUser(members[0].id).catch(() => {});
    act(() => core.simulateTyping(channelId, [me.id, members[0].id]));
    await waitFor(() => expect(line().textContent).toBe(''));
  });

  it('typing tells the core; send and clear stop it', async () => {
    const { core, box, channelId } = await setup();
    const spy = vi.spyOn(core, 'setTyping');
    fireEvent.change(box, { target: { value: 'h' } });
    expect(spy).toHaveBeenLastCalledWith(channelId, true);
    // Throttled: a burst of keys is one call.
    fireEvent.change(box, { target: { value: 'he' } });
    fireEvent.change(box, { target: { value: 'hel' } });
    expect(spy.mock.calls.filter(([, on]) => on)).toHaveLength(1);
    fireEvent.change(box, { target: { value: '' } });
    expect(spy).toHaveBeenLastCalledWith(channelId, false);
    fireEvent.change(box, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(spy).toHaveBeenLastCalledWith(channelId, false);
  });

  it('the privacy switch (on by default) stops sending; others are still shown', async () => {
    const { core, box, channelId, members } = await setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Privacy' }));
    const toggle = screen.getByRole('switch', { name: "Show others when I'm typing" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect((await core.getSettings()).typingIndicator).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    const spy = vi.spyOn(core, 'setTyping');
    fireEvent.change(box, { target: { value: 'quiet' } });
    expect(spy).not.toHaveBeenCalled();
    act(() => core.simulateTyping(channelId, [members[0].id]));
    expect(line().textContent).not.toBe('');
  });

  it('the sanitizer: a channel and at most 5 distinct ids; settings default on', () => {
    const id = (c: string) => c.repeat(64);
    expect(cleanTyping({ channelId: id('a'), userIds: [id('1')] })).toEqual({ channelId: id('a'), userIds: [id('1')] });
    for (const bad of [
      null,
      { channelId: '<x>', userIds: [] },
      { channelId: id('a'), userIds: ['1', '2', '3', '4', '5', '6'].map(id) },
      { channelId: id('a'), userIds: [id('1'), id('1')] },
      { channelId: id('a'), userIds: ['<img>'] },
      { channelId: id('a'), userIds: 'x' },
      { channelId: id('a'), userIds: [], name: 'x' },
    ]) {
      expect(cleanTyping(bad)).toBeNull();
    }
    expect(cleanCoreSettings({ typingIndicator: false })).toEqual({ typingIndicator: false });
    expect(cleanCoreSettings({ typingIndicator: 'no' })).toEqual({ typingIndicator: true });
    expect(cleanCoreSettings(null)).toEqual({ typingIndicator: true });
  });
});
