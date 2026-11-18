// G-14: a channel's topic (docs/design/channel-topic.md). One line of plain
// text: never Markdown, never a link (SL). Visible to every member of the
// server, so the hint says so; an 18+ channel's topic is listed only with it,
// but that is display-only.

import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isCoreError, useCore, type Channel } from '../../core';
import { CHANNEL_TOPIC_MAX } from '../../core/sanitize';
import { useUserTextProps } from '../../app/textDir';
import { Dialog } from '../../components/common';

/** The counter shows from here (the limit is 256 code points). */
const COUNT_FROM = 200;

/** One line: line breaks (and the Unicode line/paragraph separators) become spaces. */
const oneLine = (s: string) => s.replace(/[\r\n  ]+/g, ' ');

export function TopicDialog({
  channel,
  canEdit,
  open,
  editing: startEditing = false,
  onClose,
}: {
  channel: Channel;
  canEdit: boolean;
  open: boolean;
  /** Open straight in the editor (the menu item, or "Add a topic"). */
  editing?: boolean;
  onClose: () => void;
}) {
  const intl = useIntl();
  const core = useCore();
  const topic = channel.topic ?? '';
  const [editing, setEditing] = useState(startEditing || !topic);
  const [value, setValue] = useState(topic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const viewProps = useUserTextProps(topic);
  const fieldProps = useUserTextProps(value);

  useEffect(() => {
    if (!open) return;
    setEditing(startEditing || !topic);
    setValue(topic);
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && editing) requestAnimationFrame(() => field.current?.focus());
  }, [open, editing]);

  const length = [...value.trim()].length;
  const tooLong = length > CHANNEL_TOPIC_MAX;
  const save = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      await core.setChannelTopic(channel.id, next.trim());
      onClose();
    } catch (e) {
      const code = isCoreError(e) ? e.code : null;
      setError(code === 'update-needed' ? 'channel.topic.updateNeeded' : code === 'bad-request' ? 'channel.topic.invalid' : 'error.generic');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={<FormattedMessage id="channel.topic.label" />} className="topic-dialog">
      {editing && canEdit ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooLong && !busy) void save(value);
          }}
        >
          <input
            ref={field}
            type="text"
            {...fieldProps}
            className={`${fieldProps.className} topic-field`}
            aria-label={intl.formatMessage({ id: 'channel.topic.label' })}
            aria-describedby="topic-hint"
            aria-invalid={tooLong || undefined}
            value={value}
            onChange={(e) => setValue(oneLine(e.target.value))}
          />
          <p id="topic-hint" className="muted small">
            <FormattedMessage id="channel.topic.hint" />
            {length >= COUNT_FROM && (
              <>
                {' '}
                {/* Only once it shows is it a live region (UX). */}
                <span className={tooLong ? 'error' : undefined} dir="ltr" aria-live="polite">
                  <FormattedMessage id="channel.topic.counter" values={{ n: length }} />
                </span>
              </>
            )}
          </p>
          {error && (
            <p className="error small" role="alert">
              <FormattedMessage id={error} />
            </p>
          )}
          <div className="actions">
            {topic && (
              <button type="button" disabled={busy} onClick={() => void save('')}>
                <FormattedMessage id="channel.topic.clear" />
              </button>
            )}
            <span className="spacer" />
            <button type="button" onClick={onClose} disabled={busy}>
              <FormattedMessage id="common.cancel" />
            </button>
            <button type="submit" className="primary" disabled={busy || tooLong || value.trim() === topic}>
              <FormattedMessage id="channel.save" />
            </button>
          </div>
        </form>
      ) : (
        <div className="stack">
          {/* Plain text: no Markdown, no links (SL on G-14). */}
          <p {...viewProps} className={`${viewProps.className} topic-text`}>
            {topic}
          </p>
          <p className="muted small">
            <FormattedMessage id="channel.topic.hint" />
          </p>
          <div className="actions">
            <span className="spacer" />
            {canEdit && (
              <button type="button" onClick={() => setEditing(true)}>
                <FormattedMessage id="channel.topic.edit" />
              </button>
            )}
            <button type="button" className="primary" onClick={onClose}>
              <FormattedMessage id="common.close" />
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
