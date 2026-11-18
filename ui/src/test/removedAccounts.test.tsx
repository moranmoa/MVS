// G-53 (B11 "Removed accounts" page, rows per B11a–d §5א, ש-4): the owner's
// list of removed accounts in server settings, with "Undo removal".

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanRemovedMember } from '../core/sanitize';
import { REMOVED_PAGE } from '../screens/shell/RemovedAccounts';

const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

// `prepare` runs before the app starts (the sanitizer wraps the core then).
async function setup(prepare?: (core: MockCore) => void) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  prepare?.(core);
  render(<App core={core} initialSettings={settings} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const me = (await core.getIdentity())!.id;
  const server = (await core.listServers()).find((s) => s.ownerId === me)!;
  const others = (await core.listMembers(server.id)).filter((m) => m.id !== me && !m.isOwner);
  return { core, server, others };
}
function openSettings() {
  const sidebar = screen.getByRole('complementary', { name: 'Channels' });
  fireEvent.click(within(sidebar).getByRole('button', { name: 'Server settings' }));
  return screen.getByRole('dialog');
}
async function openRemoved() {
  const dialog = openSettings();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Removed accounts' }));
  });
  return { dialog, panel: within(dialog).getByRole('tabpanel', { name: 'Removed accounts' }) };
}
const name = (m: { displayName: string; shortCode: string }) => m.displayName || m.shortCode;

describe('G-53: removed accounts', () => {
  it('its own page, right after Members; with no removals it says so', async () => {
    await setup();
    const dialog = openSettings();
    const tabs = within(dialog)
      .getAllByRole('tab')
      .map((t) => t.textContent);
    expect(tabs.indexOf('Removed accounts')).toBe(tabs.indexOf('Members') + 1);
    const { panel } = await openRemoved();
    expect(await within(panel).findByText('No removed accounts.')).toBeTruthy();
    expect(within(panel).queryByRole('list')).toBeNull();
  });

  it('newest first; Undo removal calls undoKick once, the row goes, focus moves on, then to the heading', async () => {
    const { core, server, others } = await setup();
    const [a, b] = others;
    await act(async () => {
      await core.kickMember(server.id, a!.id);
    });
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => {
      await core.kickMember(server.id, b!.id);
    });
    const { panel } = await openRemoved();
    const buttons = await within(panel).findAllByRole('button', { name: /^Undo removal of / });
    // Newest first: b was removed last.
    expect(buttons.map((x) => x.getAttribute('aria-label'))).toEqual([
      `Undo removal of ⁨${name(b!)}⁩`,
      `Undo removal of ⁨${name(a!)}⁩`,
    ]);
    expect(within(panel).getAllByRole('listitem')[0]!.textContent).toContain(b!.shortCode);

    const spy = vi.spyOn(core, 'undoKick');
    await act(async () => {
      fireEvent.click(buttons[0]!);
      fireEvent.click(buttons[0]!); // a double click: one call
    });
    await waitFor(() => expect(within(panel).getAllByRole('listitem')).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1);
    // Sent as the 64-hex account id the core listed.
    expect(spy).toHaveBeenCalledWith(server.id, expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: /^Undo removal of / }));
    expect(await screen.findByText('Removal undone. They can join again with an invite link.')).toBeTruthy();
    expect((await core.listRemovedMembers(server.id)).map((r) => r.displayName)).toEqual([a!.displayName]);

    // The last one: the empty line, focus on the page heading.
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: /^Undo removal of / }));
    });
    expect(await within(panel).findByText('No removed accounts.')).toBeTruthy();
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { name: 'Removed accounts', level: 3 }));
  });

  it('a failure shows in the row with "Try again"', async () => {
    const { core, server, others } = await setup();
    await act(async () => {
      await core.kickMember(server.id, others[0]!.id);
    });
    const { panel } = await openRemoved();
    const undo = await within(panel).findByRole('button', { name: /^Undo removal of / });
    vi.spyOn(core, 'undoKick').mockRejectedValueOnce({ code: 'internal' });
    await act(async () => {
      fireEvent.click(undo);
    });
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong.');
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    });
    expect(await within(panel).findByText('No removed accounts.')).toBeTruthy();
  });

  it(`over ${REMOVED_PAGE}: the first ${REMOVED_PAGE}, then "Show all"`, async () => {
    const many = Array.from({ length: REMOVED_PAGE + 3 }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'),
      shortCode: `AAAA-${String(i).padStart(4, '0')}`,
      displayName: `Person ${i}`,
      removedAt: 1_700_000_000_000 + i,
    }));
    await setup((core) => vi.spyOn(core, 'listRemovedMembers').mockResolvedValue(many));
    const { panel } = await openRemoved();
    await within(panel).findAllByRole('listitem');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(REMOVED_PAGE);
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: `Show all ${REMOVED_PAGE + 3}` }));
    });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(REMOVED_PAGE + 3);
  });

  it('a kick while the page is open shows up (members.changed; the core sends no server.updated)', async () => {
    const { core, server, others } = await setup();
    const { panel } = await openRemoved();
    expect(await within(panel).findByText('No removed accounts.')).toBeTruthy();
    await act(async () => {
      await core.kickMember(server.id, others[0]!.id);
    });
    expect(await within(panel).findByRole('button', { name: `Undo removal of ⁨${name(others[0]!)}⁩` })).toBeTruthy();
  });

  it("the Invite page's hint links to the page", async () => {
    await setup();
    const dialog = openSettings();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Invite link' }));
    expect(within(dialog).getByText(/Removed accounts can't join again with the link\./)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'You can undo a removal on the Removed accounts page.' }));
    });
    expect(within(dialog).getByRole('tab', { name: 'Removed accounts' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Removed accounts', level: 3 }));
  });

  it('the sanitizer drops entries without a 64-hex id (SL), and keeps only clean fields', () => {
    expect(cleanRemovedMember({ id: 'u-tal', shortCode: 'ABCD-EFGH', displayName: 'Tal', removedAt: 1 })).toBeNull();
    expect(cleanRemovedMember({ id: 'A'.repeat(64), shortCode: 'ABCD-EFGH', displayName: 'Tal', removedAt: 1 })).toBeNull();
    expect(cleanRemovedMember(null as never)).toBeNull();
    expect(
      cleanRemovedMember({ id: 'a'.repeat(64), shortCode: 'abcd-efgh', displayName: 'Tal‮', removedAt: -5, extra: 1 } as never),
    ).toEqual({ id: 'a'.repeat(64), shortCode: expect.any(String), displayName: expect.not.stringContaining('‮'), removedAt: 0 });
  });
});
