// G-47: Settings → Privacy → "Blocked accounts": everyone I blocked, once each,
// with Unblock, a 5 s Undo, and focus kept in the list. The core's listBlocked
// and setBlocked (dev-identity #502), with the member lists as a fallback.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import type { Member } from '../core';
import { blockedRows, UNDO_MS } from '../screens/settings/Blocked';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

// `prepare` runs before the app starts (the sanitizer wraps the core then).
async function setup(prepare?: (core: MockCore) => void) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  prepare?.(core);
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
  it('older core (no listBlocked): gathers blocked members across servers, once each, sorted, never me', () => {
    const list = blockedRows(
      null,
      {
        a: [member('u1', 'Zed', { blocked: true }), member('u2', 'Amy'), member('me', 'Me', { blocked: true })],
        b: [member('u1', 'Zed', { blocked: true }), member('u3', 'Bea', { blocked: true })],
      },
      'me',
      'en',
    );
    expect(list.map((m) => m.id)).toEqual(['u3', 'u1']);
    expect(list[0]).toMatchObject({ name: 'Bea', shortCode: 'U3', color: '#445566' });
  });

  it("the core's list: people who share no server are listed too, by their kept name or as unknown", () => {
    const list = blockedRows(
      [{ userId: 'u1', name: 'Old name' }, { userId: 'gone', name: 'Kept' }, { userId: 'nameless' }, { userId: 'me' }],
      { a: [member('u1', 'Zed', { blocked: true })] },
      'me',
      'en',
    );
    // Sorted by name, unknown last; the member list's name wins; no code for strangers.
    expect(list.map((r) => [r.id, r.name, r.shortCode])).toEqual([
      ['gone', 'Kept', undefined],
      ['u1', 'Zed', 'U1'],
      ['nameless', '', undefined],
    ]);
  });

  it('someone blocked who shares no server is listed, as Unknown account when nameless', async () => {
    await setup((core) => vi.spyOn(core, 'listBlocked').mockResolvedValue([{ userId: 'a'.repeat(64) }, { userId: 'b'.repeat(64), name: 'Rina' }]));
    const region = await openPrivacy();
    expect(await within(region).findByRole('button', { name: 'Unblock ⁨Rina⁩' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Unblock ⁨Unknown account⁩' })).toBeTruthy();
  });

  it("a transient listBlocked error: the member lists meanwhile, then the core's list after a retry (TL)", async () => {
    let calls = 0;
    const { core, others } = await setup((core) => {
      const real = core.listBlocked.bind(core);
      core.listBlocked = vi.fn(() => (++calls === 1 ? Promise.reject({ code: 'internal' }) : real()));
    });
    const region = await openPrivacy();
    // Blocked before the retry: shown from the member lists meanwhile.
    await act(async () => core.blockUser(others[0]!.id));
    await within(region).findByRole('button', { name: /^Unblock / });
    await waitFor(() => expect(calls).toBe(2), { timeout: 3000 });
    // Now on the core's list: Unblock is setBlocked.
    const set = vi.spyOn(core, 'setBlocked');
    await click(within(region).getByRole('button', { name: /^Unblock / }));
    expect(set).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), false);
  });

  it('older core (bad-request): no retry', async () => {
    const list = vi.fn().mockRejectedValue({ code: 'bad-request' });
    await setup((core) => {
      core.listBlocked = list;
    });
    await openPrivacy();
    await new Promise((r) => setTimeout(r, 1300));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('older core (listBlocked fails): the member lists and the toggle', async () => {
    const { core, others } = await setup((core) => {
      core.listBlocked = vi.fn().mockRejectedValue({ code: 'bad-request' });
      // An older core sends no blocks.changed either.
      const emit = (core as unknown as { emit: (e: string, p: unknown) => void }).emit.bind(core);
      (core as unknown as { emit: (e: string, p: unknown) => void }).emit = (e, p) => e !== 'blocks.changed' && emit(e, p);
    });
    const region = await openPrivacy();
    await act(async () => core.blockUser(others[0]!.id));
    const unblock = await within(region).findByRole('button', { name: /^Unblock / });
    const toggle = vi.spyOn(core, 'blockUser');
    const set = vi.spyOn(core, 'setBlocked');
    await click(unblock);
    expect(toggle).toHaveBeenCalledWith(others[0]!.id);
    expect(set).not.toHaveBeenCalled();
    await waitFor(() => expect(within(region).queryByRole('listitem')).toBeNull());
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

  it('Unblock is setBlocked(false), once on a double click; they stay unblocked', async () => {
    const { core, others } = await setup();
    const region = await openPrivacy();
    const target = others[0]!;
    await act(async () => core.blockUser(target.id));
    const unblock = await within(region).findByRole('button', { name: `Unblock ⁨${nameOf(target)}⁩` });
    const spy = vi.spyOn(core, 'setBlocked');
    await act(async () => {
      fireEvent.click(unblock);
      fireEvent.click(unblock);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), false); // the core's account id
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
    const set = vi.spyOn(core, 'setBlocked');
    await click(within(status).getByRole('button', { name: 'Undo' }));
    expect(set).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), true);
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

      // WCAG 2.2.1: kept while the pointer is on it; 5 s more after it leaves.
      await act(async () => core.setBlocked(target.id, true));
      await click(within(region).getByRole('button', { name: /^Unblock / }));
      const bar = status.querySelector('.blocked-undo')!;
      fireEvent.mouseEnter(bar);
      await act(async () => {
        vi.advanceTimersByTime(UNDO_MS * 3);
      });
      expect(within(status).getByRole('button', { name: 'Undo' })).toBeTruthy();
      fireEvent.mouseLeave(bar);
      await act(async () => {
        vi.advanceTimersByTime(UNDO_MS - 1);
      });
      expect(within(status).getByRole('button', { name: 'Undo' })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(1);
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
    vi.spyOn(core, 'setBlocked').mockRejectedValueOnce(new Error('down'));
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

describe('G-47: the sanitizer', () => {
  it('keeps a usable id and a clean name; drops entries without an id', async () => {
    const { cleanBlockedUser } = await import('../core/sanitize');
    expect(cleanBlockedUser({ userId: 'a'.repeat(64), name: 'Rina' })).toEqual({ userId: 'a'.repeat(64), name: 'Rina' });
    expect(cleanBlockedUser({ userId: 'a'.repeat(64), name: '' })).toEqual({ userId: 'a'.repeat(64) });
    expect(cleanBlockedUser({ userId: 'a'.repeat(64), name: 'Tal\u202e' })?.name).not.toContain('\u202e');
    expect(cleanBlockedUser({ name: 'x' } as never)).toBeNull();
    // SL: a strict 64 lower-case hex id, like removed accounts.
    expect(cleanBlockedUser({ userId: 'u-tal', name: 'Tal' })).toBeNull();
    expect(cleanBlockedUser({ userId: 'A'.repeat(64) })).toBeNull();
    expect(cleanBlockedUser({ userId: 'a'.repeat(63) })).toBeNull();
    expect(cleanBlockedUser(null as never)).toBeNull();
  });
});

describe('G-47b (UX-19): the short code on every row', () => {
  it("strangers show the core's code, so two unknown accounts can be told apart", async () => {
    await setup((core) =>
      vi.spyOn(core, 'listBlocked').mockResolvedValue([
        { userId: 'a'.repeat(64), shortCode: 'AAAA-1111' },
        { userId: 'b'.repeat(64), shortCode: 'BBBB-2222' },
      ]),
    );
    const region = await openPrivacy();
    const rows = await within(region).findAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.blocked-code')?.textContent)).toEqual(['AAAA-1111', 'BBBB-2222']);
  });

  it('the sanitizer keeps a clean short code', async () => {
    const { cleanBlockedUser } = await import('../core/sanitize');
    expect(cleanBlockedUser({ userId: 'a'.repeat(64), shortCode: 'AAAA-1111', name: 'Rina' })).toEqual({
      userId: 'a'.repeat(64),
      shortCode: 'AAAA-1111',
      name: 'Rina',
    });
    expect(cleanBlockedUser({ userId: 'a'.repeat(64) })).toEqual({ userId: 'a'.repeat(64) });
  });
});
