// G-51n (docs/ux/specs/server-icon-description.md §1): Settings → General has
// one "Save" for the name, the icon and description, and the age limit. The
// age confirmation comes first, and cancelling it saves nothing; leaving with
// a draft asks first, and the "General" tab shows a dot while there's one.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {}, inputLevel: () => 0, deafened: false, setDeafened: () => {}, volumes: {}, setVolume: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function openGeneral() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  const me = (await core.getIdentity())!.id;
  const server = (await core.listServers()).find((s) => s.ownerId === me)!;
  await core.setAgeRestriction(server.id, 'none');
  const spies = {
    rename: vi.spyOn(core, 'renameServer'),
    desc: vi.spyOn(core, 'setServerDescription'),
    age: vi.spyOn(core, 'setAgeRestriction'),
  };
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  await act(async () => {});
  const sidebar = screen.getByRole('complementary', { name: 'Channels' });
  await act(async () => {
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Server settings' }));
  });
  const panel = await screen.findByRole('tabpanel');
  return { core, server, panel, ...spies };
}

const click = async (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });
const nameBox = (panel: HTMLElement) => within(panel).getByRole('textbox', { name: 'Server name' }) as HTMLInputElement;

describe('G-51n: one Save for General', () => {
  it('saves the name, description and age limit together, with one "Changes saved"', async () => {
    const { panel, server, rename, desc, age } = await openGeneral();
    fireEvent.change(nameBox(panel), { target: { value: 'New name' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Description' }), { target: { value: 'Hello' } });
    await click(within(panel).getByRole('radio', { name: '16 and over' }));
    expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeTruthy();
    await click(within(panel).getByRole('button', { name: 'Save' }));
    expect(rename).toHaveBeenCalledWith(server.id, 'New name');
    expect(desc).toHaveBeenCalledWith(server.id, 'Hello');
    expect(age).toHaveBeenCalledWith(server.id, '16+');
    expect(await within(panel).findByText('Changes saved')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull();
  });

  it('raising to 18+ asks first; Cancel saves nothing on the page, not even the name', async () => {
    const { panel, rename, age } = await openGeneral();
    fireEvent.change(nameBox(panel), { target: { value: 'New name' } });
    await click(within(panel).getByRole('radio', { name: '18 and over' }));
    await click(within(panel).getByRole('button', { name: 'Save' }));
    const ask = screen.getByRole('dialog', { name: /Limit this server/ });
    await click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(rename).not.toHaveBeenCalled();
    expect(age).not.toHaveBeenCalled();
    // The name stays a draft; the age choice went back.
    expect(nameBox(panel).value).toBe('New name');
    expect((within(panel).getByRole('radio', { name: /^No limit/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('an empty name keeps Save off', async () => {
    const { panel } = await openGeneral();
    fireEvent.change(nameBox(panel), { target: { value: '   ' } });
    expect((within(panel).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaving with a draft asks: Keep editing stays, Discard restores and goes', async () => {
    const { server, panel, rename } = await openGeneral();
    fireEvent.change(nameBox(panel), { target: { value: 'Draft name' } });
    await click(screen.getByRole('tab', { name: /Channels/ }));
    let ask = screen.getByRole('dialog', { name: 'Save your server changes?' });
    await click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('tab', { name: /General/ }).getAttribute('aria-selected')).toBe('true');
    expect(nameBox(screen.getByRole('tabpanel')).value).toBe('Draft name');
    await click(screen.getByRole('tab', { name: /Channels/ }));
    ask = screen.getByRole('dialog', { name: 'Save your server changes?' });
    await click(within(ask).getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('tab', { name: /Channels/ }).getAttribute('aria-selected')).toBe('true');
    expect(rename).not.toHaveBeenCalled();
    await click(screen.getByRole('tab', { name: /General/ }));
    expect(nameBox(screen.getByRole('tabpanel')).value).toBe(server.name);
  });
});
