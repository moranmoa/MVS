// G-78 path A: main reloaded the page into ?locked (or ?locked=pending at
// start). The store never loads here: main refuses everything but getAppInfo.
import { useEffect, useState } from 'react';
import { useCore } from '../core';
import { LockLoading, LockScreen } from './LockScreen';
import { useLockState } from './useLock';

export function LockPage({ pending }: { pending: boolean }) {
  const lock = useLockState();
  const core = useCore();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    core
      .getAppInfo()
      .then((info) => live && setVersion(typeof info?.version === 'string' ? info.version.slice(0, 32) : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [core]);
  if (lock ? lock.pending : pending) return <LockLoading />;
  // QA (voice-e2e, dcc1e48): main says the lock is open, so this page is
  // stale and main loads the right one; never ask for a passcode nobody set.
  if (lock && !lock.locked) return <LockLoading />;
  return <LockScreen lock={lock} version={version} />;
}
