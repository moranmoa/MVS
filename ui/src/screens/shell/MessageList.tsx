// Virtualised message list: only the rows on screen (plus a small overscan)
// exist in the DOM, so a channel with 100,000 messages scrolls like one with 50.

import { useVirtualizer } from '@tanstack/react-virtual';
import { createContext, Fragment, memo, useCallback, useContext, useMemo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { MessageWindow } from '../../app/store';
import { isCoreError, useCore, type Member, type Message } from '../../core';
import { EmojiPicker } from '../../components/EmojiPicker';
import { isHeld } from '../../core/sanitize';
import { MENTION, splitMentions } from '../../app/mentions';
import { Avatar, Code, Name } from '../../components/common';
import {
  AlertIcon,
  ArrowDownIcon,
  CheckIcon,
  ClockIcon,
  DoubleCheckIcon,
  EditIcon,
  ReplyIcon,
  TrashIcon,
  SmilePlusIcon,
} from '../../components/icons';
import { textDir, useUiDir } from '../../app/textDir';
import { MarkdownBody, plainText } from '../../markdown';
import { displayName, lookalikeIds, LookalikeTag } from './MemberList';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { copyText } from '../../app/clipboard';
import { useAppStore } from '../../app/App';
import { useSettings } from '../../app/settings';

const GROUP_GAP_MS = 5 * 60_000;
const BOTTOM_SLACK_PX = 48;

interface Handlers {
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onDelete: (m: Message) => void;
  onRetry: (m: Message) => void;
}

/** A calendar day in local time, to compare two messages. */
export const dayKey = (t: number) => new Date(t).toDateString();

/** G-23 (B16, UX-12): "Today", "Yesterday", or the date ("12 November"; with the year when it isn't this year). */
export function DateDivider({ at }: { at: number }) {
  const intl = useIntl();
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const label =
    dayKey(at) === dayKey(now.getTime())
      ? intl.formatMessage({ id: 'chat.today' })
      : dayKey(at) === dayKey(yesterday.getTime())
        ? intl.formatMessage({ id: 'chat.yesterday' })
        : intl.formatDate(at, { day: 'numeric', month: 'long', ...(new Date(at).getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return (
    <div className="date-divider" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}

export function MessageList({
  win,
  channelName,
  memberMap,
  myId,
  isOwner,
  stickToken,
  unread = null,
  onMarkRead = () => {},
  ...handlers
}: {
  win: MessageWindow;
  channelName: string;
  memberMap: Map<string, Member>;
  myId: string;
  isOwner: boolean;
  /** Changes when I send a message: jump to the bottom even if scrolled up. */
  stickToken: number;
  /** G-21: where the new messages started when I opened the channel, and how many. */
  unread?: { first: number; count: number } | null;
  /** G-21: the bottom was seen with the window focused, or ✕ / Esc. */
  onMarkRead?: () => void;
} & Handlers) {
  const intl = useIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const openAtDivider = !!unread && unread.count < 200;
  const atBottom = useRef(!openAtDivider);
  const [barDismissed, setBarDismissed] = useState(false);
  const opened = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [flash, setFlash] = useState<number | null>(null);
  const focusPending = useRef(false);
  const count = win.count;
  const flagged = useMemo(() => lookalikeIds([...memberMap.values()]), [memberMap]);
  const store = useAppStore();
  const core = useCore();
  // G-26: the message the emoji picker is open for.
  const [pickerFor, setPickerFor] = useState<Message | null>(null);
  const react = useCallback(
    (m: Message, emoji: string, on: boolean) => {
      core.react(m.id, emoji, on).catch((e) => {
        const code = isCoreError(e) ? e.code : null;
        store.showFlash(
          code === 'bad-request' ? 'reactions.tooMany' : code === 'update-needed' ? 'reactions.updateNeeded' : code === 'rate-limited' ? 'reactions.slowDown' : 'error.generic',
        );
      });
    },
    [core, store],
  );
  const { bind, menu } = useContextMenu();
  const announcement = useNewMessageAnnouncement(win, count, atBottom, myId, memberMap);
  // B25 §2: the message menu, the same actions as the row's toolbar. Deleted
  // messages and hidden (blocked) ones have no items, so no menu opens.
  const authorName = (m: Message) => {
    const a = memberMap.get(m.authorId);
    return a ? displayName(a) : '…';
  };
  const messageItems = (m: Message): MenuItem[] =>
    m.deleted || (memberMap.get(m.authorId)?.blocked && !revealed.has(m.authorId))
      ? []
      : isHeld(m)
        ? // Not on the network yet: no id to reply to, edit or delete.
          [
            {
              key: 'copy',
              label: intl.formatMessage({ id: 'menu.copyText' }),
              onSelect: async () => store.showFlash((await copyText(plainText(m.body))) ? 'common.copied' : 'menu.copyFailed'),
            },
          ]
        : [
          { key: 'reply', label: intl.formatMessage({ id: 'chat.reply' }), onSelect: () => handlers.onReply(m) },
          ...((m.reactions?.length ?? 0) < REACTIONS_SHOWN ? [{ key: 'react', label: intl.formatMessage({ id: 'reactions.add' }), onSelect: () => setPickerFor(m) }] : []),
          {
            key: 'copy',
            label: intl.formatMessage({ id: 'menu.copyText' }),
            // The stored body without the Markdown markers (G-25: spoilers masked);
            // the direction marks are added only when it is shown.
            onSelect: async () => store.showFlash((await copyText(plainText(m.body))) ? 'common.copied' : 'menu.copyFailed'),
          },
          {
            key: 'copy-id',
            label: intl.formatMessage({ id: 'menu.copyMessageId' }),
            onSelect: async () => store.showFlash((await copyText(m.id)) ? 'common.copied' : 'menu.copyFailed'),
          },
          ...(m.authorId === myId ? [{ key: 'edit', label: intl.formatMessage({ id: 'chat.edit' }), onSelect: () => handlers.onEdit(m) }] : []),
          { kind: 'separator' },
          ...(m.authorId === myId || isOwner
            ? [{ key: 'delete', label: intl.formatMessage({ id: 'chat.delete' }), danger: true, onSelect: () => handlers.onDelete(m) }]
            : []),
        ];

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 10,
    getItemKey: (i) => i,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  // Fetch the visible range (plus a margin) from the core.
  useEffect(() => {
    if (count) win.ensure(first - 40, last + 40);
  }, [win, first, last, count]);

  // G-21: the first time the list has rows, go to the divider (instantly: no
  // smooth scroll, so nothing moves under reduced motion either).
  useLayoutEffect(() => {
    if (opened.current || !win.ready || !count) return;
    opened.current = true;
    // One message above the divider, so it isn't clamped away when the new ones nearly fill the screen.
    if (openAtDivider && unread) virtualizer.scrollToIndex(Math.max(0, Math.min(unread.first - 1, count - 1)), { align: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.ready, count]);
  // Seeing the bottom with the window focused reads the channel. Runs on every
  // render, so a message arriving while I watch (channel.updated with unread)
  // is read too. Measured from the DOM as well: a short channel that never
  // scrolls has no scroll event to say it is at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    const bottomInView = !!el && el.clientHeight > 0 && el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    if (win.ready && count && (atBottom.current || bottomInView) && document.hasFocus()) onMarkRead();
  });

  // Pin to the bottom while the reader is there: new messages and late row
  // measurements must not leave a gap under the last message.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
      el.scrollTop = el.scrollHeight;
    }
  });

  useLayoutEffect(() => {
    if (stickToken === 0) return;
    atBottom.current = true;
    virtualizer.scrollToIndex(count - 1, { align: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickToken]);

  // Move DOM focus after keyboard navigation once the row is rendered.
  useEffect(() => {
    if (!focusPending.current || active === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (row) {
      row.focus({ preventScroll: true });
      focusPending.current = false;
    }
  });

  const onScroll = () => {
    const el = scrollRef.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    setShowJump(!atBottom.current);
  };

  const goTo = (index: number, align: 'start' | 'center' | 'end' | 'auto' = 'auto') => {
    const i = Math.max(0, Math.min(count - 1, index));
    atBottom.current = i === count - 1;
    virtualizer.scrollToIndex(i, { align });
    setActive(i);
    focusPending.current = true;
  };

  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const jumpToReply = useCallback((index: number) => {
    goToRef.current(index, 'center');
    setFlash(index);
    setTimeout(() => setFlash((f) => (f === index ? null : f)), 1600);
  }, []);
  const reveal = useCallback((authorId: string) => setRevealed((s) => new Set(s).add(authorId)), []);

  /** Is the divider's row really in view (not just rendered in the overscan)? */
  const dividerOnScreen = () => {
    const row = unread && items.find((it) => it.index === unread.first);
    if (!row) return false;
    const top = virtualizer.scrollOffset ?? 0;
    const height = virtualizer.scrollRect?.height || scrollRef.current?.clientHeight || 0;
    // Not measured yet: rendered counts as seen, so the bar doesn't flash.
    return height === 0 || (row.end > top && row.start < top + height);
  };

  const jumpToNew = () => {
    if (!unread) return;
    setBarDismissed(true);
    goTo(unread.first, 'start');
  };
  const dismissNew = () => {
    setBarDismissed(true);
    onMarkRead();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // G-21: Esc reads the channel; Shift+PageUp goes to the first new message.
    if (unread && e.key === 'Escape') {
      dismissNew();
      return;
    }
    if (unread && e.key === 'PageUp' && e.shiftKey) {
      e.preventDefault();
      jumpToNew();
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!row || e.target !== row) return;
    const i = Number(row.dataset.index);
    const page = Math.max(1, last - first - 2);
    const m = win.get(i);
    switch (e.key) {
      case 'ArrowUp':
        goTo(i - 1);
        break;
      case 'ArrowDown':
        goTo(i + 1);
        break;
      case 'PageUp':
        goTo(i - page);
        break;
      case 'PageDown':
        goTo(i + page);
        break;
      case 'Home':
        goTo(0, 'start');
        break;
      case 'End':
        goTo(count - 1, 'end');
        break;
      case 'r':
        if (m && !m.deleted) handlers.onReply(m);
        break;
      case 'e':
        if (m && !m.deleted && m.authorId === myId) handlers.onEdit(m);
        break;
      case 'Delete':
        if (m && !m.deleted && (m.authorId === myId || isOwner)) handlers.onDelete(m);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const tabRow = active ?? count - 1;

  return (
    <div className="message-area">
      {/* G-113: a new message while I'm at the bottom, for screen readers. */}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
      <div
        ref={scrollRef}
        className="message-scroll"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        role="feed"
        aria-busy={!win.ready}
        aria-label={intl.formatMessage({ id: 'chat.messages' }, { channel: channelName })}
      >
        {win.ready && count === 0 && (
          <p className="chat-empty">
            <FormattedMessage id="chat.empty" values={{ channel: channelName }} />
          </p>
        )}
        <div className="message-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const m = win.get(item.index);
            const prev = item.index > 0 ? win.get(item.index - 1) : undefined;
            const grouped =
              !!m &&
              !!prev &&
              !prev.deleted &&
              !m.replyTo &&
              prev.authorId === m.authorId &&
              m.createdAt - prev.createdAt < GROUP_GAP_MS &&
              dayKey(prev.createdAt) === dayKey(m.createdAt);
            // G-23: before the first message of each day (the very first message too).
            const newDay = !!m && (item.index === 0 || (!!prev && dayKey(prev.createdAt) !== dayKey(m.createdAt)));
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={`row ${flash === item.index ? 'flash' : ''}`}
                style={{ transform: `translateY(${item.start}px)` }}
                tabIndex={item.index === tabRow ? 0 : -1}
                role="article"
                aria-posinset={item.index + 1}
                aria-setsize={count}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setActive(item.index);
                }}
                {...(m && !m.deleted
                  ? bind(intl.formatMessage({ id: 'menu.forMessage' }, { name: authorName(m) }), () => messageItems(m))
                  : {})}
              >
                {newDay && m && <DateDivider at={m.createdAt} />}
                {unread && item.index === unread.first && (
                  <div className="unread-divider" role="separator" aria-label={intl.formatMessage({ id: 'unread.divider' })}>
                    <span>
                      <FormattedMessage id="unread.divider" />
                    </span>
                  </div>
                )}
                {m ? (
                  <MessageRow
                    message={m}
                    author={memberMap.get(m.authorId)}
                    replyAuthor={m.replyTo ? memberMap.get(m.replyTo.authorId) : undefined}
                    grouped={grouped}
                    lookalike={flagged.has(m.authorId)}
                    mine={m.authorId === myId}
                    canDelete={m.authorId === myId || isOwner}
                    actionsTabbable={item.index === tabRow}
                    revealed={revealed.has(m.authorId)}
                    onReveal={reveal}
                    onJumpToReply={jumpToReply}
                    {...handlers}
                    onAddReaction={setPickerFor}
                    onReact={react}
                  />
                ) : (
                  <div className="msg skeleton" aria-hidden="true">
                    <span className="sk-avatar" />
                    <span className="sk-lines">
                      <span />
                      <span />
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {unread && !barDismissed && !dividerOnScreen() && (
        <div className="unread-bar" role="status">
          <button type="button" className="unread-bar-jump" onClick={jumpToNew}>
            <FormattedMessage id="unread.jump" values={{ count: unread.count }} />
          </button>
          <button
            type="button"
            className="icon-button small"
            onClick={dismissNew}
            aria-label={intl.formatMessage({ id: 'unread.markRead' })}
            title={intl.formatMessage({ id: 'unread.markRead' })}
          >
            ✕
          </button>
        </div>
      )}
      {showJump && (
        <button type="button" className="jump-latest" onClick={() => goTo(count - 1, 'end')}>
          <ArrowDownIcon />
          <FormattedMessage id="chat.jumpToLatest" />
        </button>
      )}
      {menu}
      <EmojiPicker open={!!pickerFor} onClose={() => setPickerFor(null)} onPick={(emoji) => pickerFor && react(pickerFor, emoji, true)} />
    </div>
  );
}

/** G-26: at most this many different emoji show under a message (the core's display cap). */
const REACTIONS_SHOWN = 20;

/** G-26: the chips under a message: the emoji and the count; mine is pressed. Click toggles mine. */
function Reactions({ message: m, tab, onAdd, onReact }: { message: Message; tab: number; onAdd: (m: Message) => void; onReact: (m: Message, emoji: string, on: boolean) => void }) {
  const intl = useIntl();
  const list = m.reactions ?? [];
  return (
    <div className="reactions" role="group" aria-label={intl.formatMessage({ id: 'reactions.label' })}>
      {list.map((r) => {
        const label = intl.formatMessage({ id: 'reactions.pill' }, { emoji: r.emoji, count: r.count });
        return (
          <button
            key={r.emoji}
            type="button"
            tabIndex={tab}
            className={`reaction ${r.mine ? 'mine' : ''}`}
            aria-pressed={r.mine}
            aria-label={label}
            title={label}
            onClick={() => onReact(m, r.emoji, !r.mine)}
          >
            <span className="reaction-emoji" aria-hidden="true">
              {r.emoji}
            </span>
            <bdi dir="ltr" className="reaction-count" aria-hidden="true">
              {r.count}
            </bdi>
          </button>
        );
      })}
      {list.length < REACTIONS_SHOWN && (
        <button type="button" tabIndex={tab} className="reaction add" aria-label={intl.formatMessage({ id: 'reactions.add' })} title={intl.formatMessage({ id: 'reactions.add' })} onClick={() => onAdd(m)}>
          +
        </button>
      )}
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  message: m,
  author,
  replyAuthor,
  grouped,
  lookalike,
  mine,
  canDelete,
  actionsTabbable,
  revealed,
  onReveal,
  onJumpToReply,
  onReply,
  onEdit,
  onDelete,
  onRetry,
  onAddReaction,
  onReact,
}: {
  message: Message;
  author?: Member;
  replyAuthor?: Member;
  grouped: boolean;
  lookalike: boolean;
  mine: boolean;
  canDelete: boolean;
  actionsTabbable: boolean;
  revealed: boolean;
  onReveal: (authorId: string) => void;
  onJumpToReply: (index: number) => void;
  /** G-26: open the picker for this message. */
  onAddReaction: (m: Message) => void;
  onReact: (m: Message, emoji: string, on: boolean) => void;
} & Handlers) {
  const intl = useIntl();
  const uiDir = useUiDir();
  const renderText = useCallback((text: string) => <MentionText text={text} message={m} />, [m]);
  const name = author ? displayName(author) : '…';
  const tab = actionsTabbable ? 0 : -1;
  const time = new Date(m.createdAt);
  // The day is on the date divider above (G-23), so the head shows the time only;
  // the full date and time stay in the tooltip.
  const timeLabel = intl.formatTime(time, { hour: '2-digit', minute: '2-digit' });
  const fullTime = intl.formatDate(time, { dateStyle: 'full', timeStyle: 'short' });

  if (m.deleted) {
    return (
      <div className="msg deleted">
        <TrashIcon />
        <span className="muted small">
          <FormattedMessage id="chat.deleted" />
        </span>
      </div>
    );
  }

  if (author?.blocked && !revealed) {
    return (
      <div className="msg blocked">
        <span className="muted small">
          <FormattedMessage id="chat.blocked" />
        </span>
        <button type="button" className="link small" tabIndex={tab} onClick={() => onReveal(m.authorId)}>
          <FormattedMessage id="chat.showAnyway" />
        </button>
      </div>
    );
  }

  return (
    <div className={`msg ${grouped ? 'grouped' : ''} ${m.mentionsMe ? 'mention' : ''} ${m.sendState === 'failed' ? 'failed' : ''}`}>
      {m.replyTo && (
        <button
          type="button"
          className="reply-ref"
          tabIndex={tab}
          onClick={() => onJumpToReply(m.replyTo!.index)}
          aria-label={intl.formatMessage({ id: 'chat.repliedMessage' })}
        >
          <ReplyIcon />
          <Name>{replyAuthor ? displayName(replyAuthor) : '…'}</Name>
          <span dir={textDir(m.replyTo.excerpt, uiDir)} className="reply-excerpt user-text">
            {m.replyTo.excerpt ? <MentionText text={plainText(m.replyTo.excerpt)} message={m} plain /> : intl.formatMessage({ id: 'chat.deleted' })}
          </span>
        </button>
      )}
      <div className="msg-main">
        <div className="msg-gutter">
          {grouped ? (
            <time className="hover-time" dateTime={time.toISOString()} title={fullTime}>
              {intl.formatTime(time, { hour: '2-digit', minute: '2-digit' })}
            </time>
          ) : (
            <Avatar name={name} color={author?.color ?? author?.avatarColor ?? '#888'} src={author?.avatarDataUrl} size={40} />
          )}
        </div>
        <div className="msg-content">
          {!grouped && (
            <div className="msg-head">
              <Name className="author">{name}</Name>
              {lookalike && <LookalikeTag />}
              {author && (
                <Code value={author.shortCode} label={intl.formatMessage({ id: 'chat.code' }, { code: author.shortCode })} />
              )}
              <time dateTime={time.toISOString()} title={fullTime}>
                {timeLabel}
              </time>
            </div>
          )}
          <div className="msg-body">
            {/* G-25: Markdown, rendered from tokens (src/markdown); mentions inside the plain runs. */}
            <MarkdownBody
              text={m.body}
              uiDir={uiDir}
              renderText={renderText}
              trailing={
                m.editedAt && (
                  <>
                    {' '}
                    <span className="edited" title={intl.formatDate(m.editedAt, { dateStyle: 'full', timeStyle: 'short' })}>
                      <FormattedMessage id="chat.edited" />
                    </span>
                  </>
                )
              }
            />
          </div>
          {m.clipped && (
            <p className="muted small clipped-note">
              <FormattedMessage id="chat.clipped" />
            </p>
          )}
          {!m.deleted && !isHeld(m) && !!m.reactions?.length && <Reactions message={m} tab={tab} onAdd={onAddReaction} onReact={onReact} />}
          {mine && m.sendState && <SendStateView message={m} onRetry={onRetry} tab={tab} />}
        </div>
      </div>
      {!isHeld(m) && (
      <div className="msg-actions" role="toolbar" aria-label={name}>
        <button type="button" tabIndex={tab} onClick={() => onReply(m)} aria-label={intl.formatMessage({ id: 'chat.reply' })} title={intl.formatMessage({ id: 'chat.reply' })}>
          <ReplyIcon />
        </button>
        {!m.deleted && (m.reactions?.length ?? 0) < REACTIONS_SHOWN && (
          <button type="button" tabIndex={tab} onClick={() => onAddReaction(m)} aria-label={intl.formatMessage({ id: 'reactions.add' })} title={intl.formatMessage({ id: 'reactions.add' })}>
            <SmilePlusIcon />
          </button>
        )}
        {mine && (
          <button type="button" tabIndex={tab} onClick={() => onEdit(m)} aria-label={intl.formatMessage({ id: 'chat.edit' })} title={intl.formatMessage({ id: 'chat.edit' })}>
            <EditIcon />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            tabIndex={tab}
            className="danger-icon"
            onClick={() => onDelete(m)}
            aria-label={intl.formatMessage({ id: 'chat.delete' })}
            title={intl.formatMessage({ id: 'chat.delete' })}
          >
            <TrashIcon />
          </button>
        )}
      </div>
      )}
    </div>
  );
});

function SendStateView({ message, onRetry, tab }: { message: Message; onRetry: (m: Message) => void; tab: number }) {
  const intl = useIntl();
  if (isHeld(message)) return <HeldStateView message={message} onRetry={onRetry} tab={tab} />;
  switch (message.sendState) {
    case 'pending':
      return (
        <span className="send-state pending">
          <ClockIcon />
          <FormattedMessage id="chat.state.pending" />
        </span>
      );
    case 'sent':
      return (
        <span className="send-state sent" role="img" aria-label={intl.formatMessage({ id: 'chat.state.sent' })} title={intl.formatMessage({ id: 'chat.state.sent' })}>
          <CheckIcon />
        </span>
      );
    case 'received':
      return (
        <span
          className="send-state received"
          role="img"
          aria-label={intl.formatMessage({ id: 'chat.state.received' })}
          title={intl.formatMessage({ id: 'chat.state.received' })}
        >
          <DoubleCheckIcon />
        </span>
      );
    case 'failed':
      return (
        <span className="send-state failed">
          <AlertIcon />
          <FormattedMessage id="chat.state.failed" />
          <button type="button" className="link small" tabIndex={tab} onClick={() => onRetry(message)}>
            <FormattedMessage id="common.retry" />
          </button>
        </span>
      );
    default:
      return null;
  }
}

/**
 * A message held for its channel key (#288). Normally sent in under a second:
 * "Sending…". With no key after 2 minutes it fails; "Try again" discards it
 * and sends the text as a new message.
 */
function HeldStateView({ message, onRetry, tab }: { message: Message; onRetry: (m: Message) => void; tab: number }) {
  if (message.sendState === 'failed') {
    return (
      <span className="send-state failed held">
        <AlertIcon />
        <FormattedMessage id="chat.state.heldFailed" />
        <button type="button" className="link small" tabIndex={tab} onClick={() => onRetry(message)}>
          <FormattedMessage id="common.retry" />
        </button>
      </span>
    );
  }
  return (
    <span className="send-state pending held">
      <ClockIcon />
      <FormattedMessage id="chat.state.held" />
    </span>
  );
}

/** Who the message list can name: the server's members, for mention chips (G-24). */
export const MemberNames = createContext<Map<string, Member>>(new Map());

/**
 * Text with its <@id> mention tokens shown as "@Name" from the member list. A
 * token for someone who isn't a member now (not in the core's `mentions`, or
 * unknown here) shows as a neutral former-member chip. Raw ids never show.
 * `plain`: names only, no chip styling (reply excerpts); a cut-off token goes.
 */
function MentionText({ text, message, plain = false }: { text: string; message: Message; plain?: boolean }) {
  const members = useContext(MemberNames);
  const intl = useIntl();
  const clean = plain ? text.replace(/<@[^>]*$/, '') : text;
  if (!MENTION.test(clean)) return <>{clean}</>;
  MENTION.lastIndex = 0;
  return (
    <>
      {splitMentions(clean).map((p, i) => {
        if ('text' in p) return <Fragment key={i}>{p.text}</Fragment>;
        const member = members.get(p.mention);
        const current = member && (!message.mentions || message.mentions.includes(p.mention));
        const name = current ? member.displayName : intl.formatMessage({ id: 'mention.unknown' });
        // The @ sits inside the chip, outside the name's isolate, so it follows the line's direction (UX).
        if (plain) return <Fragment key={i}>@<bdi>{name}</bdi></Fragment>;
        return (
          <span key={i} className={`mention-chip ${current ? '' : 'former'}`}>
            @<bdi>{name}</bdi>
          </span>
        );
      })}
    </>
  );
}

/** G-113: at most one announcement this often; messages in between are counted into it. */
export const ANNOUNCE_GAP_MS = 1500;
/** G-113: how much of a message is read out. */
export const ANNOUNCE_CHARS = 100;

/**
 * G-113: a polite screen-reader line for messages that arrive while I'm at
 * the bottom of the channel on screen: "{name}: {first 100 characters}", or
 * "New message from {name}" when notification previews are off (the same
 * privacy choice). Not my own, deleted or blocked authors' messages; nothing
 * for what was already there when the channel opened. Throttled: several
 * within 1.5 s become one "{count} new messages".
 */
function useNewMessageAnnouncement(
  win: MessageWindow,
  count: number,
  atBottom: { current: boolean },
  myId: string,
  memberMap: Map<string, Member>,
): string {
  const intl = useIntl();
  const preview = useSettings().settings.notify?.preview === true;
  const [text, setText] = useState('');
  const seen = useRef<number | null>(null);
  const pending = useRef<{ last: Message; n: number } | null>(null);
  const lastAt = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const now = useRef({ intl, preview, memberMap });
  now.current = { intl, preview, memberMap };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!win.ready) return;
    const before = seen.current;
    seen.current = count;
    // The channel just opened: what's there was there before.
    if (before === null || count <= before || !atBottom.current) return;
    const fresh: Message[] = [];
    for (let i = before; i < count; i++) {
      const m = win.get(i);
      if (m && !m.deleted && m.authorId !== myId && !now.current.memberMap.get(m.authorId)?.blocked) fresh.push(m);
    }
    if (fresh.length === 0) return;
    pending.current = { last: fresh[fresh.length - 1]!, n: (pending.current?.n ?? 0) + fresh.length };
    const say = () => {
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      lastAt.current = Date.now();
      const { intl, preview, memberMap } = now.current;
      const author = memberMap.get(p.last.authorId);
      const name = author ? displayName(author) : '…';
      if (p.n > 1) return setText(intl.formatMessage({ id: 'a11y.newMessages' }, { count: p.n }));
      const body = plainText(p.last.body ?? '').replace(/\s+/g, ' ').trim();
      setText(
        preview && body
          ? intl.formatMessage({ id: 'a11y.newMessage' }, { name, phrase: body.length > ANNOUNCE_CHARS ? body.slice(0, ANNOUNCE_CHARS) + '…' : body })
          : intl.formatMessage({ id: 'a11y.newMessageFrom' }, { name }),
      );
    };
    const wait = ANNOUNCE_GAP_MS - (Date.now() - lastAt.current);
    if (wait <= 0) say();
    else timer.current ??= setTimeout(() => {
      timer.current = undefined;
      say();
    }, wait);
  }, [win, win.ready, count, myId, atBottom]);
  return text;
}
