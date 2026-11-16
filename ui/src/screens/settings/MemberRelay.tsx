// Member relays, slice 1 (design #368, member-relays-slice1.md): the Settings →
// Privacy toggle, and the one-time disclosure the first time relaying is on.

import { useEffect, useId, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { Dialog } from '../../components/common';
import { useCore, type MemberRelaySetting } from '../../core';

const REASON_TEXT = {
  minor: 'memberRelay.reason.minor',
  'relay-only': 'memberRelay.reason.relayOnly',
  metered: 'memberRelay.reason.metered',
  'global-off': 'memberRelay.reason.globalOff',
} as const;

/** "Relay for your members is on": OK acknowledges it, Turn off sets "off". */
export function MemberRelayDisclosure({ open, onClose }: { open: boolean; onClose: () => void }) {
  const core = useCore();
  const store = useAppStore();
  const intl = useIntl();
  const bodyId = useId();
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) okRef.current?.focus();
  }, [open]);
  const finish = async (turnOff: boolean) => {
    onClose();
    try {
      if (turnOff) store.setMemberRelay(await core.setMemberRelay('off'));
      await core.markMemberRelayDisclosureSeen();
      const now = store.getState().memberRelay;
      if (now) store.setMemberRelay({ ...now, disclosureSeen: true });
    } catch {
      store.showFlash('error.generic');
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={intl.formatMessage({ id: 'memberRelay.disclosure.title' })} describedBy={bodyId} className="member-relay-disclosure">
      <p id={bodyId}>
        <FormattedMessage id="memberRelay.disclosure.body" values={{ quota: '2 GB' }} />
      </p>
      <div className="actions">
        <button type="button" className="primary" ref={okRef} onClick={() => void finish(false)}>
          <FormattedMessage id="memberRelay.disclosure.ok" />
        </button>
        <button type="button" className="secondary" onClick={() => void finish(true)}>
          <FormattedMessage id="memberRelay.disclosure.turnOff" />
        </button>
      </div>
    </Dialog>
  );
}

/** At start or on a change: the disclosure, once, the first time relaying is on. */
export function MemberRelayFirstRun() {
  const store = useAppStore();
  const due = useStore(store, (s) => !!s.memberRelay?.effective && !s.memberRelay.disclosureSeen);
  const [dismissed, setDismissed] = useState(false);
  return <MemberRelayDisclosure open={due && !dismissed} onClose={() => setDismissed(true)} />;
}

/** Settings → Privacy: the toggle shows what is on now; a reason turns it off and says why. */
export function MemberRelaySetting() {
  const store = useAppStore();
  const core = useCore();
  const relay = useStore(store, (s) => s.memberRelay);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [explain, setExplain] = useState(false);
  if (!relay) return null;
  const set = async (setting: MemberRelaySetting) => {
    setBusy(true);
    setFailed(false);
    try {
      store.setMemberRelay(await core.setMemberRelay(setting));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const blocked = !!relay.reason;
  return (
    <div className="stack member-relay">
      <label className="switch-row">
        <span>
          <FormattedMessage id="memberRelay.label" />
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={relay.effective}
          disabled={busy || blocked}
          aria-describedby={`member-relay-hint${blocked ? ' member-relay-reason' : ''}`}
          onChange={(e) => void set(e.target.checked ? 'on' : 'off')}
        />
      </label>
      {blocked && (
        <p id="member-relay-reason" className="muted small">
          <FormattedMessage id={REASON_TEXT[relay.reason!]} />
          {relay.reason === 'relay-only' && (
            <>
              {' '}
              <button type="button" className="link small" onClick={() => store.openSettings('privacy')}>
                <FormattedMessage id="privacy.relayOnly.open" />
              </button>
            </>
          )}
        </p>
      )}
      <p id="member-relay-hint" className="muted small">
        <FormattedMessage id={relay.role ? 'memberRelay.hintRole' : 'memberRelay.hint'} />{' '}
        <button type="button" className="link small" onClick={() => setExplain(true)}>
          <FormattedMessage id="memberRelay.disclosure.show" />
        </button>
      </p>
      {relay.setting !== 'auto' && !blocked && (
        <button type="button" className="link small member-relay-default" disabled={busy} onClick={() => void set('auto')}>
          <FormattedMessage id="memberRelay.backToDefault" />
        </button>
      )}
      {failed && (
        <p className="error small" role="alert">
          <FormattedMessage id="invite.failed" />
        </p>
      )}
      <MemberRelayDisclosure open={explain} onClose={() => setExplain(false)} />
    </div>
  );
}
