// G-78: Settings → Privacy → App lock (docs/ux/specs/app-lock.md §4–§5).
// Desktop app only: the settings go to main (lock:config / lock:set /
// lock:clear), which checks them, asks the core and re-reads its own config.
// The core checks `current`: a wrong one counts as an attempt.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Dialog } from '../components/common';
import { clearAppLock, desktopPlatform, getLockConfig, lockNow, setAppLock, type LockChangeResult, type LockConfig } from '../core/ipc';
import { LockIcon } from './LockScreen';
import { formatWait, useLockState } from './useLock';
import './lock.css';

const IDLE_CHOICES = [1, 5, 15, 30, 60];

/** A new passcode the core will take: 4–12 digits, or a phrase of 6–64 characters (no spaces at the ends). */
export function newPasscodeProblem(v: string): 'tooShort' | 'tooLong' | 'spaces' | null {
  const s = v.normalize('NFC');
  const n = [...s].length;
  if (s.trim() !== s) return 'spaces';
  if (/^\d+$/.test(s)) return n < 4 ? 'tooShort' : n > 12 ? 'tooLong' : null;
  return n < 6 ? 'tooShort' : n > 64 ? 'tooLong' : null;
}

type Ask = { kind: 'current'; then: (current: string) => void } | { kind: 'new'; current?: string };

export function AppLockSection() {
  const intl = useIntl();
  const [config, setConfig] = useState<LockConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The current passcode, asked once per visit to this page (spec §4), kept in memory only.
  const current = useRef<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [error, setError] = useState<LockChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const os = desktopPlatform();

  const reload = async () => {
    setConfig(await getLockConfig());
    setLoaded(true);
  };
  useEffect(() => {
    void reload();
    return () => {
      current.current = null;
    };
  }, []);

  if (!loaded || !config) return null; // not the desktop app (or not available now)

  const withCurrent = (then: (c: string) => void) => {
    if (current.current) then(current.current);
    else setAsk({ kind: 'current', then });
  };

  const apply = async (run: () => Promise<LockChangeResult>, usedCurrent?: string) => {
    setBusy(true);
    setError(null);
    const res = await run();
    setBusy(false);
    if (res.result === 'ok') {
      await reload();
      return true;
    }
    if (res.result === 'wrong' && usedCurrent !== undefined) current.current = null;
    setError(res);
    return false;
  };

  const change = (patch: Partial<Pick<LockConfig, 'idleMinutes' | 'lockOnSleep'>>) =>
    withCurrent((c) => {
      void apply(() => setAppLock({ current: c, passcode: c, idleMinutes: patch.idleMinutes ?? config.idleMinutes, lockOnSleep: patch.lockOnSleep ?? config.lockOnSleep }), c);
    });

  return (
    <div className="stack app-lock-settings">
      <label className="switch-row">
        <span>
          <FormattedMessage id="settings.lock.title" />
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={config.enabled}
          disabled={busy}
          onChange={() => {
            setError(null);
            if (!config.enabled) setAsk({ kind: 'new' });
            else
              withCurrent((c) => {
                void apply(() => clearAppLock(c), c).then((ok) => ok && (current.current = null));
              });
          }}
        />
      </label>
      {config.enabled && (
        <>
          <label className="field">
            <FormattedMessage id="settings.lock.idle" />
            <select value={config.idleMinutes} disabled={busy} onChange={(e) => change({ idleMinutes: Number(e.target.value) })}>
              {IDLE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {intl.formatMessage({ id: 'settings.lock.idleMinutes' }, { n })}
                </option>
              ))}
            </select>
            <span className="muted small">
              <FormattedMessage id="settings.lock.idleHint" />
            </span>
          </label>
          <label className="switch-row">
            <span>
              <FormattedMessage id="settings.lock.onSleep" />
            </span>
            <input type="checkbox" role="switch" className="switch" checked={config.lockOnSleep} disabled={busy} onChange={() => change({ lockOnSleep: !config.lockOnSleep })} />
          </label>
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => withCurrent((c) => setAsk({ kind: 'new', current: c }))}>
              <FormattedMessage id="settings.lock.change" />
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void lockNow()}>
              <LockIcon />
              <FormattedMessage id="lock.now" />
            </button>
          </div>
          <p className="muted small lock-disclaimer">
            <FormattedMessage id={os === 'darwin' ? 'settings.lock.disclaimerMac' : os === 'linux' ? 'settings.lock.disclaimerLinux' : 'settings.lock.disclaimer'} />
          </p>
          <p className="muted small lock-disclaimer">
            <FormattedMessage id="settings.lock.disclaimerCall" />
          </p>
        </>
      )}
      {error && <ChangeError result={error} />}
      {ask?.kind === 'current' && (
        <CurrentDialog
          onCancel={() => setAsk(null)}
          onDone={(c) => {
            current.current = c;
            const then = ask.then;
            setAsk(null);
            then(c);
          }}
        />
      )}
      {ask?.kind === 'new' && (
        <SetDialog
          onCancel={() => setAsk(null)}
          onSave={async (passcode) => {
            const usedCurrent = ask.current;
            const ok = await apply(
              () => setAppLock({ ...(usedCurrent ? { current: usedCurrent } : {}), passcode, idleMinutes: config.idleMinutes, lockOnSleep: config.lockOnSleep }),
              usedCurrent,
            );
            if (ok) {
              current.current = passcode;
              setAsk(null);
            }
            return ok;
          }}
        />
      )}
    </div>
  );
}

function ChangeError({ result }: { result: LockChangeResult }) {
  if (result.result === 'rate-limited' || (result.result === 'wrong' && result.retryAfter)) {
    return (
      <p className="error" role="alert">
        <FormattedMessage id="lock.rateLimited" values={{ time: formatWait(result.retryAfter ?? 0) }} />
      </p>
    );
  }
  return (
    <p className="error" role="alert">
      <FormattedMessage id={result.result === 'wrong' ? 'lock.wrong' : 'error.generic'} />
    </p>
  );
}

/** Asks for the current passcode; the core checks it with the change itself. */
function CurrentDialog({ onCancel, onDone }: { onCancel: () => void; onDone: (current: string) => void }) {
  const intl = useIntl();
  const [value, setValue] = useState('');
  return (
    <Dialog open onClose={onCancel} title={intl.formatMessage({ id: 'settings.lock.current' })}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onDone(value);
        }}
      >
        <label className="field">
          <FormattedMessage id="settings.lock.current" />
          <input type="password" dir="ltr" autoFocus autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={!value}>
            <FormattedMessage id="common.next" />
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Set a passcode": new and again; checked here first, then by the core. */
function SetDialog({ onCancel, onSave }: { onCancel: () => void; onSave: (passcode: string) => Promise<boolean> }) {
  const intl = useIntl();
  const [first, setFirst] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const errId = useId();
  const againErrId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = newPasscodeProblem(first);
    setProblem(p);
    setMismatch(!p && first !== again);
    if (p || first !== again) return;
    setBusy(true);
    const ok = await onSave(first.normalize('NFC'));
    setBusy(false);
    if (!ok) {
      setFirst('');
      setAgain('');
    }
  };

  return (
    <Dialog open onClose={onCancel} title={intl.formatMessage({ id: 'settings.lock.set.title' })}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <FormattedMessage id="settings.lock.set.new" />
          <input
            type="password"
            dir="ltr"
            autoFocus
            autoComplete="new-password"
            value={first}
            aria-invalid={!!problem || undefined}
            aria-describedby={[hintId, problem ? errId : ''].filter(Boolean).join(' ')}
            onChange={(e) => {
              setFirst(e.target.value);
              setProblem(null);
            }}
          />
          <span id={hintId} className="muted small">
            <FormattedMessage id="settings.lock.set.hint" />
          </span>
          {problem && (
            <span id={errId} className="error small" role="alert">
              <FormattedMessage id={`settings.lock.set.${problem}`} />
            </span>
          )}
        </label>
        <label className="field">
          <FormattedMessage id="settings.lock.set.confirm" />
          <input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={again}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? againErrId : undefined}
            onChange={(e) => {
              setAgain(e.target.value);
              setMismatch(false);
            }}
          />
          {mismatch && (
            <span id={againErrId} className="error small" role="alert">
              <FormattedMessage id="settings.lock.set.mismatch" />
            </span>
          )}
        </label>
        <p className="muted small">
          <FormattedMessage id="settings.lock.set.forgotNote" />
        </p>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            <FormattedMessage id="settings.lock.set.save" />
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Lock now" beside my settings button, only when the lock is on. */
export function LockNowButton() {
  const intl = useIntl();
  const lock = useLockState();
  if (!lock?.enabled) return null;
  const label = `${intl.formatMessage({ id: 'lock.now' })} (Ctrl+L)`;
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={() => void lockNow()}>
      <LockIcon />
    </button>
  );
}
