// Device link, the signed-in device (device-link-slice.md): Settings →
// Devices → "Add a device". Type the code the new device shows (a camera scan
// is optional in v1), then compare the 6 digits and approve: the new device
// gets full access to the account.

import { useId, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isCoreError, useCore, type DeviceApproval } from '../../core';
import { groupSas } from '../onboarding/DeviceLink';

type Step = 'idle' | 'code' | 'compare' | 'added' | 'declined';

/** Upper case, without the spaces and dashes people type. */
const normalize = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');
const CODE = /^[A-Z2-7]{10}$/;

export function DevicesSection() {
  const core = useCore();
  const intl = useIntl();
  const [step, setStep] = useState<Step>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<DeviceApproval | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const warnId = useId();
  const fullId = useId();

  const begin = async () => {
    const value = normalize(code);
    if (!CODE.test(value) && !code.trim().startsWith('mvs-link:')) {
      setError('devices.error.format');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setApproval(await core.beginDeviceApproval(CODE.test(value) ? value : code.trim()));
      setStep('compare');
    } catch (e) {
      setError(isCoreError(e) && e.code === 'not-found' ? 'devices.error.notFound' : isCoreError(e) && e.code === 'rate-limited' ? 'devices.error.rateLimited' : isCoreError(e) && e.code === 'locked-out' ? 'devices.error.lockedOut' : 'devices.error.other');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  // Security Lead on #391: the account is sent only after this explicit choice; nothing calls it on its own.
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await core.confirmDeviceApproval(approve);
      setStep(approve ? 'added' : 'declined');
    } catch (e) {
      setError(isCoreError(e) && e.code === 'not-found' ? 'devices.error.notFound' : 'devices.error.other');
    } finally {
      setBusy(false);
      setApproval(null);
      setCode('');
    }
  };

  return (
    <div className="stack devices">
      <p className="muted small">
        <FormattedMessage id="devices.hint" />
      </p>
      {(step === 'idle' || step === 'added' || step === 'declined') && (
        <>
          {step === 'added' && (
            <p className="success" role="status">
              <FormattedMessage id="devices.added" />
            </p>
          )}
          {step === 'declined' && (
            <p className="muted" role="status">
              <FormattedMessage id="devices.declined" />
            </p>
          )}
          <div>
            <button type="button" className="secondary" onClick={() => setStep('code')}>
              <FormattedMessage id="devices.add" />
            </button>
          </div>
        </>
      )}
      {step === 'code' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void begin();
          }}
        >
          <label className="field">
            <span>
              <FormattedMessage id="devices.codeLabel" />
            </span>
            <input
              ref={inputRef}
              autoFocus
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="device-code-input"
              value={code}
              maxLength={200}
              placeholder="K7QX2 MZRF4"
              aria-invalid={!!error || undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <p className="muted small">
            <FormattedMessage id="devices.codeHint" />
          </p>
          {error && (
            <p id={errorId} className="error small" role="alert">
              <FormattedMessage id={error} />
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !code.trim()}>
              <FormattedMessage id="common.next" />
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setStep('idle');
                setError(null);
                setCode('');
              }}
            >
              <FormattedMessage id="common.cancel" />
            </button>
          </div>
        </form>
      )}
      {step === 'compare' && approval && (
        <div className="stack device-compare" role="group" aria-labelledby={warnId} aria-describedby={fullId}>
          <p id={warnId} className="device-warning">
            <FormattedMessage id="devices.compareQuestion" />
          </p>
          <p id={fullId} className="device-full-access" role="note">
            <FormattedMessage id="devices.fullAccess" />
          </p>
          <p className="device-link-sas" aria-label={intl.formatMessage({ id: 'deviceLink.sasLabel' }, { sas: approval.sas.split('').join(' ') })}>
            <bdi dir="ltr">{groupSas(approval.sas)}</bdi>
          </p>
          {error && (
            <p className="error small" role="alert">
              <FormattedMessage id={error} />
            </p>
          )}
          <div className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void decide(true)}>
              <FormattedMessage id="devices.approve" />
            </button>
            {/* UX: the safe answer has the focus. */}
            <button type="button" className="secondary" autoFocus disabled={busy} onClick={() => void decide(false)}>
              <FormattedMessage id="devices.decline" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
