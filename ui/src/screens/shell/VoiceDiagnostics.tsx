// G-81: connection diagnostics, at the end of the call's voice settings.
// For QA and support: does STUN answer, which path did each connection take,
// how long did it take. It shows only what the engine's diagnostics() holds:
// fixed-set words and numbers, never an address, port or host name.

import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { Id } from '../../core/types';
import type { PeerDiagnostics, VoiceDiagnostics as Diagnostics } from '../../voice/engine';
import '../../styles/voice-diag.css';

/** How often the open panel refreshes. */
export const DIAG_REFRESH_MS = 1000;

function ms(intl: ReturnType<typeof useIntl>, value: number | null): string {
  return value === null ? '—' : intl.formatMessage({ id: 'diag.ms' }, { n: Math.round(value / 100) * 100 }) // SL Q2: to 100 ms;
}

function Gathered({ g }: { g: PeerDiagnostics['gathered'] }) {
  if (!g) return <>—</>;
  const parts = (['host', 'srflx', 'relay'] as const).filter((t) => g[t] > 0).map((t) => `${t} ${g[t]}`);
  return <>{parts.length ? parts.join(' · ') : '0'}</>;
}

function Body({ read, names }: { read: () => Promise<Diagnostics | null>; names: Record<Id, string> }) {
  const intl = useIntl();
  const [d, setD] = useState<Diagnostics | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => void read().then((v) => live && setD(v), () => {});
    tick();
    const t = setInterval(tick, DIAG_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [read]);
  if (!d) return null;
  const stun = !d.stun ? 'diag.stunNone' : d.stunAnswered === null ? 'diag.stunPending' : d.stunAnswered ? 'diag.stunOk' : 'diag.stunNoAnswer';
  const ids = Object.keys(d.peers);
  return (
    <>
      <p className={`diag-stun ${d.stun && d.stunAnswered === false ? 'error' : ''}`}>
        <FormattedMessage id={stun} values={{ s: d.gatherWindowS }} />
      </p>
      {ids.length === 0 ? (
        <p className="hint">
          <FormattedMessage id="diag.nobody" />
        </p>
      ) : (
        <table className="diag-table">
          <thead>
            <tr>
              <th scope="col">
                <FormattedMessage id="diag.person" />
              </th>
              <th scope="col">
                <FormattedMessage id="diag.state" />
              </th>
              <th scope="col">
                <FormattedMessage id="diag.path" />
              </th>
              <th scope="col">
                <FormattedMessage id="diag.candidates" />
              </th>
              <th scope="col">
                <FormattedMessage id="diag.setup" />
              </th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const p = d.peers[id]!;
              return (
                <tr key={id}>
                  <th scope="row">
                    <bdi>{names[id] ?? '…'}</bdi>
                  </th>
                  <td>
                    <bdi dir="ltr">{`${p.state} / ${p.ice}`}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{p.pair ? `${p.pair.local} → ${p.pair.remote}` : '—'}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">
                      <Gathered g={p.gathered} />
                    </bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{ms(intl, p.setupMs)}</bdi>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Collapsed by default; it reads (once a second) only while open. */
export function VoiceDiagnostics({ read, names }: { read: () => Promise<Diagnostics | null>; names: Record<Id, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="voice-diag" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <FormattedMessage id="diag.title" />
      </summary>
      {open && <Body read={read} names={names} />}
    </details>
  );
}
