// G-53 (B11a–d §5א, core #503): joining as an account the owner removed.
// The core answers join.status { phase: 'removed' }: final, "Close" only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

describe('G-53: join as a removed account', () => {
  it('says why, with "Close" only (no Join, no Cancel)', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(await screen.findByRole('button', { name: /Join with a link/ }));
    const dialog = screen.getByRole('dialog', { name: 'Join a server' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Invite link' }), { target: { value: 'mvs://join/removed-here' } });
    await act(async () => {
      fireEvent.submit(within(dialog).getByRole('textbox', { name: 'Invite link' }).closest('form')!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(
      await within(dialog).findByText("This account was removed from the server, so it can't join. You can contact the owner."),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Join' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(dialog.querySelector('.actions .primary')?.textContent).toBe('Close');
    await act(async () => {
      // The action row's Close (the dialog's ✕ is named Close too).
      fireEvent.click(dialog.querySelector<HTMLButtonElement>('.actions .primary')!);
    });
    expect(screen.queryByRole('dialog', { name: 'Join a server' })).toBeNull();
  });
});

describe('join statuses from the core', () => {
  it("keep only their phase's fields; an unknown phase becomes 'invalid'", async () => {
    const { cleanJoin } = await import('../core/sanitize');
    const link = 'mvs://join/abc';
    expect(cleanJoin({ phase: 'removed', link, extra: 1 } as never)).toEqual({ phase: 'removed', link: expect.any(String) });
    expect(cleanJoin({ phase: 'joined', link, serverId: 's1' } as never)).toMatchObject({ phase: 'joined', serverId: 's1' });
    expect(cleanJoin({ phase: 'age-blocked', link, required: '18+' } as never)).toMatchObject({ phase: 'age-blocked', required: '18+' });
    expect(cleanJoin({ phase: 'banned-forever', link } as never)).toEqual({ phase: 'invalid', link: expect.any(String) });
    expect(cleanJoin(null as never).phase).toBe('invalid');
  });
});

describe('join statuses through the app (the sanitizer between core and UI)', () => {
  const joinWith = async (status: unknown) => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    // A core that answers with this status (e.g. a newer core's phase).
    core.joinServer = async (link: string) => ({ ...(status as object), link }) as never;
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(await screen.findByRole('button', { name: /Join with a link/ }));
    const dialog = screen.getByRole('dialog', { name: 'Join a server' });
    const input = within(dialog).getByRole('textbox', { name: 'Invite link' });
    fireEvent.change(input, { target: { value: 'mvs://join/abc' } });
    await act(async () => {
      fireEvent.submit(input.closest('form')!);
    });
    return dialog;
  };

  it("an unknown phase shows the invalid text, never a dialog that waits", async () => {
    const dialog = await joinWith({ phase: 'banned-forever' });
    expect(await within(dialog).findByText(/That doesn't look like an invite link\./)).toBeTruthy();
  });

  it("'removed' reaches the dialog through the sanitizer", async () => {
    const dialog = await joinWith({ phase: 'removed', extra: 'dropped' });
    expect(await within(dialog).findByText(/This account was removed from the server/)).toBeTruthy();
  });
});
