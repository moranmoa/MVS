// G-05: in the rail, a mention badge (a red count) apart from the new-messages pip.
// G-06: a tooltip with the full server name, on keyboard focus and on hover.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const rail = screen.getByRole('navigation', { name: 'Servers' });
  return { core, rail };
}
const serverButtons = (rail: HTMLElement) => within(rail).getAllByRole('button').filter((b) => b.hasAttribute('data-server-id'));
const tip = () => document.querySelector('.rail-tip');

describe('server rail (G-05, G-06)', () => {
  it('G-05: a server with mentions has the red count and the pip; unread alone has only the pip', async () => {
    const { rail } = await setup();
    const buttons = serverButtons(rail);
    const mentioned = buttons.find((b) => /\d+ mentions?/.test(b.getAttribute('aria-label') ?? ''));
    expect(mentioned).toBeTruthy();
    const item = mentioned!.closest('.rail-item')!;
    expect(item.querySelector('.rail-badge')?.textContent).toMatch(/^\d+$/);
    expect(item.querySelector('.rail-badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(item.classList.contains('unread')).toBe(true);
    for (const b of buttons) {
      const l = b.getAttribute('aria-label') ?? '';
      if (l.includes('New messages') && !/mentions?/.test(l)) {
        const it = b.closest('.rail-item')!;
        expect(it.classList.contains('unread')).toBe(true);
        expect(it.querySelector('.rail-badge')).toBeNull();
      }
    }
  });

  it('G-06: keyboard focus shows the full name beside the button (visual only); Esc and blur hide it', async () => {
    const { core, rail } = await setup();
    // 48 characters, the longest a server name can be.
    const longName = 'A server with a very long name that goes on and!';
    const id = serverButtons(rail)[0].getAttribute('data-server-id')!;
    await act(async () => {
      await core.renameServer(id, longName);
    });
    const button = await waitFor(() => {
      const b = serverButtons(rail).find((x) => x.getAttribute('data-server-id') === id)!;
      expect(b.getAttribute('aria-label')).toContain(longName);
      return b;
    });
    // No native title next to the custom tooltip.
    expect(button.hasAttribute('title')).toBe(false);
    act(() => {
      fireEvent.focus(button);
    });
    expect(tip()?.textContent).toBe(longName);
    expect(tip()?.getAttribute('aria-hidden')).toBe('true');
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(tip()).toBeNull();
    act(() => {
      fireEvent.focus(button);
    });
    expect(tip()).not.toBeNull();
    act(() => {
      fireEvent.blur(button);
    });
    expect(tip()).toBeNull();
  });

  it('G-06: hover shows it after a moment; leaving hides it; Home has one too', async () => {
    const { rail } = await setup();
    const button = serverButtons(rail)[0];
    const name = button.getAttribute('aria-label')!.split(',')[0];
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(tip()).toBeNull();
    await waitFor(() => expect(tip()?.textContent).toBe(name));
    fireEvent.pointerLeave(button);
    expect(tip()).toBeNull();
    act(() => {
      fireEvent.focus(within(rail).getByRole('button', { name: 'Home' }));
    });
    expect(tip()?.textContent).toBe('Home');
  });
});
