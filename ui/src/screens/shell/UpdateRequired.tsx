// #577 / #622 (docs/ux/specs/update-required.md §1–3): my running version was
// revoked, so main allows only reads and the update. The app stays open on its
// own content, read-only, under a banner with no close and no "later".

import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { isCoreError, useCore } from '../../core';
import { RefreshIcon } from '../../components/icons';

/** The hidden reason every disabled control points at (aria-describedby). */
export const UPDATE_REASON_ID = 'update-required-reason';

/** Re-check every 15 minutes while nothing is staged ("not available yet" keeps checking). */
const RECHECK_MS = 15 * 60_000;

/** Is a required update pending? Everything that writes or connects is off then. */
export function useUpdateRequired(): boolean {
  return useStore(useAppStore(), (s) => s.gate?.required === true);
}

/**
 * Props for a control that writes or connects: while an update is required it
 * stays in place and focusable, with `aria-disabled` and the reason on hover
 * and focus, and a click does nothing.
 */
export function useReadOnlyProps() {
  const required = useUpdateRequired();
  const intl = useIntl();
  if (!required) return {};
  const block = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return {
    'aria-disabled': true as const,
    'aria-describedby': UPDATE_REASON_ID,
    title: intl.formatMessage({ id: 'update.required.disabled' }),
    onClickCapture: block,
  };
}

type Line = 'downloading' | 'ready' | 'offline' | 'checkClock' | 'notAvailable' | 'failed';

/** The window's own close (the desktop app quits with its last window). */
function quit() {
  const b = window.mvs as unknown as { windowControl?: (a: 'close') => Promise<boolean> } | undefined;
  if (typeof b?.windowControl === 'function') void b.windowControl('close');
  else window.close();
}

export function UpdateRequiredBanner() {
  const store = useAppStore();
  const core = useCore();
  const intl = useIntl();
  const gate = useStore(store, (s) => s.gate);
  const staged = useStore(store, (s) => s.update);
  const check = useStore(store, (s) => s.updateCheck);
  const checking = useStore(store, (s) => s.checkingUpdate);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    core
      .getAppInfo()
      .then((i) => live && setRunning(i.version))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [core]);

  // Until something is staged: a check now, then every 15 minutes (main throttles to 30 s).
  const required = gate?.required === true;
  useEffect(() => {
    if (!required || staged) return;
    void store.checkUpdate();
    const t = setInterval(() => void store.checkUpdate(), RECHECK_MS);
    return () => clearInterval(t);
  }, [required, staged, store]);

  if (!required) return null;

  const line: Line = staged
    ? 'ready'
    : check === 'offline'
      ? 'offline'
      : check === 'check-clock'
        ? 'checkClock'
        : check === 'failed'
          ? 'failed'
          : !gate.version
            ? 'notAvailable'
            : 'downloading';
  const canRetry = line === 'offline' || line === 'checkClock' || line === 'failed';

  return (
    <section className="banner update-required" aria-labelledby="update-required-title">
      <RefreshIcon />
      <div className="update-required-text">
        <p role="status" id="update-required-title" className="update-required-title">
          <FormattedMessage id="update.required.title" />
        </p>
        <p>
          <FormattedMessage id="update.required.body" />
        </p>
        <p className="update-required-line">
          <FormattedMessage id={`update.required.${line}`} />
        </p>
        {running && gate.version && (
          <details className="update-required-details">
            <summary>
              <FormattedMessage id="update.required.details" />
            </summary>
            <bdi dir="ltr">{`${running} → ${gate.version}`}</bdi>
          </details>
        )}
        <span id={UPDATE_REASON_ID} hidden>
          {intl.formatMessage({ id: 'update.required.disabled' })}
        </span>
      </div>
      <div className="update-required-actions">
        {(line === 'downloading' || line === 'ready') && (
          <button
            type="button"
            className="primary small"
            disabled={line !== 'ready'}
            onClick={() => core.restartToUpdate().catch((e) => isCoreError(e) && store.updateRefused(e.code))}
          >
            <FormattedMessage id="update.required.update" />
          </button>
        )}
        {canRetry && (
          <button type="button" className="secondary small" disabled={checking} onClick={() => void store.checkUpdate()}>
            <FormattedMessage id="update.required.retry" />
          </button>
        )}
        <button type="button" className="secondary small" onClick={quit}>
          <FormattedMessage id="update.required.quit" />
        </button>
      </div>
    </section>
  );
}
