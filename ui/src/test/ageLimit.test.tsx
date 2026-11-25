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

  it('the mock core refuses 18+ from an owner under 18, as the core does', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    (core as unknown as { persisted: { identity: { birthDate: string } } }).persisted.identity.birthDate = '2010-06-01';
    const me = (await core.getIdentity())!.id;
    const server = (await core.listServers()).find((s) => s.ownerId === me)!;
    await expect(core.setAgeRestriction(server.id, '18+')).rejects.toMatchObject({ code: 'not-allowed' });
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
