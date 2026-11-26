// G-52 (docs/ux/specs/server-age-limit.md §6): the server's age limit, with
// the PO's rule from G-77: never open 18+ to minors silently.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore, type MockOptions } from '../core/mock';
import { ageChangeKind } from '../screens/shell/AgeLimit';

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

// \`prepare\` runs before the app starts (the sanitizer wraps the core then).
async function openGeneral(prepare?: (core: MockCore, serverId: string) => Promise<void> | void, options: MockOptions = {}) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false, ...options });
  const me = (await core.getIdentity())!.id;
  const server = (await core.listServers()).find((s) => s.ownerId === me)!;
  await prepare?.(core, server.id);
  const set = vi.spyOn(core, 'setAgeRestriction');
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const sidebar = screen.getByRole('complementary', { name: 'Channels' });
  fireEvent.click(within(sidebar).getByRole('button', { name: 'Server settings' }));
  const dialog = screen.getByRole('dialog');
  return { core, server, set, dialog };
}
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole('radio', { name }) as HTMLInputElement;
const saveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Save age limit' });

describe('G-52: which changes need a confirmation', () => {
  it('none between "no limit" and 16+; raise to 18+; lower from 18+', () => {
    expect(ageChangeKind('none', '16+')).toBe('none');
    expect(ageChangeKind('16+', 'none')).toBe('none');
    expect(ageChangeKind('none', '18+')).toBe('raise');
    expect(ageChangeKind('16+', '18+')).toBe('raise');
    expect(ageChangeKind('18+', '16+')).toBe('lower');
    expect(ageChangeKind('18+', 'none')).toBe('lower');
  });
});

describe("G-52: the server's age limit", () => {
  it('"no limit" ↔ 16+ saves with no dialog (§6.1)', async () => {
    const { dialog, set, server } = await openGeneral(async (core, id) => {
      await core.setAgeRestriction(id, 'none');
    });
    await click(radio(dialog, '16 and over'));
    await click(saveButton(dialog));
    expect(screen.queryByRole('dialog', { name: /Limit this server/ })).toBeNull();
    expect(set).toHaveBeenCalledWith(server.id, '16+');
    expect(await within(dialog).findByText('Age limit saved')).toBeTruthy();
  });

  it('to 18+: the raise dialog; Cancel saves nothing and goes back (§6.2)', async () => {
    const { dialog, set } = await openGeneral(async (core, id) => {
      await core.setAgeRestriction(id, '16+');
    });
    await click(radio(dialog, '18 and over'));
    await click(saveButton(dialog));
    const raise = screen.getByRole('dialog', { name: 'Limit this server to 18 and over?' });
    await waitFor(() => expect(document.activeElement).toBe(within(raise).getByRole('button', { name: 'Cancel' })));
    // UX on #591: described by the explanation and the count.
    const ids = raise.getAttribute('aria-describedby')!.split(' ');
    expect(document.getElementById(ids[0]!)?.textContent).toMatch(/^Members under 18 can no longer read/);
    // PO (0.6.0): it says how many members lose access, from the core's count.
    expect((await within(raise).findByRole('status')).textContent).toMatch(/^\d+ accounts? (is|are) affected\.$/);
    await click(within(raise).getByRole('button', { name: 'Cancel' }));
    expect(set).not.toHaveBeenCalled();
    expect(radio(dialog, '16 and over').checked).toBe(true);
  });

  it('to 18+, confirmed: saved', async () => {
    const { dialog, set, server } = await openGeneral(async (core, id) => {
      await core.setAgeRestriction(id, '16+');
    });
    await click(radio(dialog, '18 and over'));
    await click(saveButton(dialog));
    await click(within(screen.getByRole('dialog', { name: 'Limit this server to 18 and over?' })).getByRole('button', { name: 'Limit to 18+' }));
    expect(set).toHaveBeenCalledWith(server.id, '18+');
  });

  it('from 18+: the lower dialog; confirm stays disabled until the box is ticked (§6.3)', async () => {
    const { dialog, set, server } = await openGeneral(async (core, id) => {
      await core.setAgeRestriction(id, '18+');
    });
    await click(radio(dialog, '16 and over'));
    await click(saveButton(dialog));
    const lower = screen.getByRole('dialog', { name: 'Open this server to 16- and 17-year-olds too?' });
    expect(within(lower).getByText(/Channels marked 18\+ stay 18\+/)).toBeTruthy();
    // UX on #591: the dialog is described by its explanation.
    expect(lower.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(lower.getAttribute('aria-describedby')!)?.textContent).toMatch(/^16- and 17-year-olds will be able to join/);
    const confirm = within(lower).getByRole('button', { name: 'Open to 16 and over' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await click(confirm);
    expect(set).not.toHaveBeenCalled();
    await click(within(lower).getByRole('checkbox', { name: "I've checked that the regular channels suit ages 16 and up." }));
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    await click(confirm);
    expect(set).toHaveBeenCalledWith(server.id, '16+');
  });

  it('an owner under 18: 18+ disabled, with the reason (§6.4)', async () => {
    const { dialog } = await openGeneral((core) => {
      (core as unknown as { persisted: { identity: { birthDate: string } } }).persisted.identity.birthDate = '2010-06-01';
    });
    const r18 = radio(dialog, '18 and over');
    expect(r18.disabled).toBe(true);
    expect(within(dialog).getByText("You can choose 18+ only if you're 18 or older.")).toBeTruthy();
  });

  it('the mock core refuses 18+ from an owner under 18 with too-young, as the core does', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    (core as unknown as { persisted: { identity: { birthDate: string } } }).persisted.identity.birthDate = '2010-06-01';
    const me = (await core.getIdentity())!.id;
    const server = (await core.listServers()).find((s) => s.ownerId === me)!;
    await expect(core.setAgeRestriction(server.id, '18+')).rejects.toMatchObject({ code: 'too-young' });
  });

  it('a member on an old version: update-needed, and the limit is unchanged (§6.6)', async () => {
    const { dialog, core, server } = await openGeneral(undefined, { outdatedMembers: true });
    const before = server.ageRestriction;
    await click(radio(dialog, before === '16+' ? 'No limit beyond the minimum age (16)' : '16 and over'));
    await click(saveButton(dialog));
    await waitFor(() => expect(dialog.querySelector('.update-needed, [role="alert"]')).toBeTruthy());
    expect((await core.listServers()).find((s) => s.id === server.id)!.ageRestriction).toBe(before);
  });
});

describe('G-52: the affected count (core #590)', () => {
  it('0 below 18+; a count, without names, for 18+; owner only', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const me = (await core.getIdentity())!.id;
    const servers = await core.listServers();
    const own = servers.find((s) => s.ownerId === me)!;
    const other = servers.find((s) => s.ownerId !== me)!;
    expect(await core.countAgeAffected(own.id, '16+')).toEqual({ count: 0 });
    const r = await core.countAgeAffected(own.id, '18+');
    expect(Object.keys(r)).toEqual(['count']);
    expect(r.count).toBeGreaterThan(0);
    await expect(core.countAgeAffected(other.id, '18+')).rejects.toMatchObject({ code: 'not-allowed' });
  });
});

describe('G-52 (core #616): staff see who has no 18+ claim; a minor is told', () => {
  it('after raising to 18+, members without a claim are tagged for the owner, in the row name too', async () => {
    const { core, server } = await openGeneral();
    await act(async () => {
      await core.setAgeRestriction(server.id, '18+');
    });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    const list = screen.getByRole('complementary', { name: 'Server members' });
    const tagged = await within(list).findAllByRole('button', { name: /No 18\+ confirmation/ });
    expect(tagged.length).toBeGreaterThan(0);
    expect(within(tagged[0]!).getByText('No 18+ confirmation').getAttribute('title')).toBe(
      'This account has no 18+ age confirmation. In an 18+ server you can remove it.',
    );
  });

  it('the sanitizer keeps notAdult only when it is exactly true', async () => {
    const { cleanMember } = await import('../core/sanitize');
    const base = { id: 'u', serverId: 's', displayName: 'A', shortCode: 'AAAA-BBBB', avatarColor: '#445566', presence: 'offline' as const, isOwner: false };
    expect(cleanMember({ ...base, notAdult: true })).toHaveProperty('notAdult', true);
    expect(cleanMember({ ...base, notAdult: 'yes' } as never)).not.toHaveProperty('notAdult');
  });

  it("a minor removed by a raise is told why (server.removed reason 'age')", async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    await act(async () => {});
    const server = (await core.listServers())[1]!;
    await act(async () => (core as unknown as { emit: (e: string, p: unknown) => void }).emit('server.removed', { serverId: server.id, reason: 'age' }));
    expect(await screen.findByText(`\u2068${server.name}\u2069 is now limited to 18 and over, so it's no longer available to you.`)).toBeTruthy();
  });
});
