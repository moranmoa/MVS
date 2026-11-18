import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useCore, useCoreEvent, type BlockedUser, type Id, type Member } from '../../core';
import { Avatar, Name } from '../../components/common';
import './blocked.css';

/** G-47: how long "Undo" stays after an unblock (paused while the pointer or focus is on it). */
export const UNDO_MS = 5000;
/** G-47 (TL): a person's button stays busy until the list shows the change, at most this long. */
export const GUARD_MS = 2000;
/** G-47 (TL): listBlocked is tried again after a transient error, after these waits. */
export const LIST_RETRY_MS = [1000, 2000, 4000, 8000, 16000];
/** An older core answers these for a command it doesn't have: no retry. */
const NO_SUCH_COMMAND = new Set(['bad-request', 'not-implemented']);

/** No colour is known for someone who shares no server with me: a neutral one (white text passes AA). */
const NEUTRAL = '#5f6672';

/** One row of the list. */
export interface BlockedRow {
  id: Id;
  /** '' when no name was ever known ("Unknown account"). */
  name: string;
  /** Known only while we share a server. */
  shortCode?: string;
  avatarDataUrl?: string;
  color: string;
}

/**
 * G-47: everyone I blocked, once each, sorted by name. The one data source:
 * the core's `listBlocked` (dev-identity #502), which includes people who
 * share no server with me, filled in with what my servers' member lists
 * know (picture, colour, short code). `core` is null on an older core: then
 * the list is gathered from the member lists alone.
 */
export function blockedRows(core: BlockedUser[] | null, members: Record<Id, Member[]>, myId: Id | undefined, locale: string): BlockedRow[] {
  const known = new Map<Id, Member>();
  for (const list of Object.values(members)) for (const m of list) if (!known.has(m.id)) known.set(m.id, m);
  const row = (id: Id, name: string | undefined): BlockedRow => {
    const m = known.get(id);
    return {
      id,
      name: m?.displayName || name || '',
      ...(m ? { shortCode: m.shortCode } : {}),
      ...(m?.avatarDataUrl ? { avatarDataUrl: m.avatarDataUrl } : {}),
      color: m ? (m.color ?? m.avatarColor) : NEUTRAL,
    };
  };
  const rows = new Map<Id, BlockedRow>();
  if (core) {
    for (const b of core) if (b.userId !== myId && !rows.has(b.userId)) rows.set(b.userId, row(b.userId, b.name));
  } else {
    for (const list of Object.values(members)) {
      for (const m of list) if (m.blocked && m.id !== myId && !rows.has(m.id)) rows.set(m.id, row(m.id, m.displayName));
    }
  }
  const collator = new Intl.Collator(locale);
  const key = (r: BlockedRow) => r.name || r.shortCode || '￿';
  return [...rows.values()].sort((a, b) => collator.compare(key(a), key(b)));
}

/** G-47: Settings → Privacy → "Blocked accounts", each with Unblock (and Undo for 5 s). */
export function BlockedList({ focus }: { focus?: number }) {
  const store = useAppStore();
  const core = useCore();
  const intl = useIntl();
  const members = useStore(store, (s) => s.members);
  const myId = useStore(store, (s) => s.identity?.id);
  // The core's list; null until read, or for good on a core without listBlocked.
  const [fromCore, setFromCore] = useState<BlockedUser[] | null>(null);
  const [coreHasList, setCoreHasList] = useState<boolean | null>(null);
  // Meanwhile (or for good on an older core) the member lists stand in.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) =>
      core.listBlocked().then(
        (l) => {
          if (!live) return;
          setFromCore(l);
          setCoreHasList(true);
        },
        (e: unknown) => {
          if (!live) return;
          setCoreHasList((had) => had ?? false);
          const code = (e as { code?: unknown } | null)?.code;
          const wait = LIST_RETRY_MS[attempt];
          if (typeof code === 'string' && NO_SUCH_COMMAND.has(code)) return;
          if (wait !== undefined) timer = setTimeout(() => void read(attempt + 1), wait);
        },
      );
    void read(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [core]);
  useCoreEvent('blocks.changed', ({ blocked }) => {
    setFromCore(blocked);
    setCoreHasList(true);
  });

  const list = useMemo(
    () => (coreHasList === null ? [] : blockedRows(coreHasList ? fromCore : null, members, myId, intl.locale)),
    [coreHasList, fromCore, members, myId, intl.locale],
  );
  const blockedNow = useRef(new Set<Id>());
  blockedNow.current = new Set(list.map((r) => r.id));

  // One call per person at a time, kept until the list shows the change (or 2 s):
  // with the old toggle a second click would flip it back.
  const [busy, setBusy] = useState<ReadonlySet<Id>>(new Set());
  const guard = useRef(new Map<Id, { want: boolean; timer?: ReturnType<typeof setTimeout> }>());
  const release = (id: Id) => {
    const g = guard.current.get(id);
    if (!g) return;
    clearTimeout(g.timer);
    guard.current.delete(id);
    setBusy((b) => {
      const next = new Set(b);
      next.delete(id);
      return next;
    });
  };
  useEffect(() => {
    for (const [id, g] of guard.current) if (g.timer && blockedNow.current.has(id) === g.want) release(id);
  });
  useEffect(() => () => guard.current.forEach((g) => clearTimeout(g.timer)), []);

  const [failed, setFailed] = useState(false);
  const [undo, setUndo] = useState<{ row: BlockedRow; name: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const undoHeld = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  // After an unblock, once that row is gone: the row at its index (the next one), or the heading.
  const focusAt = useRef<{ index: number; id: Id } | null>(null);

  useEffect(() => () => clearTimeout(undoTimer.current), []);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => heading.current?.focus());
    return () => clearTimeout(t);
  }, [focus]);
  useLayoutEffect(() => {
    const at = focusAt.current;
    if (at === null || list.some((r) => r.id === at.id)) return;
    focusAt.current = null;
    const buttons = rows.current?.querySelectorAll<HTMLButtonElement>('.blocked-row button') ?? [];
    (buttons[Math.min(at.index, buttons.length - 1)] ?? heading.current)?.focus();
  }, [list]);

  const nameOf = (r: BlockedRow) => r.name || intl.formatMessage({ id: 'settings.blocked.unknown' });
  const run = async (id: Id, wantBlocked: boolean) => {
    if (guard.current.has(id) || blockedNow.current.has(id) === wantBlocked) return false;
    guard.current.set(id, { want: wantBlocked });
    setFailed(false);
    setBusy((b) => new Set(b).add(id));
    try {
      // The core's setBlocked is idempotent; an older core has only the toggle.
      if (coreHasList) await core.setBlocked(id, wantBlocked);
      else await core.blockUser(id);
    } catch {
      setFailed(true);
      release(id);
      return false;
    }
    const g = guard.current.get(id);
    if (g) {
      if (blockedNow.current.has(id) === wantBlocked) release(id);
      else g.timer = setTimeout(() => release(id), GUARD_MS);
    }
    return true;
  };

  // WCAG 2.2.1: the Undo line stays while the pointer or focus is on it, then 5 s more.
  const startUndoTimer = () => {
    clearTimeout(undoTimer.current);
    if (!undoHeld.current) undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };
  const holdUndo = (held: boolean) => {
    undoHeld.current = held;
    if (held) clearTimeout(undoTimer.current);
    else startUndoTimer();
  };

  const unblock = async (r: BlockedRow, index: number) => {
    focusAt.current = { index, id: r.id };
    const name = nameOf(r);
    if (!(await run(r.id, false))) {
      focusAt.current = null;
      return;
    }
    undoHeld.current = false;
    setUndo({ row: r, name });
    startUndoTimer();
  };
  const reblock = async () => {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    undoHeld.current = false;
    setUndo(null);
    await run(undo.row.id, true);
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
          <div
            className="blocked-undo"
            onMouseEnter={() => holdUndo(true)}
            onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && holdUndo(false)}
            onFocus={() => holdUndo(true)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(':hover') && holdUndo(false)}
          >
            <span>
              <FormattedMessage id="settings.blocked.unblocked" values={{ name: <Name>{undo.name}</Name> }} />
            </span>
            <button type="button" className="link" onClick={() => void reblock()}>
              <FormattedMessage id="settings.blocked.undo" />
            </button>
          </div>
        )}
      </div>
      {coreHasList !== null && list.length === 0 ? (
        <p className="muted">
          <FormattedMessage id="settings.blocked.empty" />
        </p>
      ) : (
        <ul className="blocked-rows" ref={rows}>
          {list.map((r, i) => (
            <li key={r.id} className="blocked-row">
              <Avatar name={nameOf(r)} color={r.color} src={r.avatarDataUrl} size={32} />
              <span className="blocked-who">
                <Name>{nameOf(r)}</Name>
                {r.shortCode && (
                  <bdi dir="ltr" className="blocked-code">
                    {r.shortCode}
                  </bdi>
                )}
              </span>
              <button
                type="button"
                className="secondary small"
                disabled={busy.has(r.id)}
                aria-label={intl.formatMessage({ id: 'settings.blocked.unblockName' }, { name: nameOf(r) })}
                onClick={() => void unblock(r, i)}
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
