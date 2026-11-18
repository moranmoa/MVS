// G-26 reactions, the UI half (#454's contract): the chips, adding from the toolbar,
// the "+" chip and the menu, toggling mine, the picker (search, recent, keys), errors.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/[⁨⁩]/g, '');
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

beforeEach(() => localStorage.clear());

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const rows = await screen.findAllByRole('article');
  const row = rows.filter((r) => r.querySelector('.msg:not(.skeleton):not(.deleted)')).at(-1)!;
  return { core, row };
}
const picker = () => screen.getByRole('dialog', { name: 'Add reaction' });

describe('reactions (G-26)', () => {
  it('adds from the toolbar, shows a pressed chip with the count, and a click takes it back', async () => {
    const { core, row } = await setup();
    const react = vi.spyOn(core, 'react');
    await click(within(row).getByRole('button', { name: 'Add reaction' }));
    await click(within(picker()).getByRole('button', { name: 'thumbs up' }));
    expect(react).toHaveBeenLastCalledWith(expect.any(String), '👍', true);
    expect(screen.queryByRole('dialog', { name: 'Add reaction' })).toBeNull();
    const chip = await within(row).findByRole('button', { name: (n) => plain(n) === '👍, 1' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await click(chip);
    expect(react).toHaveBeenLastCalledWith(expect.any(String), '👍', false);
    await waitFor(() => expect(within(row).queryByRole('button', { name: (n) => plain(n) === '👍, 1' })).toBeNull());
  });

  it('the message menu and the "+" chip open the same picker', async () => {
    const { core, row } = await setup();
    fireEvent.contextMenu(row);
    await click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Add reaction' }));
    await click(within(picker()).getByRole('button', { name: 'fire' }));
    await within(row).findByRole('group', { name: 'Reactions on this message' });
    const react = vi.spyOn(core, 'react');
    await click(within(within(row).getByRole('group', { name: 'Reactions on this message' })).getByRole('button', { name: 'Add reaction' }));
    await click(within(picker()).getByRole('button', { name: 'party popper' }));
    expect(react).toHaveBeenLastCalledWith(expect.any(String), '🎉', true);
  });

  it('search finds by name (he or en); Enter picks the first; recent comes first next time', async () => {
    const { row } = await setup();
    await click(within(row).getByRole('button', { name: 'Add reaction' }));
    const search = within(picker()).getByRole('searchbox', { name: 'Search emoji' });
    fireEvent.change(search, { target: { value: 'laugh' } });
    expect(within(picker()).getAllByRole('button').filter((b) => b.classList.contains('emoji-cell')).map((b) => b.textContent)).toContain('😂');
    fireEvent.change(search, { target: { value: 'nothing-like-this' } });
    expect(within(picker()).getByText('No emoji found')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'laugh' } });
    await act(async () => {
      fireEvent.keyDown(search, { key: 'Enter' });
    });
    await within(row).findByRole('button', { name: (n) => plain(n) === '😂, 1' });
    await click(within(row).getAllByRole('button', { name: 'Add reaction' })[0]);
    expect(within(picker()).getByRole('heading', { name: 'Recent' })).toBeTruthy();
  });

  it('errors from the core say why', async () => {
    const { core, row } = await setup();
    vi.spyOn(core, 'react').mockRejectedValueOnce({ code: 'bad-request' });
    await click(within(row).getByRole('button', { name: 'Add reaction' }));
    await click(within(picker()).getByRole('button', { name: 'thumbs up' }));
    expect(await screen.findByText('You can add up to 10 different emoji of your own to a message.')).toBeTruthy();
  });
});
