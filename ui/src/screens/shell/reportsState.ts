// G-48 follow-ups: how many reports wait for me in each server I own (the
// staff badge), and a desktop notification when one arrives. A report's
// notification says only that a report arrived and in which server: never
// its reason or content (PO decision 1, notification-preview-off).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useSettings } from '../../app/settings';
import { defaultNotifyPrefs, reportsOn, shellNotify } from '../../app/notify';
import { useCore, useCoreEvent, type Id } from '../../core';

/** Fired (on window) when my own triage changes a count: a report dismissed. */
export const REPORTS_CHANGED = 'mvs:reports-changed';
export const notifyReportsChanged = () => window.dispatchEvent(new Event(REPORTS_CHANGED));

/** G-48 (TL on #531): "open Reports for this server", from a menu or a notification; Shell shows them. */
export const OPEN_REPORTS = 'mvs:open-reports';
export const openReports = (serverId: Id) => window.dispatchEvent(new CustomEvent(OPEN_REPORTS, { detail: serverId }));

/**
 * G-48: open (not dismissed) reports per server, for every server where I'm
 * staff (owner or admin). The UI doesn't know admins: staff are those the
 * core lets list reports (listReports is not-allowed for anyone else), so a
 * server is in the result exactly when I'm staff there, with 0 when none wait.
 */
export function useOpenReports(): Readonly<Record<Id, number>> {
  const core = useCore();
  const store = useAppStore();
  const owned = useStore(store, (s) =>
    s.servers
      .filter((x) => !x.closed)
      .map((x) => x.id)
      .join(','),
  );
  const [counts, setCounts] = useState<Record<Id, number>>({});
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const load = useCallback(
    (serverId: Id) =>
      core.listReports(serverId).then(
        (l) => live.current && setCounts((c) => ({ ...c, [serverId]: l.filter((r) => !r.dismissed).length })),
        // Not staff there (or the core can't say): not in the result.
        () =>
          live.current &&
          setCounts((c) => {
            if (!(serverId in c)) return c;
            const next = { ...c };
            delete next[serverId];
            return next;
          }),
      ),
    [core],
  );
  useEffect(() => {
    const ids = owned ? owned.split(',') : [];
    setCounts((c) => Object.fromEntries(Object.entries(c).filter(([id]) => ids.includes(id))));
    for (const id of ids) void load(id);
    const again = () => ids.forEach((id) => void load(id));
    window.addEventListener(REPORTS_CHANGED, again);
    return () => window.removeEventListener(REPORTS_CHANGED, again);
  }, [owned, load]);
  useCoreEvent(
    'report.received',
    (e) => {
      if (e.report && owned.split(',').includes(e.serverId)) void load(e.serverId);
    },
    [owned, load],
  );
  return counts;
}

/** G-48 (PO): at most one report notification per server this often; more are grouped into one. */
export const REPORT_NOTIFY_GAP_MS = 60_000;
/** A report that arrives before its server's channels are loaded waits for them, this often, this many times. */
const CHANNEL_WAIT_MS = 250;
const CHANNEL_WAIT_TRIES = 40;

/**
 * G-48 (PO decision on #567): a desktop notification when a report reaches
 * me as staff. It comes through a mute and the level "none" (it is addressed
 * to staff, like an @mention); it follows the main desktop switch, the OS's
 * own do-not-disturb (the shell's notification), and the server's "Report
 * notifications" switch. Text-free: the server's name only, never the reason,
 * the note or the content. At most one a minute per server, then grouped.
 * A click opens that server (its first channel), like a message's.
 */
export function useReportNotifications() {
  const store = useAppStore();
  const intl = useIntl();
  const prefs = useSettings().settings.notify ?? defaultNotifyPrefs();
  const now = useRef({ intl, prefs });
  now.current = { intl, prefs };
  const last = useRef(new Map<Id, number>());
  // Channels a report notification pointed at (its click opens Reports, not just the channel).
  const sentFor = useRef(new Map<Id, Id>());
  useCoreEvent('notify.click', ({ channelId, messageId }) => {
    const serverId = messageId === null ? sentFor.current.get(channelId) : undefined;
    if (serverId) openReports(serverId);
  });
  const waiting = useRef(new Map<Id, { count: number; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => () => waiting.current.forEach((w) => clearTimeout(w.timer)), []);

  const send = (serverId: Id, count: number, tries = 0) => {
    const notify = shellNotify();
    const s = store.getState();
    const server = s.servers.find((x) => x.id === serverId);
    const channel = s.channels[serverId]?.[0];
    const { intl, prefs } = now.current;
    if (!notify || !prefs.desktop || !reportsOn(prefs, serverId)) return;
    // Right after start-up the server's channels may not be loaded yet (the
    // click opens its first channel): wait a little rather than drop it.
    if (!server || !channel) {
      if (tries < CHANNEL_WAIT_TRIES) setTimeout(() => send(serverId, count, tries + 1), CHANNEL_WAIT_MS);
      return;
    }
    last.current.set(serverId, Date.now());
    sentFor.current.set(channel.id, serverId);
    void notify({
      title: server.name,
      body: intl.formatMessage({ id: 'reports.notify.body' }, { server: server.name, count }),
      channelId: channel.id,
    }).catch(() => {});
  };

  useCoreEvent('report.received', (e) => {
    const { prefs } = now.current;
    if (!e.report || !prefs.desktop || !reportsOn(prefs, e.serverId)) return;
    const pending = waiting.current.get(e.serverId);
    if (pending) {
      pending.count += 1;
      return;
    }
    const since = Date.now() - (last.current.get(e.serverId) ?? -Infinity);
    if (since >= REPORT_NOTIFY_GAP_MS) return send(e.serverId, 1);
    const w = {
      count: 1,
      timer: setTimeout(() => {
        waiting.current.delete(e.serverId);
        send(e.serverId, w.count);
      }, REPORT_NOTIFY_GAP_MS - since),
    };
    waiting.current.set(e.serverId, w);
  });
}
