// G-51 (docs/ux/specs/server-icon-description.md, #587): the server's icon and
// description: the sanitizer, the description rules, the editor on "כללי"
// (one save, only what changed, rate-limited icon, update-needed) and the rail.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanServer } from '../core/sanitize';
import type { ServerSummary } from '../core/types';
import { normalizeDescription } from '../screens/shell/ServerMeta';

// jsdom has no canvas to encode with: a picked file becomes a fixed small PNG.
vi.mock('../app/image', async (orig) => ({
  ...(await orig<typeof import('../app/image')>()),
  serverIconFrom: async () => ({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
}));

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const base = { id: 's', name: 'S', initials: 'S', color: '#123456', ageRestriction: 'none', ownerId: 'o', inviteLink: '', unread: false, mentions: 0 } as ServerSummary;

describe('G-51 data', () => {
  it('the sanitizer keeps only a PNG or WebP icon, and plain text up to 5 lines', () => {
    expect(cleanServer({ ...base, iconDataUrl: PNG }).iconDataUrl).toBe(PNG);
    expect(cleanServer({ ...base, iconDataUrl: 'data:image/jpeg;base64,AAAA' }).iconDataUrl).toBeUndefined();
    expect(cleanServer({ ...base, iconDataUrl: 'https://example.com/x.png' }).iconDataUrl).toBeUndefined();
    expect(cleanServer({ ...base, description: 'a\nb\nc\nd\ne\nf\ng' }).description).toBe('a\nb\nc\nd\ne');
    expect(cleanServer({ ...base, description: '   ' }).description).toBeUndefined();
  });

  it('normalizes the description as the core wants it', () => {
    expect(normalizeDescription('  \nGame night  \n\n\n\nThursdays\t\n\n')).toBe('Game night\n\nThursdays');
    expect(normalizeDescription('a\r\nb')).toBe('a\nb');
  });
});

/** The demo server I own, its General page open. Spies go on `core` before this. */
async function openGeneral(core: MockCore) {
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
  });
  return screen.findByRole('tabpanel');
}

describe('the G-51 editor', () => {
  it('saves only the description when only it changed, and the draft clears', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const desc = vi.spyOn(core, 'setServerDescription');
    const icon = vi.spyOn(core, 'setServerIcon');
    const panel = await openGeneral(core);
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Description' }), { target: { value: 'Game night  \n\n\nThursdays' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    });
    expect(desc).toHaveBeenCalledWith(expect.any(String), 'Game night\n\nThursdays');
    expect(icon).not.toHaveBeenCalled();
    expect(await within(panel).findByText('Changes saved')).toBeTruthy();
    expect((within(panel).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('above 5 lines: the lines hint replaces the counter, and Save is off', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    const panel = await openGeneral(core);
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Description' }), { target: { value: '1\n2\n3\n4\n5\n6' } });
    expect(within(panel).getByRole('alert').textContent).toBe('Up to 5 lines.');
    expect((within(panel).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a rate-limited icon says so under the icon, while the description still saves', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false, serverIconRateLimited: true });
    const desc = vi.spyOn(core, 'setServerDescription');
    const icon = vi.spyOn(core, 'setServerIcon');
    const [server] = await core.listServers();
    const panel = await openGeneral(core);
    const input = panel.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'icon.png', { type: 'image/png' })] } });
    });
    expect(within(panel).getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Description' }), { target: { value: 'Hello' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    });
    expect(desc).toHaveBeenCalledWith(server.id, 'Hello');
    expect(icon).toHaveBeenCalledWith(server.id, PNG);
    expect(within(panel).getByRole('alert').textContent).toBe('You can change the icon again in a few minutes.');
    expect(within(panel).queryByText('Changes saved')).toBeNull();
  });

  it('update-needed shows who is on an older version, and nothing is saved', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    core.setServerDescription = vi.fn(async () => {
      throw { code: 'update-needed' };
    });
    const panel = await openGeneral(core);
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Description' }), { target: { value: 'Hello' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(within(panel).getByText(/older version of MVS/)).toBeTruthy());
    expect(within(panel).queryByText('Changes saved')).toBeNull();
  });

  it('the rail shows a server icon once the core has one', async () => {
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
    render(<App core={core} initialSettings={en} />);
    await screen.findByRole('textbox', { name: /^Message / });
    await act(async () => {});
    const [server] = await core.listServers();
    await act(async () => {
      await core.setServerIcon(server.id, PNG);
    });
    const button = document.querySelector(`.rail button[data-server-id="${server.id}"]`)!;
    expect(button.querySelector('img.server-icon')?.getAttribute('src')).toBe(PNG);
  });
});
