// G-78 path B (locked during a call, docs/design/app-lock.md §5): no reload,
// so the call's audio keeps going. The gate unmounts all the content, leaving
// only the call engine (CallEngineProvider, above the gate) and the overlay,
// so the DOM holds no message, member, server or channel text. The mic track
// goes off here; main has already muted me in the core. On unlock the store
// re-reads everything from the core (no events reached us while locked).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../app/App';
import { useStore } from '../app/store';
import { MicOffIcon, SpeakerIcon } from '../components/icons';
import { useCore } from '../core';
import { CallEngineProvider, useSharedCallEngine } from '../screens/shell/CallBar';
import { LockScreen } from './LockScreen';
import { takeNotice, useLockState } from './useLock';

export function LockGate({ children }: { children: ReactNode }) {
  return (
    <CallEngineProvider>
      <Gate>{children}</Gate>
    </CallEngineProvider>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const lock = useLockState();
  const store = useAppStore();
  const engine = useSharedCallEngine();
  const pathB = !!lock && lock.locked && lock.path === 'B';
  // Content stays unmounted until the store has re-synced after an unlock.
  const [content, setContent] = useState(!pathB);
  const wasB = useRef(false);

  useEffect(() => {
    if (pathB) {
      wasB.current = true;
      setContent(false);
      engine.setMicMuted(true);
      return;
    }
    if (!wasB.current) {
      setContent(true);
      return;
    }
    // Unlocked after path B: re-sync, then the app as it was, mic still off.
    wasB.current = false;
    let live = true;
    void store
      .init()
      .catch(() => {})
      .then(() => {
        if (!live) return;
        setContent(true);
        store.showFlash('lock.call.stillMuted');
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-call-mute]')?.focus());
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathB]);

  // After the 12 words turned the lock off (the page was reloaded).
  useEffect(() => {
    const notice = takeNotice();
    if (notice) store.showFlash(notice);
  }, [store]);

  if (pathB) return <CallLockOverlay lock={lock} />;
  return content ? <>{children}</> : null;
}

/** Path B: the lock screen over a call that goes on, with the count and Leave. */
function CallLockOverlay({ lock }: { lock: ReturnType<typeof useLockState> }) {
  const intl = useIntl();
  const store = useAppStore();
  const core = useCore();
  const count = useStore(store, (s) => s.call?.participants.length ?? 0);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Focus stays in the overlay: Tab cycles through its controls only.
  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !root.current) return;
    const items = [...root.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const card = (
    <section className="lock-call" aria-label={intl.formatMessage({ id: 'lock.call.inCall' }, { count })}>
      <p className="lock-call-line">
        <span>
          <SpeakerIcon />
          <FormattedMessage id="lock.call.inCall" values={{ count }} />
        </span>
        <span>
          <MicOffIcon />
          <FormattedMessage id="lock.call.micOff" />
        </span>
      </p>
      <button
        type="button"
        className="lock-leave"
        disabled={leaving}
        onClick={() => {
          // No confirmation: leaving is the safe way out. Main then reloads to the plain lock screen.
          setLeaving(true);
          void core.leaveCall().catch(() => setLeaving(false));
        }}
      >
        <FormattedMessage id="lock.call.leave" />
      </button>
    </section>
  );

  return (
    <div ref={root} className="lock-overlay" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: 'lock.title' })} onKeyDown={trap}>
      <LockScreen lock={lock} call={card} />
    </div>
  );
}
