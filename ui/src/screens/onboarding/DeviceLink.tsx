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
} as const;

export function DeviceLinkScreen({ onLinked, onCancel }: { onLinked: () => void; onCancel: () => void }) {
  const core = useCore();
  const intl = useIntl();
  const [offer, setOffer] = useState<DeviceLinkOffer | null>(null);
  const [state, setState] = useState<DeviceLinkState>({ state: 'waiting' });
  const [startFailed, setStartFailed] = useState(false);
  const live = useRef(true);

  const start = async () => {
    setStartFailed(false);
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
              <p className="device-link-code" dir="ltr">
                <bdi>{groupCode(offer.code)}</bdi>
              </p>
            </div>
          ) : (
            <span className="spinner" role="status" aria-label={intl.formatMessage({ id: 'deviceLink.preparing' })} />
          )}
          <p className="muted small" role="status">
            <FormattedMessage id="deviceLink.waiting" />
          </p>
        </>
      )}
      {state.state === 'confirm' && state.sas && (
        <>
          <p>
            <FormattedMessage id="deviceLink.confirmHint" />
          </p>
          <p className="device-link-sas" dir="ltr" aria-label={intl.formatMessage({ id: 'deviceLink.sasLabel' }, { sas: state.sas.split('').join(' ') })}>
            {groupSas(state.sas)}
          </p>
          <p className="muted small" role="status">
            <FormattedMessage id="deviceLink.confirmWaiting" />
          </p>
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
