import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useCore, type Id, type Member } from '../../core';
import { Avatar, Name } from '../../components/common';
import './blocked.css';

/** G-47: how long "Undo" stays after an unblock. */
export const UNDO_MS = 5000;

/**
 * G-47: everyone I blocked, once each. The core has no list of its own
 * (blocks show only as `Member.blocked`; `listBlocked` is proposed to the
 * TL), so this is gathered from the member lists of all my servers, which
 * are all loaded at start. Until then, someone I blocked who shares no
 * server with me any more is not listed. Sorted by name: the order they
 * were blocked in isn't known here.
 */
export function blockedUsers(members: Record<Id, Member[]>, myId: Id | undefined, locale: string): Member[] {
  const byId = new Map<Id, Member>();
  for (const list of Object.values(members)) {
    for (const m of list) if (m.blocked && m.id !== myId && !byId.has(m.id)) byId.set(m.id, m);
  }
  const collator = new Intl.Collator(locale);
  return [...byId.values()].sort((a, b) => collator.compare(a.displayName || a.shortCode, b.displayName || b.shortCode));
}

/** G-47: Settings → Privacy → "Blocked accounts", each with Unblock (and Undo for 5 s). */
export function BlockedList({ focus }: { focus?: number }) {
  const store = useAppStore();
  const core = useCore();
  const intl = useIntl();
  const members = useStore(store, (s) => s.members);
  const myId = useStore(store, (s) => s.identity?.id);
  const list = useMemo(() => blockedUsers(members, myId, intl.locale), [members, myId, intl.locale]);
  const blockedNow = useRef(new Set<Id>());
  blockedNow.current = new Set(list.map((m) => m.id));
  // blockUser toggles: one call per person at a time, and only while they
  // show as blocked (or, for Undo, as not blocked), so a double click can't flip it back.
  const [busy, setBusy] = useState<ReadonlySet<Id>>(new Set());
  const inFlight = useRef(new Set<Id>());
  const [failed, setFailed] = useState(false);
  const [undo, setUndo] = useState<{ member: Member; name: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  // After an unblock: the row at this index (the next one), or the heading.
  const focusAt = useRef<number | null>(null);

  useEffect(() => () => clearTimeout(undoTimer.current), []);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => heading.current?.focus());
    return () => clearTimeout(t);
  }, [focus]);
  useLayoutEffect(() => {
    const at = focusAt.current;
    if (at === null) return;
    focusAt.current = null;
    const buttons = rows.current?.querySelectorAll<HTMLButtonElement>('.blocked-row button') ?? [];
    (buttons[Math.min(at, buttons.length - 1)] ?? heading.current)?.focus();
  }, [list]);

  const nameOf = (m: Member) => m.displayName || intl.formatMessage({ id: 'settings.blocked.unknown' });
  const run = async (id: Id, wantBlocked: boolean) => {
    if (inFlight.current.has(id) || blockedNow.current.has(id) === wantBlocked) return false;
    inFlight.current.add(id);
    setFailed(false);
    setBusy((b) => new Set(b).add(id));
    try {
      await core.blockUser(id);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      inFlight.current.delete(id);
      setBusy((b) => {
        const next = new Set(b);
        next.delete(id);
        return next;
      });
    }
  };
  const unblock = async (m: Member, index: number) => {
    focusAt.current = index;
    if (!(await run(m.id, false))) {
      focusAt.current = null;
      return;
    }
    clearTimeout(undoTimer.current);
    setUndo({ member: m, name: nameOf(m) });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };
  const reblock = async () => {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    setUndo(null);
    await run(undo.member.id, true);
    heading.current?.focus();
  };

  return (
    <section className="stack-tight blocked-list" aria-labelledby="blocked-h">
      <h4 id="blocked-h" ref={heading} tabIndex={-1}>
        <FormattedMessage id="settings.blocked.title" />
      </h4>
      <p className="muted small">
        <FormattedMessage id="settings.blocked.hint" />
      </p>
      <div role="status" className="blocked-undo-slot">
        {undo && (
          <div className="blocked-undo">
            <span>
              <FormattedMessage id="settings.blocked.unblocked" values={{ name: <Name>{undo.name}</Name> }} />
            </span>
            <button type="button" className="link" onClick={() => void reblock()}>
              <FormattedMessage id="settings.blocked.undo" />
            </button>
          </div>
        )}
      </div>
      {list.length === 0 ? (
        <p className="muted">
          <FormattedMessage id="settings.blocked.empty" />
        </p>
      ) : (
        <ul className="blocked-rows" ref={rows}>
          {list.map((m, i) => (
            <li key={m.id} className="blocked-row">
              <Avatar name={nameOf(m)} color={m.color ?? m.avatarColor} src={m.avatarDataUrl} size={32} />
              <span className="blocked-who">
                <Name>{nameOf(m)}</Name>
                <bdi dir="ltr" className="blocked-code">
                  {m.shortCode}
                </bdi>
              </span>
              <button
                type="button"
                className="secondary small"
                disabled={busy.has(m.id)}
                aria-label={intl.formatMessage({ id: 'settings.blocked.unblockName' }, { name: nameOf(m) })}
                onClick={() => void unblock(m, i)}
              >
                <FormattedMessage id="profile.unblock" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p className="error small" role="alert">
          <FormattedMessage id="settings.blocked.failed" />
        </p>
      )}
    </section>
  );
}
