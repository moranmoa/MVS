// G-47: Settings → Privacy → "Blocked accounts": everyone I blocked, once each,
// with Unblock, a 5 s Undo, and focus kept in the list.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import type { Member } from '../core';
import { blockedUsers, UNDO_MS } from '../screens/settings/Blocked';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const server = (await core.listServers())[0]!;
  const me = (await core.getIdentity())!.id;
  const others = (await core.listMembers(server.id)).filter((m) => m.id !== me);
  return { core, server, others };
}
async function openPrivacy() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Privacy' }));
  return screen.findByRole('region', { name: 'Blocked accounts' });
}
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });
const nameOf = (m: Member) => m.displayName || 'Unknown account';

const member = (id: string, name: string, over: Partial<Member> = {}): Member => ({
  id,
  serverId: 's',
  displayName: name,
  shortCode: id.toUpperCase(),
  avatarColor: '#445566',
  presence: 'offline',
  isOwner: false,
  ...over,
});

describe('G-47: blocked accounts', () => {
  it('gathers blocked members across servers, once each, sorted, never me', () => {
    const list = blockedUsers(
      {
        a: [member('u1', 'Zed', { blocked: true }), member('u2', 'Amy'), member('me', 'Me', { blocked: true })],
        b: [member('u1', 'Zed', { blocked: true }), member('u3', 'Bea', { blocked: true })],
      },
      'me',
      'en',
    );
    expect(list.map((m) => m.id)).toEqual(['u3', 'u1']);
  });

  it('empty at first; Unblock takes them off, focus moves to the next row, then the heading', async () => {
    const { core, others } = await setup();
    const region = await openPrivacy();
    expect(within(region).getByText("You haven't blocked anyone.")).toBeTruthy();
    const [a, b] = others;
    await act(async () => {
      await core.blockUser(a!.id);
      await core.blockUser(b!.id);
    });
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(2));
    const first = within(region).getAllByRole('button', { name: /^Unblock / })[0]!;
    await click(first);
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(1));
    const rest = within(region).getByRole('button', { name: /^Unblock / });
    expect(document.activeElement).toBe(rest);
    await click(rest);
    await waitFor(() => expect(within(region).queryByRole('listitem')).toBeNull());
    expect(document.activeElement).toBe(within(region).getByRole('heading', { name: 'Blocked accounts' }));
  });

  it('a double click leaves them unblocked (blockUser toggles: called once)', async () => {
    const { core, others } = await setup();
    const region = await openPrivacy();
    const target = others[0]!;
    await act(async () => core.blockUser(target.id));
    const unblock = await within(region).findByRole('button', { name: `Unblock ⁨${nameOf(target)}⁩` });
    const spy = vi.spyOn(core, 'blockUser');
    await act(async () => {
      fireEvent.click(unblock);
      fireEvent.click(unblock);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(region).queryByRole('listitem')).toBeNull());
    const server = (await core.listServers())[0]!;
    expect((await core.listMembers(server.id)).find((m) => m.id === target.id)?.blocked).toBeFalsy();
  });

  it('Undo blocks again within 5 s; after that it goes away', async () => {
    const { core, others } = await setup();
    const region = await openPrivacy();
    const target = others[0]!;
    await act(async () => core.blockUser(target.id));
    await click(await within(region).findByRole('button', { name: /^Unblock / }));
    const status = within(region).getByRole('status');
    expect(status.textContent).toBe(`You unblocked ⁨${nameOf(target)}⁩.Undo`);
    await click(within(status).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(1));
    expect(status.textContent).toBe('');

    vi.useFakeTimers();
    try {
      await click(within(region).getByRole('button', { name: /^Unblock / }));
      expect(within(status).getByRole('button', { name: 'Undo' })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(UNDO_MS);
      });
      expect(within(status).queryByRole('button', { name: 'Undo' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed unblock says so and keeps them listed', async () => {
    const { core, others } = await setup();
    const region = await openPrivacy();
    await act(async () => core.blockUser(others[0]!.id));
    const unblock = await within(region).findByRole('button', { name: /^Unblock / });
    vi.spyOn(core, 'blockUser').mockRejectedValueOnce(new Error('down'));
    await click(unblock);
    expect((await within(region).findByRole('alert')).textContent).toBe("Couldn't change the block. Try again.");
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
  });

  it("the profile card's link opens Privacy at the list", async () => {
    const { others } = await setup();
    const target = others.find((m) => m.displayName)!;
    await click(screen.getAllByRole('button', { name: new RegExp(`^⁨${target.displayName}⁩'s profile`) })[0]!);
    await click(await screen.findByRole('button', { name: 'See blocked accounts' }));
    const region = await screen.findByRole('region', { name: 'Blocked accounts' });
    await waitFor(() => expect(document.activeElement).toBe(within(region).getByRole('heading', { name: 'Blocked accounts' })));
  });
});
