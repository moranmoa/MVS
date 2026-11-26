// G-51 (docs/ux/specs/server-icon-description.md, with #587): the server's icon
// and description on the "כללי" page. A draft until "שמירה"; the rail, header
// and title follow the saved record (server.updated), never the draft.

import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isCoreError, useCore, type ServerSummary } from '../../core';
import { serverIconFrom } from '../../app/image';
import { UpdateNeeded } from './ServerLifecycle';

/** The UI's cap (the core allows 500); the counter shows from 260. */
export const DESC_MAX = 300;
const DESC_COUNT_FROM = 260;
const DESC_MAX_LINES = 5;

/** As the core wants it: no trailing spaces, no blank first or last line, blank runs collapsed. */
export function normalizeDescription(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type IconError = 'unusable' | 'rate-limited' | null;
type Failure = 'update-needed' | 'other' | null;

export function ServerMetaForm({ server }: { server: ServerSummary }) {
  const intl = useIntl();
  const core = useCore();
  const savedIcon = server.iconDataUrl ?? null;
  const savedDesc = server.description ?? '';
  const [icon, setIcon] = useState<string | null>(savedIcon);
  const [desc, setDesc] = useState(savedDesc);
  const [busy, setBusy] = useState(false);
  const [iconError, setIconError] = useState<IconError>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // A save elsewhere (or by another admin) moves the baseline; an untouched draft follows it.
  const base = useRef({ icon: savedIcon, desc: savedDesc });
  useEffect(() => {
    if (icon === base.current.icon) setIcon(savedIcon);
    if (desc === base.current.desc) setDesc(savedDesc);
    base.current = { icon: savedIcon, desc: savedDesc };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedIcon, savedDesc]);

  const normalized = normalizeDescription(desc);
  const iconDirty = icon !== savedIcon;
  const descDirty = normalized !== savedDesc;
  const dirty = iconDirty || descDirty;
  const length = [...desc].length;
  const tooManyLines = normalized.split('\n').length > DESC_MAX_LINES;
  const tooLong = length > DESC_MAX;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setIconError(null);
    setSaved(false);
    const r = await serverIconFrom(f);
    if (r.ok) setIcon(r.dataUrl);
    else setIconError('unusable');
  };

  const save = async () => {
    setBusy(true);
    setFailure(null);
    setIconError(null);
    setSaved(false);
    let ok = true;
    // The description first: an icon refused for its rate limit must not stop it.
    if (descDirty) {
      try {
        await core.setServerDescription(server.id, normalized);
        setDesc(normalized);
      } catch (e) {
        ok = false;
        setFailure(isCoreError(e) && e.code === 'update-needed' ? 'update-needed' : 'other');
      }
    }
    if (iconDirty && ok) {
      try {
        await core.setServerIcon(server.id, icon);
      } catch (e) {
        ok = false;
        if (isCoreError(e) && e.code === 'rate-limited') setIconError('rate-limited');
        else if (isCoreError(e) && e.code === 'bad-request') setIconError('unusable');
        else setFailure(isCoreError(e) && e.code === 'update-needed' ? 'update-needed' : 'other');
      }
    }
    setBusy(false);
    if (ok) setSaved(true);
  };

  return (
    <form
      className="stack server-meta"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !busy && !tooLong && !tooManyLines) void save();
      }}
    >
      <div className="server-icon-row">
        <span className="server-icon-preview" style={{ background: server.color }} aria-hidden="true">
          {icon ? <img src={icon} alt="" /> : <bdi>{server.initials}</bdi>}
        </span>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        <button type="button" className="secondary small" aria-label={intl.formatMessage({ id: 'server.icon.chooseFor' })} onClick={() => file.current?.click()} disabled={busy}>
          <FormattedMessage id="server.icon.choose" />
        </button>
        {icon && (
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              setIcon(null);
              setIconError(null);
            }}
            disabled={busy}
          >
            <FormattedMessage id="server.icon.remove" />
          </button>
        )}
      </div>
      {iconError && (
        <p className="error small" role="alert" id="server-icon-error">
          <FormattedMessage id={iconError === 'rate-limited' ? 'server.icon.rateLimited' : 'server.icon.error'} />
        </p>
      )}
      <label className="field">
        <span>
          <FormattedMessage id="server.desc.label" />
        </span>
        <textarea
          dir="auto"
          rows={4}
          value={desc}
          maxLength={DESC_MAX * 2}
          aria-describedby="server-desc-hint server-desc-status"
          aria-invalid={tooLong || tooManyLines || undefined}
          onChange={(e) => {
            setDesc(e.target.value);
            setSaved(false);
          }}
          disabled={busy}
        />
      </label>
      <p className="muted small" id="server-desc-hint">
        <FormattedMessage id="server.desc.hint" />
      </p>
      <p id="server-desc-status" className="small">
        {tooManyLines ? (
          <span className="error" role="alert">
            <FormattedMessage id="server.desc.lines" />
          </span>
        ) : (
          length >= DESC_COUNT_FROM && (
            <span className={tooLong ? 'error' : 'muted'} dir="ltr" aria-live="polite">
              <FormattedMessage id="server.desc.counter" values={{ n: length }} />
            </span>
          )
        )}
      </p>
      {failure === 'update-needed' && <UpdateNeeded server={server} cap="server-meta-v1" />}
      {failure === 'other' && (
        <p className="error" role="alert">
          <FormattedMessage id="error.generic" />
        </p>
      )}
      <div className="actions">
        {saved && !dirty && (
          <span className="muted small" role="status">
            <FormattedMessage id="server.settings.saved" />
          </span>
        )}
        <span className="spacer" />
        {dirty && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setIcon(savedIcon);
              setDesc(savedDesc);
              setIconError(null);
              setFailure(null);
            }}
            disabled={busy}
          >
            <FormattedMessage id="server.settings.discard" />
          </button>
        )}
        <button type="submit" className="primary" disabled={!dirty || busy || tooLong || tooManyLines}>
          <FormattedMessage id={busy ? 'server.settings.saving' : failure ? 'common.retry' : 'server.settings.save'} />
        </button>
      </div>
    </form>
  );
}
