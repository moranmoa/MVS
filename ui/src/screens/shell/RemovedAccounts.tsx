// G-53 (B11 "Removed accounts" page; rows per B11a–d §5א, ש-4): the owner's
// own page in server settings.
// A removed account can't rejoin with an invite until the owner undoes the
// removal here; it then may join again (it isn't made a member).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormattedDate, FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useCore, useCoreEvent, type Id, type RemovedMember, type ServerSummary } from '../../core';
import { Avatar, Code, Name } from '../../components/common';
import './removedAccounts.css';

/** At most this many rows until "Show all". */
export const REMOVED_PAGE = 20;
/** Removed accounts have no colour of their own any more: a neutral one (white text passes AA on it). */
const NEUTRAL = '#5f6672';

const nameOf = (r: RemovedMember) => r.displayName || r.shortCode;

export function RemovedAccounts({ server }: { server: ServerSummary }) {
  const core = useCore();
  const store = useAppStore();
  const intl = useIntl();
  const [list, setList] = useState<RemovedMember[] | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<Id>>(new Set());
  const [failed, setFailed] = useState<Id | null>(null);
  const inFlight = useRef(new Set<Id>());
  const rows = useRef<HTMLUListElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const focusAt = useRef<number | null>(null);

  const load = () =>
    core.listRemovedMembers(server.id).then(
      (l) => setList(l),
      // Not the owner (or the core can't say): the section isn't shown.
      () => setList([]),
    );
  useEffect(() => {
    setList(null);
    setAll(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  useCoreEvent(
    'server.updated',
    (s) => {
      if (s.id === server.id) void load();
    },
    [server.id],
  );
  // A kick comes as members.changed (the core sends no server.updated for it).
  useCoreEvent(
    'members.changed',
    (e) => {
      if (e.serverId === server.id) void load();
    },
    [server.id],
  );

  const sorted = useMemo(() => [...(list ?? [])].sort((a, b) => b.removedAt - a.removedAt), [list]);
  const shown = all ? sorted : sorted.slice(0, REMOVED_PAGE);

  // After an undo: the next row's button, or the page heading once none are left.
  const panelHeading = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const at = focusAt.current;
    if (at === null) return;
    focusAt.current = null;
    const buttons = rows.current?.querySelectorAll<HTMLButtonElement>('.removed-row .removed-undo') ?? [];
    (buttons[Math.min(at, buttons.length - 1)] ?? panelHeading.current)?.focus();
  }, [list]);

  const undo = async (r: RemovedMember, index: number) => {
    if (inFlight.current.has(r.id)) return;
    inFlight.current.add(r.id);
    setFailed(null);
    setBusy((b) => new Set(b).add(r.id));
    panelHeading.current = section.current?.closest('.settings-panel')?.querySelector<HTMLElement>('h3') ?? null;
    try {
      await core.undoKick(server.id, r.id);
      focusAt.current = index;
      setList((l) => (l ?? []).filter((x) => x.id !== r.id));
      store.showFlash('server.removed.undone');
    } catch {
      setFailed(r.id);
    } finally {
      inFlight.current.delete(r.id);
      setBusy((b) => {
        const next = new Set(b);
        next.delete(r.id);
        return next;
      });
    }
  };

  if (!list) return null;
  return (
    <div ref={section} className="stack-tight removed-accounts">
      {list.length === 0 && (
        <p className="muted">
          <FormattedMessage id="server.removed.empty" />
        </p>
      )}
      {list.length > 0 && (
        <ul className="removed-rows" ref={rows}>
          {shown.map((r, i) => (
            <li key={r.id} className="removed-row" aria-busy={busy.has(r.id) || undefined}>
              <Avatar name={nameOf(r)} color={NEUTRAL} size={32} />
              <span className="removed-who">
                <Name className="name removed-name">{nameOf(r)}</Name>
                <Code value={r.shortCode} />
              </span>
              {r.removedAt > 0 && (
                <span className="removed-when muted small">
                  <FormattedDate value={r.removedAt} dateStyle="medium" />
                </span>
              )}
              <button
                type="button"
                className="secondary small removed-undo"
                disabled={busy.has(r.id)}
                aria-label={intl.formatMessage({ id: 'server.removed.undoFor' }, { name: nameOf(r) })}
                onClick={() => void undo(r, i)}
              >
                {busy.has(r.id) && <span className="spinner" aria-hidden="true" />}
                <FormattedMessage id="server.removed.undo" />
              </button>
              {failed === r.id && (
                <p className="error small removed-error" role="alert">
                  <FormattedMessage id="error.generic" />{' '}
                  <button type="button" className="link" onClick={() => void undo(r, i)}>
                    <FormattedMessage id="common.retry" />
                  </button>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {!all && sorted.length > REMOVED_PAGE && (
        <button type="button" className="link" onClick={() => setAll(true)}>
          <FormattedMessage id="server.removed.showAll" values={{ count: sorted.length }} />
        </button>
      )}
    </div>
  );
}
