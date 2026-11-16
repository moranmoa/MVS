// Member relays, slice 1 (#368): the Settings → Privacy toggle, the reason
// line, "Back to default", the one-time disclosure, and the sanitizer.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore, type MockOptions } from '../core/mock';
import { cleanMemberRelay } from '../core/sanitize';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function setup(options: MockOptions = {}) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false, ...options });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  return { core };
}
async function openPrivacy() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Privacy' }));
  return (await screen.findByRole('switch', { name: 'Relay for your members' })) as HTMLInputElement;
}
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

describe('member relays, slice 1', () => {
  it('an owner: on by default; switching sets on/off, and "Back to default" sets auto', async () => {
    const { core } = await setup();
    const toggle = await openPrivacy();
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Back to default' })).toBeNull();
    expect(document.getElementById('member-relay-hint')?.textContent).toContain('because you run a server');
    await click(toggle);
    expect(toggle.checked).toBe(false);
    expect((await core.getMemberRelay()).setting).toBe('off');
    await click(screen.getByRole('button', { name: 'Back to default' }));
    expect((await core.getMemberRelay()).setting).toBe('auto');
    expect(toggle.checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Back to default' })).toBeNull();
  });

  it.each([
    ['minor', 'Off: available from age 18.'],
    ['metered', 'Off on a metered connection.'],
    ['global-off', 'Turned off for everyone for now.'],
  ] as const)('forced off (%s): the toggle is off and disabled, with the reason', async (reason, text) => {
    await setup({ memberRelayReason: reason });
    const toggle = await openPrivacy();
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-describedby')).toContain('member-relay-reason');
    expect(document.getElementById('member-relay-reason')?.textContent).toBe(text);
  });

  it('relay-only forces it off with its reason; turning relay-only off brings it back', async () => {
    await setup();
    const toggle = await openPrivacy();
    await click(screen.getByRole('switch', { name: 'Relay only' }));
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(toggle.checked).toBe(false);
    expect(document.getElementById('member-relay-reason')?.textContent).toContain('Off while "Relay only" is on.');
    await click(screen.getByRole('switch', { name: 'Relay only' }));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(true);
  });

  it('the disclosure shows once at start when on and not seen; OK marks it seen', async () => {
    const { core } = await setup({ memberRelayUnseen: true });
    const dialog = await screen.findByRole('dialog', { name: 'Relay for your members is on' });
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('This uses up to');
    expect(document.activeElement?.textContent).toBe('OK');
    await click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog', { name: 'Relay for your members is on' })).toBeNull();
    const relay = await core.getMemberRelay();
    expect(relay).toMatchObject({ disclosureSeen: true, setting: 'auto', effective: true });
  });

  it('"Turn off" in the disclosure sets off; it is also reachable from Settings', async () => {
    const { core } = await setup({ memberRelayUnseen: true });
    const dialog = await screen.findByRole('dialog', { name: 'Relay for your members is on' });
    await click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await core.getMemberRelay()).toMatchObject({ setting: 'off', effective: false, disclosureSeen: true });
    await openPrivacy();
    await click(screen.getByRole('button', { name: 'What this means' }));
    expect(screen.getAllByRole('dialog', { name: 'Relay for your members is on' })).toHaveLength(1);
  });

  it('no disclosure when it was seen, or when relaying is off', async () => {
    await setup({ memberRelayUnseen: true, memberRelayReason: 'minor' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('dialog', { name: 'Relay for your members is on' })).toBeNull();
  });

  it('cleanMemberRelay keeps a good value and drops anything else', () => {
    const ok = { setting: 'auto', effective: true, role: true, disclosureSeen: false };
    expect(cleanMemberRelay(ok)).toEqual(ok);
    expect(cleanMemberRelay({ ...ok, effective: false, reason: 'minor' })).toEqual({ ...ok, effective: false, reason: 'minor' });
    for (const bad of [
      null,
      'on',
      { ...ok, setting: 'always' },
      { ...ok, effective: 'yes' },
      { ...ok, role: 1 },
      { ...ok, disclosureSeen: undefined },
      { ...ok, reason: 'because' },
      { ...ok, reason: 'minor' }, // a reason while on
      { ...ok, extra: 1 },
    ]) {
      expect(cleanMemberRelay(bad)).toBeNull();
    }
  });
});
