// G-78: the lock screen (docs/ux/specs/app-lock.md §1–§3). The same panel
// serves path A (the page reloaded into ?locked), "Loading…" at start
// (?locked=pending) and path B's overlay during a call (with the call card).
// Nothing personal is on it: no name, avatar, server, count or message text.
import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import logo from '../assets/mvs-logo.svg';
import { unlockApp, type LockState } from '../core/ipc';
import { formatWait, leaveNotice, useCountdown, useWaitUntil } from './useLock';
import './lock.css';

/** The shortest a "Checking…" shows, so a fast answer doesn't flash. */
const MIN_CHECK_MS = 300;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

/** "Loading…" until main knows whether the lock is on: looks like a normal start. */
export function LockLoading() {
  return (
    <main className="lock-screen" aria-busy="true">
      <div className="lock-column">
        <img className="lock-logo" src={logo} alt="" width={64} height={64} />
        <p role="status">
          <FormattedMessage id="lock.loading" />
        </p>
      </div>
    </main>
  );
}

/**
 * The lock screen. `call` is path B's call card (above the field); `version`
 * the app version shown small at the bottom.
 */
export function LockScreen({ lock, call, version }: { lock: LockState | null; call?: ReactNode; version?: string | null }) {
  const [words, setWords] = useState(false);
  const titleId = useId();
  return (
    <main className="lock-screen" aria-labelledby={titleId}>
      <div className="lock-column">
        <img className="lock-logo" src={logo} alt="" width={64} height={64} />
        <h1 id={titleId}>
          <FormattedMessage id={words ? 'lock.words.title' : 'lock.title'} />
        </h1>
        {call}
        {words ? <WordsForm lock={lock} onBack={() => setWords(false)} /> : <PasscodeForm lock={lock} onForgot={() => setWords(true)} />}
      </div>
      {version && (
        <p className="lock-version muted small" dir="ltr">
          {version}
        </p>
      )}
    </main>
  );
}

/** The retry delay: the text counts down; only its start and end are announced. */
function useRateLimit(lock: LockState | null) {
  const until = useWaitUntil(lock);
  const left = useCountdown(until);
  const [announce, setAnnounce] = useState('');
  const was = useRef(false);
  const intl = useIntl();
  useEffect(() => {
    const now = left > 0;
    if (now && !was.current) setAnnounce('');
    if (!now && was.current) setAnnounce(intl.formatMessage({ id: 'lock.retryNow' }));
    was.current = now;
  }, [left, intl]);
  return { left, announce };
}

function PasscodeForm({ lock, onForgot }: { lock: LockState | null; onForgot: () => void }) {
  const intl = useIntl();
  const [value, setValue] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const { left, announce } = useRateLimit(lock);
  const limited = left > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || limited || !value) return;
    setBusy(true);
    setWrong(false);
    const [result] = await Promise.all([unlockApp({ passcode: value }), wait(MIN_CHECK_MS)]);
    if (result === 'ok') return; // main reloads (A) or lifts the overlay (B)
    setBusy(false);
    setValue('');
    setWrong(result === 'wrong' || result === 'invalid');
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <form className="lock-form" onSubmit={submit}>
      <div className="lock-field">
        <input
          ref={input}
          type={shown ? 'text' : 'password'}
          dir="ltr"
          autoFocus
          autoComplete="current-password"
          inputMode={/^\d+$/.test(value) ? 'numeric' : undefined}
          aria-label={intl.formatMessage({ id: 'lock.passcode' })}
          aria-invalid={wrong || undefined}
          aria-describedby={wrong || limited ? errorId : undefined}
          value={value}
          disabled={limited}
          onChange={(e) => {
            setValue(e.target.value);
            setWrong(false);
          }}
        />
        <button
          type="button"
          className="icon-button"
          aria-pressed={shown}
          aria-label={intl.formatMessage({ id: shown ? 'lock.hide' : 'lock.show' })}
          title={intl.formatMessage({ id: shown ? 'lock.hide' : 'lock.show' })}
          onClick={() => setShown((s) => !s)}
        >
          <EyeIcon off={shown} />
        </button>
      </div>
      {wrong && !limited && (
        <p id={errorId} className="error lock-error" role="alert">
          <ErrorMark />
          <FormattedMessage id="lock.wrong" />
        </p>
      )}
      {limited && (
        <p id={errorId} className="error lock-error">
          <ErrorMark />
          <FormattedMessage id="lock.rateLimited" values={{ time: formatWait(left) }} />
        </p>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      <button type="submit" className="primary lock-submit" disabled={busy || limited}>
        <FormattedMessage id={busy ? 'lock.checking' : 'lock.unlock'} />
      </button>
      <button type="button" className="link lock-forgot" onClick={onForgot}>
        <FormattedMessage id="lock.forgot" />
      </button>
    </form>
  );
}

function ErrorMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5v.5" />
    </svg>
  );
}

/** Forgot: the 12 words turn the lock off (the core checks them, same attempt counter). */
function WordsForm({ lock, onBack }: { lock: LockState | null; onBack: () => void }) {
  const intl = useIntl();
  const [words, setWords] = useState<string[]>(() => Array(12).fill(''));
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const { left, announce } = useRateLimit(lock);
  const limited = left > 0;

  const setWord = (i: number, v: string) => {
    setWrong(false);
    setWords((w) => w.map((x, j) => (j === i ? v : x)));
  };
  // Pasting several words fills the following boxes too (as on restore).
  const onPaste = (i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const parts = e.clipboardData.getData('text').trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) return;
    e.preventDefault();
    setWrong(false);
    setWords((w) => w.map((x, j) => (j >= i && j - i < parts.length ? parts[j - i].toLowerCase() : x)));
    inputs.current[Math.min(11, i + parts.length - 1)]?.focus();
    void navigator.clipboard?.writeText('').catch(() => undefined);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || limited) return;
    if (words.some((w) => !w.trim())) {
      inputs.current[words.findIndex((w) => !w.trim())]?.focus();
      return;
    }
    setBusy(true);
    setWrong(false);
    leaveNotice('lock.words.done'); // shown after main reloads us unlocked
    const [result] = await Promise.all([unlockApp({ words: words.join(' ') }), wait(MIN_CHECK_MS)]);
    if (result === 'ok') return;
    leaveNotice('');
    setBusy(false);
    setWrong(result === 'wrong' || result === 'invalid');
  };

  return (
    <form className="lock-form lock-words" onSubmit={submit}>
      <p className="muted">
        <FormattedMessage id="lock.words.body" />
      </p>
      <ol className="word-grid word-inputs" dir="ltr">
        {words.map((w, i) => (
          <li key={i}>
            <span className="word-num" aria-hidden="true">
              {i + 1}
            </span>
            <input
              ref={(el) => {
                inputs.current[i] = el;
              }}
              value={w}
              autoFocus={i === 0}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={limited}
              aria-label={intl.formatMessage({ id: 'restore.word' }, { n: i + 1 })}
              aria-invalid={wrong || undefined}
              onChange={(e) => setWord(i, e.target.value.trim().toLowerCase())}
              onPaste={onPaste(i)}
            />
          </li>
        ))}
      </ol>
      {wrong && !limited && (
        <p className="error lock-error" role="alert">
          <ErrorMark />
          <FormattedMessage id="lock.words.wrong" />
        </p>
      )}
      {limited && (
        <p className="error lock-error">
          <ErrorMark />
          <FormattedMessage id="lock.rateLimited" values={{ time: formatWait(left) }} />
        </p>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || limited}>
          <FormattedMessage id={busy ? 'lock.checking' : 'lock.unlock'} />
        </button>
        <button type="button" className="secondary" onClick={onBack}>
          <FormattedMessage id="common.back" />
        </button>
      </div>
    </form>
  );
}
