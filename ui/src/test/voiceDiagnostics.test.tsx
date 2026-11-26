// G-81: the connection diagnostics panel in the call's voice settings.

import { act, fireEvent, render } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import he from '../i18n/he.json';
import { DIAG_REFRESH_MS, VoiceDiagnostics } from '../screens/shell/VoiceDiagnostics';
import type { VoiceDiagnostics as Diagnostics } from '../voice/engine';

const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const diag = (over: Partial<Diagnostics> = {}): Diagnostics => ({
  stun: true,
  playout: 'loopback',
  stunAnswered: true,
  gatherWindowS: 3,
  peers: {
    [B]: { state: 'connected', ice: 'connected', gathered: { host: 1, srflx: 1, prflx: 0, relay: 0 }, pair: { local: 'srflx', remote: 'srflx' }, gatherMs: 412.4, setupMs: 1834.6, route: 'lan-webrtc' },
    [C]: { state: 'connecting', ice: 'checking', gathered: null, pair: null, gatherMs: null, setupMs: null, route: 'circuit' },
  },
  ...over,
});

async function open(read: () => Promise<Diagnostics | null>, locale: 'en' | 'he' = 'en') {
  const r = render(
    <IntlProvider locale={locale} messages={locale === 'he' ? he : en}>
      <VoiceDiagnostics read={read} names={{ [B]: 'Dana', [C]: 'Omer' }} />
    </IntlProvider>,
  );
  const details = r.container.querySelector('details')!;
  details.open = true;
  await act(async () => {
    fireEvent(details, new Event('toggle'));
  });
  return r.container;
}

afterEach(() => vi.useRealTimers());

describe('voice diagnostics panel (G-81)', () => {
  it('collapsed, it reads nothing', () => {
    const read = vi.fn(async () => diag());
    render(
      <IntlProvider locale="en" messages={en}>
        <VoiceDiagnostics read={read} names={{}} />
      </IntlProvider>,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('open: STUN status and one row per person with state, path, my candidates and setup time', async () => {
    const c = await open(async () => diag());
    expect(c.querySelector('.diag-stun')!.textContent).toBe('STUN server: answered (public address found).');
    const rows = [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((x) => x.textContent));
    expect(rows).toEqual([
      ['Dana', 'connected / connected', 'lan-webrtc', 'srflx → srflx', 'host 1 · srflx 1', '1800 ms'],
      ['Omer', 'connecting / checking', 'circuit', '—', '—', '—'],
    ]);
  });

  it('says when STUN did not answer, and when there is none', async () => {
    let c = await open(async () => diag({ stunAnswered: false }), 'he');
    expect(c.querySelector('.diag-stun.error')!.textContent).toBe('שרת STUN: לא ענה תוך \u20683\u2069 שניות. ייתכן ש-UDP אליו חסום, או שהשרת איטי או לא פעיל.');
    c = await open(async () => diag({ stun: false, stunAnswered: null }));
    expect(c.querySelector('.diag-stun')!.textContent).toContain('same network only');
  });

  it('refreshes once a second while open', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => diag());
    await open(read);
    const n = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIAG_REFRESH_MS * 3);
    });
    expect(read.mock.calls.length).toBe(n + 3);
  });

  it('never shows an address: the page text has only names, fixed words and numbers', async () => {
    const c = await open(async () => diag());
    expect(c.textContent).not.toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{1,4}:|\.local\b|example/i);
  });
});
