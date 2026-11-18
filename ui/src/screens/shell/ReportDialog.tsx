// G-48 (core #515, PO decisions): report a message or a member to the
// server's owner and admins. The report is signed: the dialog says plainly
// that staff will see who sent it.

import { useEffect, useId, useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useCore, type CoreError, type Id, type ReportReason, type ReportTargetInput } from '../../core';
import { REPORT_REASONS } from '../../core/types';
import { REPORT_TEXT_MAX } from '../../core/sanitize';
import { Dialog, Name } from '../../components/common';
import './report.css';

export interface ReportRequest {
  serverId: Id;
  target: ReportTargetInput;
  /** Who is reported (a message's author), for the title. */
  name: string;
}

/** G-48 (PO 3): the line for reason 6, to the reporter and to staff. */
export function MinorHelpLine() {
  return (
    <p className="report-minor-help" role="note">
      <FormattedMessage id="report.minorHelp" />
    </p>
  );
}

const ERRORS: Partial<Record<CoreError['code'], string>> = {
  'already-reported': 'report.error.already',
  'rate-limited': 'report.error.rate',
  'no-recipient': 'report.error.noRecipient',
};

export function ReportDialog({ request, onClose }: { request: ReportRequest | null; onClose: () => void }) {
  const core = useCore();
  const intl = useIntl();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const legend = useId();
  const noteId = useId();

  useEffect(() => {
    setReason(null);
    setText('');
    setState('idle');
    setError(null);
  }, [request]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!request || !reason || state !== 'idle') return;
    setState('sending');
    setError(null);
    const note = text.replace(/\s+/g, ' ').trim();
    try {
      await core.reportContent(request.serverId, request.target, reason, note || undefined);
      setState('sent');
    } catch (err) {
      setError(ERRORS[(err as CoreError)?.code] ?? 'error.generic');
      setState('idle');
    }
  };

  const title = intl.formatMessage({ id: request?.target.kind === 'member' ? 'report.titleMember' : 'report.titleMessage' });
  return (
    <Dialog open={!!request} onClose={onClose} title={title} className="report-dialog">
      {request && state === 'sent' ? (
        <div className="stack">
          <p className="success" role="status">
            <FormattedMessage id="report.sent" />
          </p>
          {reason === 'minor' && <MinorHelpLine />}
          <div className="actions">
            <button type="button" className="primary" autoFocus onClick={onClose}>
              <FormattedMessage id="common.close" />
            </button>
          </div>
        </div>
      ) : (
        request && (
          <form className="stack" onSubmit={submit}>
            <p className="muted">
              <FormattedMessage id="report.about" values={{ name: <Name>{request.name}</Name> }} />
            </p>
            <fieldset className="report-reasons" aria-labelledby={legend}>
              <legend id={legend}>
                <FormattedMessage id="report.reasonLegend" />
              </legend>
              {REPORT_REASONS.map((r) => (
                <label key={r} className="report-reason">
                  <input type="radio" name="report-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                  <span>
                    <FormattedMessage id={`report.reason.${r}`} />
                  </span>
                </label>
              ))}
            </fieldset>
            {reason === 'minor' && <MinorHelpLine />}
            <label className="field">
              <span>
                <FormattedMessage id="report.note" />
              </span>
              <input
                dir="auto"
                value={text}
                maxLength={REPORT_TEXT_MAX}
                onChange={(e) => setText(e.target.value)}
                aria-describedby={noteId}
              />
            </label>
            <p id={noteId} className="muted small">
              <FormattedMessage id="report.visible" />
            </p>
            {error && (
              <p className="error" role="alert">
                <FormattedMessage id={error} />
              </p>
            )}
            <div className="actions">
              <button type="submit" className="primary" disabled={!reason || state === 'sending'}>
                <FormattedMessage id="report.send" />
              </button>
              <button type="button" className="secondary" onClick={onClose}>
                <FormattedMessage id="common.cancel" />
              </button>
            </div>
          </form>
        )
      )}
    </Dialog>
  );
}
