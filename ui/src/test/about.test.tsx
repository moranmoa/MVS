// B24a (docs/ux/specs/B24-about.md §1, §8): Settings → About: "Copy version
// details" and "Report abuse or illegal content" with the build's address as
// text (no mailto), or the pending line when the build has none.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { cleanAbuseAddress } from '../app/abuseAddress';
import { MockCore, type MockOptions } from '../core/mock';
import { versionDetails } from '../screens/settings/AboutReport';

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function openAbout(options: MockOptions = {}) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false, ...options });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'About' }));
  return screen.findByRole('region', { name: 'Report abuse or illegal content' });
}

const clipboard = () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
};

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('B24a: About', () => {
  it('no address in the build: the pending line, and no Copy for it (§8.1)', async () => {
    const section = await openAbout();
    expect(within(section).getByText('The address appears in builds shipped to testers.')).toBeTruthy();
    expect(within(section).queryByRole('button')).toBeNull();
    expect(section.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('with an address (demo ?abuse=1): shown as text, LTR, with Copy; never a mailto link', async () => {
    const writeText = clipboard();
    const section = await openAbout({ abuseAddress: true });
    const address = within(section).getByText('abuse@example.org');
    expect(address.getAttribute('dir')).toBe('ltr');
    expect(section.querySelector('a')).toBeNull();
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Copy: abuse@example.org' }));
    });
    expect(writeText).toHaveBeenCalledWith('abuse@example.org');
  });

  it('"Copy version details" copies MVS, the version and the platform', async () => {
    const writeText = clipboard();
    await openAbout();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy version details' }));
    });
    expect(writeText).toHaveBeenCalledWith(versionDetails('0.1.0-alpha'));
    expect(versionDetails('0.5.0', 'Win32')).toBe('MVS 0.5.0 (Win32)');
    expect(versionDetails('0.5.0', '')).toBe('MVS 0.5.0');
  });

  it('the address is checked again on the page: e-mail or https only', () => {
    expect(cleanAbuseAddress('abuse@example.org')).toBe('abuse@example.org');
    expect(cleanAbuseAddress('https://example.org/report')).toBe('https://example.org/report');
    expect(cleanAbuseAddress('javascript:alert(1)')).toBe('');
    expect(cleanAbuseAddress('http://example.org')).toBe('');
    expect(cleanAbuseAddress('a b@example.org')).toBe('');
    expect(cleanAbuseAddress(42)).toBe('');
  });
});
