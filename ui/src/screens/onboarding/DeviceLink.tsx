// Device link, the new device (device-link-slice.md): "Sign in with another
// device" shows a QR and a typed code; the other device dials in, both show
// the same 6 digits, and once it's approved there, this device is signed in.

import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { QrCode } from '../../components/QrCode';
import { useCore, useCoreEvent, type DeviceLinkOffer, type DeviceLinkState } from '../../core';

/** "K7QX2MZRF4" as "K7QX2 MZRF4"; the digits as "482 913". */
export const groupCode = (code: string) => `${code.slice(0, 5)} ${code.slice(5)}`;
export const groupSas = (sas: string) => `${sas.slice(0, 3)} ${sas.slice(3)}`;

const FAILED_TEXT = {
  cancelled: 'deviceLink.failed.cancelled',
  timeout: 'deviceLink.failed.timeout',
  refused: 'deviceLink.failed.refused',
  network: 'deviceLink.failed.network',
  keyring: 'deviceLink.failed.keyring',
  restore: 'deviceLink.failed.restore',
} as const;

/** "4:59", ticking each second until `until`; read out only at each whole minute. */
function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <p className="device-link-countdown muted small">
      <FormattedMessage id="deviceLink.expiresIn" values={{ time: <bdi dir="ltr">{time}</bdi> }} />
      <span className="visually-hidden" aria-live="polite">
        {left % 60 === 0 && left > 0 ? <FormattedMessage id="deviceLink.minutesLeft" values={{ count: left / 60 }} /> : null}
      </span>
    </p>
  );
}

export function DeviceLinkScreen({ onLinked, onCancel }: { onLinked: () => void; onCancel: () => void }) {
  const core = useCore();
  const intl = useIntl();
  const [offer, setOffer] = useState<DeviceLinkOffer | null>(null);
  const [state, setState] = useState<DeviceLinkState>({ state: 'waiting' });
  const [startFailed, setStartFailed] = useState(false);
  const live = useRef(true);

  const start = async () => {
    setStartFailed(false);
    setMatched(false);
    setOffer(null);
    setState({ state: 'waiting' });
    try {
      const o = await core.startDeviceLink();
      if (live.current) setOffer(o);
    } catch {
      if (live.current) setStartFailed(true);
    }
  };
  useEffect(() => {
    live.current = true;
    void start();
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useCoreEvent('deviceLink.state', (s) => {
    setState(s);
    if (s.state === 'done') onLinked();
  });
  const [matched, setMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const answer = async (match: boolean) => {
    setBusy(true);
    try {
      await core.confirmDeviceLink(match);
      if (match) setMatched(true);
    } catch {
      setState({ state: 'failed', reason: 'network' });
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    void core.cancelDeviceLink().catch(() => {});
    onCancel();
  };

  const ended = state.state === 'expired' || state.state === 'failed' || startFailed;
  return (
    <div className="stack device-link">
      <h1>
        <FormattedMessage id="deviceLink.title" />
      </h1>
      {state.state === 'waiting' && !startFailed && (
        <>
          <p className="muted">
            <FormattedMessage id="deviceLink.waitingHint" />
          </p>
          {offer ? (
            <div className="device-link-offer">
              <QrCode text={offer.qr} label={intl.formatMessage({ id: 'deviceLink.qrLabel' })} />
              <p className="device-link-code-label muted small">
                <FormattedMessage id="deviceLink.codeLabel" />
              </p>
              <p className="device-link-code">
                <bdi dir="ltr">{groupCode(offer.code)}</bdi>
              </p>
              <Countdown until={offer.expiresAt} />
            </div>
          ) : (
            <span className="spinner" role="status" aria-label={intl.formatMessage({ id: 'deviceLink.preparing' })} />
          )}
          <p className="muted small">
            <FormattedMessage id="deviceLink.waiting" />
          </p>
        </>
      )}
      {state.state === 'confirm' && state.sas && (
        <>
          <p>
            <FormattedMessage id="deviceLink.confirmHint" />
          </p>
          <p className="device-link-sas" aria-label={intl.formatMessage({ id: 'deviceLink.sasLabel' }, { sas: state.sas.split('').join(' ') })}>
            <bdi dir="ltr">{groupSas(state.sas)}</bdi>
          </p>
          {matched ? (
            <p className="muted small" role="status">
              <FormattedMessage id="deviceLink.confirmWaiting" />
            </p>
          ) : (
            <div className="actions">
              {/* Security Lead: confirmed here too before anything is applied; the safe answer has the focus. */}
              <button type="button" className="primary" disabled={busy} onClick={() => void answer(true)}>
                <FormattedMessage id="deviceLink.match" />
              </button>
              <button type="button" className="secondary" autoFocus disabled={busy} onClick={() => void answer(false)}>
                <FormattedMessage id="deviceLink.noMatch" />
              </button>
            </div>
          )}
        </>
      )}
      {state.state === 'done' && (
        <p role="status">
          <FormattedMessage id="deviceLink.done" />
        </p>
      )}
      {ended && (
        <p className="error" role="alert">
          <FormattedMessage
            id={startFailed ? 'deviceLink.failed.network' : state.state === 'expired' ? 'deviceLink.expired' : FAILED_TEXT[state.reason ?? 'network']}
          />
        </p>
      )}
      <div className="actions">
        {ended && (
          <button type="button" className="primary" onClick={() => void start()}>
            <FormattedMessage id="deviceLink.retry" />
          </button>
        )}
        {state.state !== 'done' && (
          <button type="button" className="secondary" onClick={cancel}>
            <FormattedMessage id="common.cancel" />
          </button>
        )}
      </div>
    </div>
  );
}
