// G-62: the unread count on the taskbar / dock icon (the desktop shell draws it).

import { useEffect } from 'react';
import type { Channel, Id } from '../core';
import { setUnreadCount } from '../core/ipc';
import { isMuted, type Mutes } from './mute';
import { defaultNotifyPrefs, levelFor, type NotifyPrefs } from './notify';
import { useSettings } from './settings';
import { useStore, type Store } from './store';

const MAX = 9999;

/**
 * Unread across my servers. Muted servers and channels, and those whose
 * notifications are "none", are left out (Security Lead on #430). The core gives
 * a mention count and an unread flag per channel, not a message count, so a
 * channel counts its mentions, or 1 when it's unread without any.
 */
export function unreadTotal(channels: Record<Id, Channel[]>, mutes: Mutes, prefs: NotifyPrefs = defaultNotifyPrefs(), now = Date.now()): number {
  let total = 0;
  for (const [serverId, list] of Object.entries(channels)) {
    for (const c of list) {
      if (isMuted(mutes, serverId, c.id, now) || levelFor(prefs, serverId, c.id) === 'none') continue;
      total += c.mentions > 0 ? c.mentions : c.unread ? 1 : 0;
    }
  }
  return Math.min(total, MAX);
}

/** Keeps the icon in step while signed in; clears it when the shell goes away (sign-out) or the switch is off. */
export function useUnreadBadge(store: Store): void {
  const prefs = useSettings().settings.notify ?? defaultNotifyPrefs();
  const count = useStore(store, (s) => unreadTotal(s.channels, s.mutes, prefs));
  const total = prefs.badge ? count : 0;
  useEffect(() => {
    void setUnreadCount(total);
  }, [total]);
  useEffect(() => () => void setUnreadCount(0), []);
}
