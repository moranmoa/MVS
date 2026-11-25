// G-48 follow-ups: how many reports wait for me in each server I own (the
// staff badge), and a desktop notification when one arrives. A report's
// notification says only that a report arrived and in which server: never
// its reason or content (PO decision 1, notification-preview-off).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useSettings } from '../../app/settings';
import { defaultNotifyPrefs, shellNotify } from '../../app/notify';
import { useCore, useCoreEvent, type Id } from '../../core';

/** Fired (on window) when my own triage changes a count: a report dismissed. */
export const REPORTS_CHANGED = 'mvs:reports-changed';
export const notifyReportsChanged = () => window.dispatchEvent(new Event(REPORTS_CHANGED));

/** G-48: open (not dismissed) reports per server, for the servers I own. Empty elsewhere. */
export function useOpenReports(): Readonly<Record<Id, number>> {
  const core = useCore();
  const store = useAppStore();
  const myId = useStore(store, (s) => s.identity?.id);
  const owned = useStore(store, (s) =>
    s.servers
      .filter((x) => x.ownerId === myId && !x.closed)
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
        () => live.current && setCounts((c) => ({ ...c, [serverId]: 0 })),
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

/**
 * G-48: a desktop notification when a report reaches me, if desktop
 * notifications are on. Title "New report", body the server's name only.
 * A click opens that server (its first channel), like a message's.
 */
export function useReportNotifications() {
  const store = useAppStore();
  const intl = useIntl();
  const prefs = useSettings().settings.notify ?? defaultNotifyPrefs();
  const now = useRef({ intl, prefs });
  now.current = { intl, prefs };
  useCoreEvent('report.received', (e) => {
    const notify = shellNotify();
    if (!notify || !e.report || !now.current.prefs.desktop) return;
    const s = store.getState();
    const server = s.servers.find((x) => x.id === e.serverId);
    const channel = s.channels[e.serverId]?.[0];
    if (!server || !channel) return;
    const { intl } = now.current;
    void notify({
      title: intl.formatMessage({ id: 'reports.notify.title' }),
      body: intl.formatMessage({ id: 'reports.notify.body' }, { server: server.name }),
      channelId: channel.id,
    }).catch(() => {});
  });
}
