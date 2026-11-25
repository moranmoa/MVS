import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { isCoreError, useCore, type Id, type Member, type Message, type ServerSummary } from '../../core';
import { Avatar, Code, Dialog, Name, RICH } from '../../components/common';
import { BackIcon, CloseIcon, EditIcon, HashIcon, ReplyIcon, SendIcon, SmileIcon, UsersIcon, WifiOffIcon } from '../../components/icons';
import { EmojiPicker } from '../../components/EmojiPicker';
import { TopicDialog } from './TopicDialog';
import { useUserTextProps } from '../../app/textDir';
import { mentionQuery, toDisplay, toTokens } from '../../app/mentions';
import { applyEdit, dismissHint, hintDue, insideOpenFence, shortcutMarker, wrapEdit } from '../../markdown/composer';
import { BODY_MAX, BODY_MAX_BYTES, isHeld } from '../../core/sanitize';

/** The character counter shows from here on (B6/QA-17 acceptance: 3,800). */
const COUNTER_FROM = 3800;
const utf8 = new TextEncoder();
import { MemberNames, MessageList } from './MessageList';

const NO_MEMBERS: Member[] = [];

export function ChatView({
  server,
  channelId,
  membersOpen,
  onToggleMembers,
  onBack,
}: {
  server: ServerSummary;
  channelId: string;
  membersOpen: boolean;
  onToggleMembers: () => void;
  /** Phone layout only: back to the channel list. */
  onBack?: () => void;
}) {
  const store = useAppStore();
  const core = useCore();
  const intl = useIntl();
  const channel = useStore(store, (s) => s.channels[server.id]?.find((c) => c.id === channelId));
  const members = useStore(store, (s) => s.members[server.id] ?? NO_MEMBERS);
  const myId = useStore(store, (s) => s.identity!.id);
  useStore(store, (s) => s.messagesVersion); // re-render when messages change
  const win = store.window(channelId);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [toDelete, setToDelete] = useState<Message | null>(null);
  const [stickToken, setStickToken] = useState(0);
  // G-14: the topic dialog (view; the owner can edit).
  const [topicOpen, setTopicOpen] = useState(false);

  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const nobodyOnline = members.length > 0 && members.every((m) => m.id === myId || m.presence === 'offline');
  const isOwner = server.ownerId === myId;

  // G-21: where the new messages started when I opened the channel. Kept until
  // I leave it, even after it's all read, so the divider stays put.
  const mark = useRef<{ channelId: string; first: number; count: number } | null>(null);
  if (mark.current?.channelId !== channelId && channel) {
    mark.current =
      channel.firstUnreadIndex !== undefined && channel.unreadCount
        ? { channelId, first: channel.firstUnreadIndex, count: channel.unreadCount }
        : { channelId, first: -1, count: 0 };
  }
  const unread = mark.current && mark.current.count > 0 ? mark.current : null;
  const markRead = useCallback(() => {
    const c = store.getState().channels[server.id]?.find((x) => x.id === channelId);
    if (c?.unread || c?.mentions) void core.markRead(channelId);
  }, [store, server.id, channelId, core]);

  // Reading the channel clears its unread dot and mention badge. With the core's
  // unread position (G-21) that waits until the bottom is seen, or ✕ / Esc;
  // without it, opening the channel reads it, as before.
  const hasPosition = channel?.firstUnreadIndex !== undefined;
  useEffect(() => {
    if (!hasPosition && (channel?.unread || channel?.mentions)) void core.markRead(channelId);
  }, [hasPosition, channel?.unread, channel?.mentions, channelId, core]);

  const onReply = useCallback((m: Message) => {
    setEditing(null);
    setReplyTo(m);
  }, []);
  const onEdit = useCallback((m: Message) => {
    setReplyTo(null);
    setEditing(m);
  }, []);
  const onDelete = useCallback((m: Message) => setToDelete(m), []);
  const onRetry = useCallback(
    (m: Message) => {
      if (!isHeld(m)) return void core.retryMessage(m.id).catch(() => {});
      // Held for its key and failed (#288): drop it (the core would keep it until
      // a restart), then send the text again as a new message.
      void core
        .discardMessage(m.id)
        .catch(() => null)
        .then(() => store.window(m.channelId).removeHeld(m.id))
        .then(() => core.sendMessage(m.channelId, m.body))
        .catch(() => {});
    },
    [core, store],
  );

  const editLast = () => {
    for (let i = win.count - 1; i >= Math.max(0, win.count - 50); i--) {
      const m = win.get(i);
      if (m && m.authorId === myId && !m.deleted) return onEdit(m);
    }
  };

  const channelName = channel?.name ?? '';
  // G-29: tell the core while there's text (it sends at most every 3 s); stop on send,
  // clear, or leaving the channel. Nothing goes out with the privacy switch off.
  const typingOn = useStore(store, (st) => st.typingIndicator);
  const typingSent = useRef(0);
  const onTyping = (on: boolean) => {
    if (!typingOn) return;
    const now = Date.now();
    if (on && now - typingSent.current < 1000) return;
    if (!on && !typingSent.current) return;
    typingSent.current = on ? now : 0;
    void core.setTyping(channelId, on).catch(() => {});
  };
  useEffect(
    () => () => {
      if (typingSent.current) void core.setTyping(channelId, false).catch(() => {});
      typingSent.current = 0;
    },
    [core, channelId],
  );

  return (
    <section className="chat" aria-label={intl.formatMessage({ id: 'chat.messages' }, { channel: channelName })}>
      <header className="chat-header">
        {onBack && (
          <button
            type="button"
            className="icon-button back-button"
            onClick={onBack}
            aria-label={intl.formatMessage({ id: 'chat.back' })}
            title={intl.formatMessage({ id: 'chat.back' })}
          >
            <BackIcon />
          </button>
        )}
        <HashIcon />
        <h2 className="chat-title" tabIndex={-1}>
          {/* G-14 (UX): on a phone the topic isn't in the header; the name opens it. */}
          {onBack && channel?.topic ? (
            <button type="button" className="chat-title-button" onClick={() => setTopicOpen(true)} aria-label={intl.formatMessage({ id: 'channel.topic.button' }, { topic: channel.topic })}>
              <bdi>{channelName}</bdi>
            </button>
          ) : (
            <bdi>{channelName}</bdi>
          )}
        </h2>
        {channel?.adult && (
          <span className="adult-tag" title={intl.formatMessage({ id: 'channel.adult' })}>
            18+
          </span>
        )}
        {!onBack &&
          (channel?.topic ? (
            <button type="button" className="chat-topic" onClick={() => setTopicOpen(true)} aria-label={intl.formatMessage({ id: 'channel.topic.button' }, { topic: channel.topic })}>
              {/* An English topic keeps its direction in the Hebrew UI. */}
              <bdi dir="auto">{channel.topic}</bdi>
            </button>
          ) : (
            isOwner &&
            channel &&
            !server.closed && (
              <button type="button" className="chat-topic add" onClick={() => setTopicOpen(true)}>
                <FormattedMessage id="channel.topic.add" />
              </button>
            )
          ))}
        <span className="spacer" />
        <button
          type="button"
          className={`icon-button members-button ${membersOpen ? 'pressed' : ''}`}
          aria-pressed={membersOpen}
          onClick={onToggleMembers}
          aria-label={intl.formatMessage({ id: 'chat.toggleMembers' })}
          title={intl.formatMessage({ id: 'chat.toggleMembers' })}
        >
          <UsersIcon />
        </button>
      </header>
      {channel && <TopicDialog channel={channel} canEdit={isOwner && !server.closed} open={topicOpen} onClose={() => setTopicOpen(false)} />}
      {nobodyOnline && (
        <div className="offline-banner" role="status">
          <WifiOffIcon />
          <span>
            <FormattedMessage id="chat.offline" />
          </span>
        </div>
      )}
      <MemberNames.Provider value={memberMap}>
      <MessageList
        key={channelId}
        unread={unread}
        onMarkRead={markRead}
        win={win}
        channelName={channelName}
        memberMap={memberMap}
        myId={myId}
        isOwner={isOwner}
        stickToken={stickToken}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        onRetry={onRetry}
      />
      </MemberNames.Provider>
      {!server.closed && <TypingLine channelId={channelId} myId={myId} members={members} />}
      {server.closed ? (
        // Closed by its owner (#261): read-only until it is removed 30 days later.
        <div className="closed-banner" role="status">
          <FormattedMessage id="server.closedBanner" />
        </div>
      ) : (
        <Composer
          members={members}
          myId={myId}
          channelName={channelName}
          replyTo={replyTo}
          replyName={replyTo ? (memberMap.get(replyTo.authorId)?.displayName ?? '') : ''}
          editing={editing}
          onCancel={() => {
            setReplyTo(null);
            setEditing(null);
          }}
          onEditLast={editLast}
          onTyping={onTyping}
          onSubmit={async (body) => {
            if (editing) {
              if (body !== editing.body) await core.editMessage(editing.id, body);
              setEditing(null);
            } else {
              const reply = replyTo?.id;
              setReplyTo(null);
              setStickToken((t) => t + 1);
              await core.sendMessage(channelId, body, reply);
            }
          }}
        />
      )}
      <Dialog open={!!toDelete} onClose={() => setToDelete(null)} title={intl.formatMessage({ id: 'chat.delete' })}>
        <p>
          <FormattedMessage id="chat.deleteConfirm" />
        </p>
        <div className="actions">
          <button
            type="button"
            className="danger"
            autoFocus
            onClick={() => {
              // The real core can't delete yet (not-implemented); nothing changes then.
              if (toDelete) core.deleteMessage(toDelete.id).catch(() => {});
              setToDelete(null);
            }}
          >
            <FormattedMessage id="chat.delete" />
          </button>
          <button type="button" className="secondary" onClick={() => setToDelete(null)}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </Dialog>
    </section>
  );
}

/** G-29: who is typing here; one quiet line above the composer, not announced. */
const TYPING_MS = 6000;
function TypingLine({ channelId, myId, members }: { channelId: Id; myId: Id; members: Member[] }) {
  const store = useAppStore();
  const entry = useStore(store, (st) => st.typing[channelId]);
  const [, tick] = useState(0);
  // The backstop: a typer the core hasn't refreshed for 6 s is gone.
  useEffect(() => {
    if (!entry) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, entry.at + TYPING_MS - Date.now()) + 10);
    return () => clearTimeout(t);
  }, [entry]);
  const fresh = entry && Date.now() - entry.at < TYPING_MS ? entry.userIds : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  // Not me, and not blocked accounts (PO #426).
  const names = fresh.filter((id) => id !== myId && !byId.get(id)?.blocked).map((id) => byId.get(id)?.displayName || byId.get(id)?.shortCode || '…');
  return (
    <div className="typing-line" aria-live="off">
      {names.length > 0 && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="typing-text">
            {names.length === 1 ? (
              <FormattedMessage id="typing.one" values={{ name: names[0] }} />
            ) : names.length === 2 ? (
              <FormattedMessage id="typing.two" values={{ a: names[0], b: names[1] }} />
            ) : (
              <FormattedMessage id="typing.many" />
            )}
          </span>
        </>
      )}
    </div>
  );
}

function Composer({
  members,
  myId,
  channelName,
  replyTo,
  replyName,
  editing,
  onCancel,
  onEditLast,
  onTyping,
  onSubmit,
}: {
  members: Member[];
  myId: string;
  channelName: string;
  replyTo: Message | null;
  replyName: string;
  editing: Message | null;
  onCancel: () => void;
  onEditLast: () => void;
  /** G-29: true while there is text being typed, false when it is sent or cleared. */
  onTyping: (on: boolean) => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const intl = useIntl();
  const [text, setText] = useState('');
  // Empty: the interface direction (cursor and placeholder on the right in Hebrew).
  const textProps = useUserTextProps(text);
  const draft = useRef('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // G-24: "@Name" in the box ↔ <@id> in the body. The box never shows raw ids.
  const mentionMap = useRef(new Map<string, string>());
  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName || undefined;
  const unknownName = intl.formatMessage({ id: 'mention.unknown' });
  // Where the space after the last picked mention ends: punctuation typed right there replaces that space.
  const afterMention = useRef(-1);
  const [suggest, setSuggest] = useState<{ start: number; query: string; index: number } | null>(null);
  // G-27: the emoji picker inserts where the cursor was when it opened.
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const caret = useRef<[number, number] | null>(null);
  const insertEmoji = (emoji: string, keep: boolean) => {
    const [from, to] = caret.current ?? [text.length, text.length];
    const at = from + emoji.length;
    setText(text.slice(0, from) + emoji + text.slice(to));
    setFailed(null);
    caret.current = [at, at];
    // G-29: an inserted emoji is typing too (not while editing a sent message).
    if (!editing) onTyping(true);
    if (keep) return;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };
  const matches = suggest
    ? members
        .filter((m) => m.id !== myId && m.displayName && m.displayName.toLowerCase().includes(suggest.query.toLowerCase()))
        // Names that start with what was typed come first (UX).
        .sort((a, b) => Number(!a.displayName.toLowerCase().startsWith(suggest.query.toLowerCase())) - Number(!b.displayName.toLowerCase().startsWith(suggest.query.toLowerCase())))
        .slice(0, 6)
    : [];
  const pick = (m: Member) => {
    const el = ref.current;
    if (!suggest || !el) return;
    const shown = `@${m.displayName}`;
    mentionMap.current.set(shown, `<@${m.id}>`);
    const caret = el.selectionStart ?? text.length;
    const next = text.slice(0, suggest.start) + shown + ' ' + text.slice(caret);
    setText(next);
    setSuggest(null);
    const at = suggest.start + shown.length + 1;
    afterMention.current = at;
    requestAnimationFrame(() => el.setSelectionRange(at, at));
  };

  // G-25: the formatting hint, once: shown the first time markers appear, until ✕.
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!hint && hintDue(text)) setHint(true);
  }, [text, hint]);

  /** G-25: wrap the selection in a marker; one Ctrl+Z undoes it (the native edit stack). */
  const wrapSelection = (el: HTMLTextAreaElement, marker: string) => {
    const edit = wrapEdit(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0, marker);
    el.setSelectionRange(edit.from, edit.to);
    // insertText goes through the textarea's own undo stack and its input event.
    const native = typeof document.execCommand === 'function' && document.execCommand('insertText', false, edit.insert);
    if (native) {
      el.setSelectionRange(edit.selStart, edit.selEnd);
    } else {
      setText(applyEdit(el.value, edit));
      requestAnimationFrame(() => el.setSelectionRange(edit.selStart, edit.selEnd));
    }
  };

  // Entering edit mode swaps the draft out and the message text in.
  useEffect(() => {
    if (editing) {
      draft.current = text;
      setText(toDisplay(editing.body, nameOf, unknownName, mentionMap.current));
    } else if (draft.current) {
      setText(draft.current);
      draft.current = '';
    }
    if (editing || replyTo) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, replyTo]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '';
    if (!text) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // QA-10: no silent cut. Past the limit the counter turns red and sending
  // stops, so the person can shorten the text themselves.
  // The limit is in code points (QA-17): an emoji is one character, not two
  // UTF-16 units. A string never has more code points than units, so the
  // cheap length check skips the count for normal messages.
  const chars = text.length >= COUNTER_FROM ? [...text].length : text.length;
  const nearLimit = chars >= COUNTER_FROM;
  const tooLong = nearLimit && (chars > BODY_MAX || utf8.encode(text).length > BODY_MAX_BYTES);
  // Why the last send failed: no channel key yet (`not-allowed`: a moderator
  // has to renew it), a feature the core doesn't have yet, or anything else.
  const [failed, setFailed] = useState<'no-key' | 'not-yet' | 'other' | null>(null);

  const submit = async () => {
    const body = toTokens(text.trim(), mentionMap.current);
    if (!body || tooLong) return;
    setFailed(null);
    onTyping(false);
    if (!editing) setText('');
    try {
      await onSubmit(body);
      if (editing) setText('');
    } catch (e) {
      // The core refused it: give the text back instead of losing it.
      setText((t) => t || toDisplay(body, nameOf, unknownName, mentionMap.current));
      const code = isCoreError(e) ? e.code : null;
      setFailed(code === 'not-allowed' ? 'no-key' : code === 'not-implemented' ? 'not-yet' : 'other');
    }
  };

  return (
    <div className="composer">
      {(replyTo || editing) && (
        <div className="composer-context">
          {editing ? <EditIcon /> : <ReplyIcon />}
          <span>
            {editing ? (
              <FormattedMessage id="chat.editing" />
            ) : (
              <FormattedMessage id="chat.replyingTo" values={{ name: <Name>{replyName}</Name> }} />
            )}
          </span>
          {editing && (
            <span className="muted small">
              <FormattedMessage id="chat.editHint" values={RICH} />
            </span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            aria-label={intl.formatMessage({ id: editing ? 'common.cancel' : 'chat.cancelReply' })}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {matches.length > 0 && suggest && (
        <ul id="mention-suggestions" className="mention-suggestions" role="listbox" aria-label={intl.formatMessage({ id: 'mention.suggestions' })}>
          {matches.map((m, i) => (
            <li
              key={m.id}
              id={`mention-${m.id}`}
              role="option"
              aria-selected={i === suggest.index % matches.length}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              <Avatar name={m.displayName} color={m.color ?? m.avatarColor} src={m.avatarDataUrl} size={20} />
              <Name>{m.displayName}</Name>
              <Code value={m.shortCode} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="composer-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <button
          ref={emojiButton}
          type="button"
          className="icon-button emoji-open"
          aria-label={intl.formatMessage({ id: 'emoji.insert' })}
          title={intl.formatMessage({ id: 'emoji.insert' })}
          aria-haspopup="dialog"
          aria-expanded={emojiOpen}
          onClick={() => {
            const el = ref.current;
            caret.current = el ? [el.selectionStart ?? text.length, el.selectionEnd ?? text.length] : null;
            setEmojiOpen(true);
          }}
        >
          <SmileIcon />
        </button>
        <textarea
          ref={ref}
          {...textProps}
          aria-invalid={tooLong || undefined}
          aria-describedby={nearLimit || failed ? 'composer-status' : undefined}
          rows={1}
          value={text}
          placeholder={intl.formatMessage({ id: 'chat.composer' }, { channel: channelName })}
          aria-label={intl.formatMessage({ id: 'chat.composer' }, { channel: channelName })}
          aria-controls="mention-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={matches.length ? `mention-${matches[suggest!.index % matches.length].id}` : undefined}
          onChange={(e) => {
            setFailed(null);
            let value = e.target.value;
            const at = afterMention.current;
            afterMention.current = -1;
            // "@Name " then "?" reads "@Name?": no space before the punctuation (UX).
            if (at > 0 && value.length === text.length + 1 && value[at - 1] === ' ' && /^[.,!?;:)\]]$/.test(value[at] ?? '')) {
              value = value.slice(0, at - 1) + value.slice(at);
            }
            setText(value);
            // G-29: not while editing an old message; an emptied box stops it.
            if (!editing) onTyping(value.trim() !== '');
            const q = mentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
            setSuggest(q ? { ...q, index: 0 } : null);
          }}
          onKeyDown={(e) => {
            // G-24: the suggestion list takes the arrows, Enter / Tab and Esc while open.
            if (matches.length && suggest) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                setSuggest({ ...suggest, index: (suggest.index + d + matches.length) % matches.length });
                return;
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
                e.preventDefault();
                pick(matches[suggest.index % matches.length]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setSuggest(null);
                return;
              }
            }
            const marker = e.nativeEvent.isComposing ? null : shortcutMarker(e); // not mid-IME composition
            if (marker) {
              e.preventDefault();
              wrapSelection(e.currentTarget, marker);
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              // G-25: inside an open ``` fence, Enter is a newline until the fence is closed.
              if (insideOpenFence(text, e.currentTarget.selectionStart ?? text.length)) return;
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape' && (replyTo || editing)) {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'ArrowUp' && !text && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              // G-32: a plain ↑ only; Alt+↑ / Ctrl+Alt+↑ move between channels and servers.
              e.preventDefault();
              onEditLast();
            }
          }}
        />
        <EmojiPicker mode="composer" open={emojiOpen} anchor={emojiButton} onClose={() => setEmojiOpen(false)} onPick={insertEmoji} />
        <button type="submit" className="icon-button send" aria-label={intl.formatMessage({ id: 'chat.send' })} disabled={!text.trim() || tooLong}>
          <SendIcon />
        </button>
      </form>
      {hint && (
        <p className="composer-hint muted small">
          <span className="user-text">
            <FormattedMessage id="md.hint" />
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={intl.formatMessage({ id: 'common.close' })}
            onClick={() => {
              dismissHint();
              setHint(false);
            }}
          >
            <CloseIcon />
          </button>
        </p>
      )}
      {(nearLimit || failed) && (
        <p id="composer-status" className={`composer-status ${tooLong || failed ? 'error' : 'muted'}`} role={tooLong || failed ? 'alert' : undefined}>
          {failed ? (
            <FormattedMessage id={failed === 'no-key' ? 'chat.cantWriteYet' : failed === 'not-yet' ? 'chat.notYet' : 'chat.sendFailed'} />
          ) : (
            <>
              {tooLong && (
                <>
                  <FormattedMessage id="chat.tooLong" values={{ max: BODY_MAX }} />{' '}
                </>
              )}
              <span className="char-count" dir="ltr">
                <FormattedMessage id="chat.charCount" values={{ count: chars, max: BODY_MAX }} />
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
