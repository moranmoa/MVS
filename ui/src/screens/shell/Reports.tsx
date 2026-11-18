// G-48 (core #515, PO decisions 1–4): server settings → "Reports", for the
// owner and admins. A report never carries the reported content: it is
// fetched only on an explicit "Show content", behind a warning for reasons 5
// (sexual) and 6 (minor), withheld from staff under 18, and for reason 6
// never copyable. Shown as plain text, never Markdown or HTML.

import { useEffect, useMemo, useState, type ClipboardEvent, type MouseEvent } from 'react';
import { FormattedMessage, FormattedRelativeTime, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useCore, useCoreEvent, type CoreError, type Member, type ReportEvidence, type ReportSummary, type ServerSummary } from '../../core';
import { SENSITIVE_REASONS } from '../../core/types';
import { Name } from '../../components/common';
import { displayName, ProfileCard } from './MemberList';
import { MinorHelpLine } from './ReportDialog';
import './report.css';

const NO_MEMBERS: Member[] = [];

type Evidence =
  | { state: 'ask' } // reasons 5 and 6: the warning first
  | { state: 'loading' }
  | { state: 'shown'; evidence: ReportEvidence }
  | { state: 'withheld' }
  | { state: 'invalid' }
  | { state: 'failed' };

export function ReportsPage({ server }: { server: ServerSummary }) {
  const core = useCore();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const load = () => core.listReports(server.id).then(setReports, () => setReports([]));
  useEffect(() => {
    setReports(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  useCoreEvent(
    'report.received',
    (e) => {
      if (e.serverId === server.id && e.report) void load();
    },
    [server.id],
  );

  if (!reports) return null;
  if (reports.length === 0) {
    return (
      <p className="muted">
        <FormattedMessage id="reports.empty" />
      </p>
    );
  }
  return (
    <ul className="report-list">
      {reports.map((r) => (
        <ReportItem key={r.id} report={r} server={server} onChanged={load} />
      ))}
    </ul>
  );
}

function ReportItem({ report: r, server, onChanged }: { report: ReportSummary; server: ServerSummary; onChanged: () => void }) {
  const core = useCore();
  const intl = useIntl();
  const store = useAppStore();
  const members = useStore(store, (s) => s.members[server.id] ?? NO_MEMBERS);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const nameOf = (id: string) => {
    const m = byId.get(id);
    return m ? displayName(m) : intl.formatMessage({ id: 'settings.blocked.unknown' });
  };
  const sensitive = SENSITIVE_REASONS.has(r.reason);
  const minor = r.reason === 'minor';
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [kick, setKick] = useState<Member | null>(null);
  const [deleted, setDeleted] = useState(false);

  const fetchEvidence = async () => {
    if (r.evidenceWithheld) return setEvidence({ state: 'withheld' });
    setEvidence({ state: 'loading' });
    try {
      setEvidence({ state: 'shown', evidence: await core.getReportEvidence(r.id) });
    } catch (e) {
      const code = (e as CoreError)?.code;
      setEvidence({ state: code === 'not-allowed' ? 'withheld' : code === 'bad-request' ? 'invalid' : 'failed' });
    }
  };
  const show = () => (sensitive && !r.evidenceWithheld ? setEvidence({ state: 'ask' }) : void fetchEvidence());
  // PO 3: reason 6 can't be copied, saved or forwarded from here.
  const noCopy = minor
    ? {
        onCopy: (e: ClipboardEvent) => e.preventDefault(),
        onCut: (e: ClipboardEvent) => e.preventDefault(),
        onContextMenu: (e: MouseEvent) => e.preventDefault(),
        onDragStart: (e: MouseEvent) => e.preventDefault(),
      }
    : {};

  const deleteMessage =
    r.target.kind === 'message' && !deleted ? (
      <button
        key="delete"
        type="button"
        className="danger small"
        onClick={async () => {
          if (r.target.kind !== 'message') return;
          try {
            await core.deleteMessage(r.target.messageId);
            setDeleted(true);
            store.showFlash('reports.deleted');
          } catch {
            store.showFlash('error.generic');
          }
        }}
      >
        <FormattedMessage id="reports.deleteMessage" />
      </button>
    ) : null;
  const reportedMember = byId.get(r.reportedId);
  const kickButton =
    reportedMember && !reportedMember.isOwner ? (
      <button key="kick" type="button" className="danger small" onClick={() => setKick(reportedMember)}>
        <FormattedMessage id="profile.kick" />
      </button>
    ) : null;
  // PO 4: for reason 6, deleting the message is offered first.
  const actions = minor ? [deleteMessage, kickButton] : [kickButton, deleteMessage];

  return (
    <li className={`report-item${r.dismissed ? ' dismissed' : ''}`}>
      <div className="report-head">
        <strong>
          <FormattedMessage id={`report.reason.${r.reason}`} />
        </strong>
        <span className="muted small">
          <FormattedMessage id={r.target.kind === 'message' ? 'reports.kind.message' : 'reports.kind.member'} />
          {' · '}
          <FormattedRelativeTime value={Math.round((r.receivedAt - Date.now()) / 60_000)} unit="minute" updateIntervalInSeconds={60} />
        </span>
        {r.dismissed && (
          <span className="report-tag">
            <FormattedMessage id="reports.dismissed" />
          </span>
        )}
      </div>
      <p className="report-who small">
        <FormattedMessage id="reports.reported" values={{ name: <Name>{nameOf(r.reportedId)}</Name> }} />
        {' · '}
        <FormattedMessage id="reports.by" values={{ name: <Name>{nameOf(r.reporterId)}</Name> }} />
      </p>
      {r.text && (
        <p className="report-note" dir="auto">
          {r.text}
        </p>
      )}
      {minor && <MinorHelpLine />}

      {r.target.kind === 'message' && !evidence && (
        <button type="button" className="secondary small" onClick={show}>
          <FormattedMessage id="reports.show" />
        </button>
      )}
      {evidence?.state === 'ask' && (
        <div className="confirm" role="alertdialog" aria-label={intl.formatMessage({ id: 'reports.sensitiveWarning' })}>
          <p>
            <FormattedMessage id="reports.sensitiveWarning" />
          </p>
          <div className="actions">
            <button type="button" className="secondary small" autoFocus onClick={() => void fetchEvidence()}>
              <FormattedMessage id="reports.showConfirm" />
            </button>
            <button type="button" className="link" onClick={() => setEvidence(null)}>
              <FormattedMessage id="common.cancel" />
            </button>
          </div>
        </div>
      )}
      {evidence?.state === 'withheld' && (
        <p className="muted small" role="status">
          <FormattedMessage id="reports.withheld" />
        </p>
      )}
      {evidence?.state === 'invalid' && (
        <p className="error small" role="status">
          <FormattedMessage id="reports.invalid" />
        </p>
      )}
      {evidence?.state === 'failed' && (
        <p className="error small" role="alert">
          <FormattedMessage id="error.generic" />
        </p>
      )}
      {evidence?.state === 'shown' &&
        (evidence.evidence.text === undefined ? (
          <p className="muted small" role="status">
            <FormattedMessage id="reports.noKey" />
          </p>
        ) : (
          // Plain text only: never Markdown with live links, never HTML.
          <blockquote className={`report-evidence${minor ? ' no-copy' : ''}`} dir="auto" {...noCopy}>
            {evidence.evidence.text}
          </blockquote>
        ))}

      <div className="actions report-actions">
        {actions}
        {!r.dismissed && (
          <button
            type="button"
            className="link"
            onClick={async () => {
              await core.dismissReport(r.id).catch(() => {});
              onChanged();
            }}
          >
            <FormattedMessage id="reports.dismiss" />
          </button>
        )}
      </div>
      {kick && <ProfileCard member={kick} server={server} isMe={false} startKick onClose={() => setKick(null)} />}
    </li>
  );
}
