// G-61: turns new messages into desktop notifications (through the shell's
// `window.mvs.notify`) and opens the channel when one is clicked.

import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { isMuted } from '../../app/mute';
import { createGrouper, createSoundGate, defaultNotifyPrefs, shellNotify, shouldNotify, shouldSound } from '../../app/notify';
import { loadDevices, playMessageCue } from '../../voice/devices';
import { useSettings } from '../../app/settings';
import { useCoreEvent, type Id, type Message } from '../../core';
import { displayName } from './MemberList';
import { plainText } from '../../markdown';

/**
 * `viewing`: the channel on screen now (null on Home or in Settings).
 * `open`: shows a server's channel, for a click on a notification.
 */
export function useDesktopNotifications(viewing: Id | null, open: (serverId: Id, channelId: Id) => void) {
  const store = useAppStore();
  const intl = useIntl();
  const prefs = useSettings().settings.notify ?? defaultNotifyPrefs();
  const now = useRef({ viewing, prefs, intl, open });
  now.current = { viewing, prefs, intl, open };

  // Where a channel is, and what to call it, from what the store already has.
  const lookup = (channelId: Id) => {
    const s = store.getState();
    for (const [serverId, list] of Object.entries(s.channels)) {
      const channel = list.find((c) => c.id === channelId);
      if (channel) return { s, serverId, channel, server: s.servers.find((x) => x.id === serverId) };
    }
    return null;
  };

  const grouper = useRef<ReturnType<typeof createGrouper<Message>>>(null);
  if (!grouper.current) {
    const send = (m: Message, count: number) => {
      const notify = shellNotify();
      const where = lookup(m.channelId);
      if (!notify || !where) return;
      const { intl, prefs } = now.current;
      const author = where.s.members[where.serverId]?.find((x) => x.id === m.authorId);
      const place = `#${where.channel.name} · ${where.server?.name ?? ''}`;
      const body =
        count > 1
          ? intl.formatMessage({ id: 'notify.grouped' }, { count, channel: where.channel.name })
          : prefs.preview && m.body
            ? plainText(m.body) // G-25: no markers, spoilers masked
            : intl.formatMessage({ id: m.mentionsMe ? 'notify.hiddenMention' : 'notify.hidden' }, { channel: where.channel.name });
      void notify({
        title: count > 1 || !author ? place : `${displayName(author)} · ${place}`,
        body,
        channelId: m.channelId,
        messageId: m.id,
      }).catch(() => {});
    };
    grouper.current = createGrouper<Message>((m) => send(m, 1), send);
  }
  useEffect(() => () => grouper.current?.stop(), []);

  // Opening a channel sees whatever was waiting to be grouped.
  useEffect(() => {
    if (viewing) grouper.current?.drop(viewing);
  }, [viewing]);

  // G-63: one sound per 2 s at most, whatever arrives.
  const soundGate = useRef(createSoundGate());

  const onNew = (m: Message) => {
    // Core #527: nothing to say about a message that can't be opened.
    if (m.unreadable) return;
    const where = lookup(m.channelId);
    if (!where) return;
    const { viewing, prefs } = now.current;
    const author = where.s.members[where.serverId]?.find((x) => x.id === m.authorId);
    const c = {
      prefs,
      serverId: where.serverId,
      myId: where.s.identity?.id,
      authorBlocked: author?.blocked === true,
      muted: isMuted(where.s.mutes, where.serverId, m.channelId),
      watching: viewing === m.channelId && document.hasFocus(),
      now: Date.now(),
    };
    if (shellNotify() && shouldNotify(m, c)) grouper.current?.add(m.channelId, m);
    const inCall = (where.s.call?.participants.length ?? 0) > 0;
    if (shouldSound(m, { ...c, inCall }) && soundGate.current(c.now)) void playMessageCue(loadDevices().output).catch(() => {});
  };
  useCoreEvent('message.added', onNew);
  // PO rule (#558): a placeholder that opens later notifies once, like a new message.
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;
  useEffect(() => store.onPlaceholderOpened((m) => onNewRef.current(m)), [store]);

  useCoreEvent('notify.click', ({ channelId }) => {
    const where = lookup(channelId);
    if (where) now.current.open(where.serverId, channelId);
  });
}
