// G-23 (B16, UX-12): a date divider between days in the message list.

import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import en from '../i18n/en.json';
import he from '../i18n/he.json';
import { DateDivider, dayKey } from '../screens/shell/MessageList';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const label = (at: number, locale = 'en') => {
  const { container, unmount } = render(
    <IntlProvider locale={locale} messages={locale === 'he' ? he : en}>
      <DateDivider at={at} />
    </IntlProvider>,
  );
  const el = container.querySelector('.date-divider')!;
  const out = { text: el.textContent, aria: el.getAttribute('aria-label'), role: el.getAttribute('role') };
  unmount();
  return out;
};

describe('date divider (G-23)', () => {
  const now = new Date();
  const at = (daysAgo: number, hour = 12) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour).getTime();

  it('says Today, Yesterday, then the date; the year only when it is not this year', () => {
    expect(label(at(0))).toEqual({ text: 'Today', aria: 'Today', role: 'separator' });
    expect(label(at(1)).text).toBe('Yesterday');
    expect(label(at(1), 'he').text).toBe('אתמול');
    const older = at(5);
    const expected = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', ...(new Date(older).getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(older);
    expect(label(older).text).toBe(expected);
    const lastYear = new Date(now.getFullYear() - 1, 2, 12, 12).getTime();
    expect(label(lastYear).text).toBe(`March 12, ${now.getFullYear() - 1}`);
    expect(label(new Date(now.getFullYear() - 1, 2, 12, 12).getTime(), 'he').text).toContain(String(now.getFullYear() - 1));
  });

  it('dayKey compares local calendar days', () => {
    expect(dayKey(at(0, 0))).toBe(dayKey(at(0, 23)));
    expect(dayKey(at(0, 0))).not.toBe(dayKey(at(1, 23)));
  });

  it('the list puts a divider before the first message of each day, and never groups across days', async () => {
    const settings: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
    // A day between messages: every message starts a new day.
    const core = new MockCore({ demo: true, speed: 0, simulateActivity: false, messageGapMs: 24 * 3_600_000 });
    render(<App core={core} initialSettings={settings} />);
    await screen.findByRole('textbox', { name: /^Message / });
    const rows = await screen.findAllByRole('article');
    const shown = rows.filter((r) => r.querySelector('.msg:not(.skeleton)'));
    expect(shown.length).toBeGreaterThan(0);
    for (const row of shown) {
      expect(row.querySelector('.date-divider')).not.toBeNull();
      expect(row.querySelector('.msg.grouped')).toBeNull();
    }
    // UX: with the day on the divider, a message head shows only the time, and the full date in its tooltip.
    const stamp = shown[0].querySelector('.msg-head time')!;
    expect(stamp.textContent).toMatch(/^[0-9]{1,2}:[0-9]{2}(\s?[AP]M)?$/);
    expect(stamp.getAttribute('title')).toMatch(/[0-9]{4}/);
  });
});
