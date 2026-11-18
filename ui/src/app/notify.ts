// G-61 (docs/ux/GAPS.md §2.4): which new messages become a desktop
// notification. Everything here is local: levels and switches live in the
// settings on this computer, mutes in app/mute.ts (G-03 / G-17); nothing is
// sent anywhere.

import type { Id, Message } from '../core/types';

export type NotifyLevel = 'all' | 'mentions' | 'none';

/** A server's or a channel's choice. */
export interface NotifyScope {
  level?: NotifyLevel;
}

export interface NotifyPrefs {
  /** "Desktop notifications", the main switch. */
  desktop: boolean;
  /**
   * "Show message preview in notifications". Off by default (owner): the OS
   * keeps what it is shown (Windows: notification history, lock screen), so
   * the body is "New message in #channel" unless the person opts in.
   */
  preview: boolean;
  /** G-62: the unread count on the app icon (taskbar / dock). On by default. */
  badge: boolean;
  /** G-63: a short sound for a message that would notify. On by default. */
  sound: boolean;
  /** G-63: that sound during a call too. Off by default. */
  soundInCall: boolean;
  servers: Record<Id, NotifyScope>;
  /** A channel's level overrides its server's. */
  channels: Record<Id, NotifyScope>;
}

export const DEFAULT_LEVEL: NotifyLevel = 'mentions';
export const GROUP_MS = 10_000;
/** Older messages arriving now (catch-up after being offline) are not news. */
export const STALE_MS = 10 * 60_000;

export function defaultNotifyPrefs(): NotifyPrefs {
  return { desktop: true, preview: false, badge: true, sound: true, soundInCall: false, servers: {}, channels: {} };
}

const LEVELS: readonly NotifyLevel[] = ['all', 'mentions', 'none'];

function cleanScopes(v: unknown): Record<Id, NotifyScope> {
  const out: Record<Id, NotifyScope> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, s] of Object.entries(v as Record<string, unknown>).slice(0, 2000)) {
    if (!s || typeof s !== 'object' || k.length > 128) continue;
    const { level } = s as Record<string, unknown>;
    if (LEVELS.includes(level as NotifyLevel)) out[k] = { level: level as NotifyLevel };
  }
  return out;
}

/** Stored prefs checked field by field; anything odd falls back to the default. */
export function cleanNotifyPrefs(v: unknown): NotifyPrefs {
  const d = defaultNotifyPrefs();
  if (!v || typeof v !== 'object') return d;
  const p = v as Record<string, unknown>;
  return {
    desktop: typeof p.desktop === 'boolean' ? p.desktop : d.desktop,
    preview: typeof p.preview === 'boolean' ? p.preview : d.preview,
    badge: typeof p.badge === 'boolean' ? p.badge : d.badge,
    sound: typeof p.sound === 'boolean' ? p.sound : d.sound,
    soundInCall: typeof p.soundInCall === 'boolean' ? p.soundInCall : d.soundInCall,
    servers: cleanScopes(p.servers),
    channels: cleanScopes(p.channels),
  };
}

export function levelFor(prefs: NotifyPrefs, serverId: Id, channelId: Id): NotifyLevel {
  return prefs.channels[channelId]?.level ?? prefs.servers[serverId]?.level ?? DEFAULT_LEVEL;
}

/** Sets one server's or channel's level; null goes back to the default (a channel: its server's). */
export function withLevel(prefs: NotifyPrefs, kind: 'servers' | 'channels', id: Id, level: NotifyLevel | null): NotifyPrefs {
  const scopes = { ...prefs[kind] };
  if (level) scopes[id] = { level };
  else delete scopes[id];
  return { ...prefs, [kind]: scopes };
}

export interface NotifyContext {
  prefs: NotifyPrefs;
  serverId: Id;
  myId: Id | undefined;
  authorBlocked: boolean;
  /** The server or the channel is muted (app/mute.ts isMuted). */
  muted: boolean;
  /** The window has focus and shows this channel. */
  watching: boolean;
  now: number;
}

/** Whether `m` (just added) is worth a notification. */
export function shouldNotify(m: Message, c: NotifyContext): boolean {
  if (!c.prefs.desktop || c.watching || m.deleted || m.authorId === c.myId || c.authorBlocked) return false;
  if (c.now - m.createdAt > STALE_MS) return false;
  const level = levelFor(c.prefs, c.serverId, m.channelId);
  const mention = m.mentionsMe === true;
  // PO (#335): a mention of me still comes through a mute, unless the level is "Nothing".
  if (c.muted) return mention && level !== 'none';
  return level === 'all' || (level === 'mentions' && mention);
}

/** G-63: at most one message sound this often. */
export const SOUND_GAP_MS = 2000;

/**
 * G-63: whether `m` gets the new-message sound: the same messages that would
 * notify (not mine, not muted, not the channel I'm watching, by level), with
 * the sound's own switch instead of the desktop one; during a call only if
 * "also during a call" is on.
 */
export function shouldSound(m: Message, c: NotifyContext & { inCall: boolean }): boolean {
  if (!c.prefs.sound || (c.inCall && !c.prefs.soundInCall)) return false;
  return shouldNotify(m, { ...c, prefs: { ...c.prefs, desktop: true } });
}

/** G-63: lets a sound through at most once per `gapMs`. */
export function createSoundGate(gapMs = SOUND_GAP_MS): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}

/**
 * Groups a channel's notifications: the first message shows at once; more
 * within 10 s become one "N new messages in #channel" when the 10 s are up
 * (the shell replaces the channel's last notification with it).
 */
export function createGrouper<T>(
  show: (first: T) => void,
  showGroup: (last: T, count: number) => void,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
) {
  const open = new Map<Id, { count: number; last: T; timer: ReturnType<typeof setTimeout> }>();
  return {
    add(channelId: Id, item: T) {
      const g = open.get(channelId);
      if (g) {
        g.count++;
        g.last = item;
        return;
      }
      show(item);
      const timer = timers.set(() => {
        const done = open.get(channelId);
        open.delete(channelId);
        if (done && done.count > 1) showGroup(done.last, done.count);
      }, GROUP_MS);
      open.set(channelId, { count: 1, last: item, timer });
    },
    /** The channel was opened: whatever was waiting is seen. */
    drop(channelId: Id) {
      const g = open.get(channelId);
      if (g) timers.clear(g.timer);
      open.delete(channelId);
    },
    stop() {
      for (const g of open.values()) timers.clear(g.timer);
      open.clear();
    },
  };
}

export interface DesktopNotice {
  title: string;
  body: string;
  channelId: Id;
  messageId?: Id;
}

/** The shell's `window.mvs.notify`, or null outside the desktop app. */
export function shellNotify(): ((n: DesktopNotice) => Promise<boolean>) | null {
  const bridge = (window as { mvs?: { notify?: (n: DesktopNotice) => Promise<boolean> } }).mvs;
  return typeof bridge?.notify === 'function' ? bridge.notify : null;
}
