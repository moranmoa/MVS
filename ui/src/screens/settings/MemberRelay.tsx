// Member relays, slice 1 (design #368, member-relays-slice1.md): the Settings →
// Privacy toggle, and the one-time disclosure the first time relaying is on.

import { useEffect, useId, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { Dialog } from '../../components/common';
import { useCore, type MemberRelay, type MemberRelaySetting } from '../../core';
import { MEMBER_RELAY_CAP_MAX_MB, MEMBER_RELAY_CAP_MIN_MB } from '../../core/sanitize';

/** The owner's choices for the daily limit (MB); 2 GB is the default. */
const CAPS = [1024, 2048, 5120, 10240, 20480];
const DEFAULT_CAP = 2048;

/** "2 GB", "512 MB", "2.5 GB". */
export function capText(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : Number(gb.toFixed(2))} GB`;
}

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
  const quota = useStore(store, (s) => s.memberRelay?.dailyCapMb ?? DEFAULT_CAP);
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
        <FormattedMessage id="memberRelay.disclosure.body" values={{ quota: capText(quota) }} />
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

/**
 * PO: relaying must not start before the disclosure was shown once, so the
 * core keeps `effective` false until it is acknowledged (any setting). The
 * toggle, the daily limit and the disclosure follow what the setting would
 * do: no reason, and "on", or "auto" for an owner or admin.
 */
export function wouldRelay(r: MemberRelay): boolean {
  return r.effective || (!r.reason && (r.setting === 'on' || (r.setting === 'auto' && r.role)));
}

/** At start or on a change: the disclosure, once, the first time relaying is (or would be) on. */
export function MemberRelayFirstRun() {
  const store = useAppStore();
  const due = useStore(store, (s) => !!s.memberRelay && wouldRelay(s.memberRelay) && !s.memberRelay.disclosureSeen);
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
          checked={wouldRelay(relay)}
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
      {wouldRelay(relay) && <DailyCap relay={relay} />}
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

/** Under the toggle while relaying: the daily limit, a preset or a custom number of GB. */
function DailyCap({ relay }: { relay: MemberRelay }) {
  const store = useAppStore();
  const core = useCore();
  const intl = useIntl();
  const preset = CAPS.includes(relay.dailyCapMb);
  const [custom, setCustom] = useState(!preset);
  const [gb, setGb] = useState(String(relay.dailyCapMb / 1024));
  const [failed, setFailed] = useState(false);
  const save = async (mb: number) => {
    setFailed(false);
    try {
      store.setMemberRelay(await core.setMemberRelayCap(mb));
    } catch {
      setFailed(true);
    }
  };
  const saveCustom = () => {
    const mb = Math.round(Number(gb) * 1024);
    if (!Number.isFinite(mb) || mb < MEMBER_RELAY_CAP_MIN_MB || mb > MEMBER_RELAY_CAP_MAX_MB) return setFailed(true);
    if (mb !== relay.dailyCapMb) void save(mb);
  };
  return (
    <div className="member-relay-cap">
      <label className="field">
        <span>
          <FormattedMessage id="memberRelay.cap" />
        </span>
        <select
          value={custom ? 'custom' : String(relay.dailyCapMb)}
          onChange={(e) => {
            if (e.target.value === 'custom') return setCustom(true);
            setCustom(false);
            void save(Number(e.target.value));
          }}
        >
          {CAPS.map((mb) => (
            <option key={mb} value={mb}>
              {mb === DEFAULT_CAP ? intl.formatMessage({ id: 'memberRelay.capDefault' }, { size: capText(mb) }) : capText(mb)}
            </option>
          ))}
          <option value="custom">{intl.formatMessage({ id: 'memberRelay.capCustom' })}</option>
        </select>
      </label>
      {custom && (
        <label className="field">
          <span>
            <FormattedMessage id="memberRelay.capCustomLabel" />
          </span>
          <input
            type="number"
            inputMode="decimal"
            dir="ltr"
            min={MEMBER_RELAY_CAP_MIN_MB / 1024}
            max={MEMBER_RELAY_CAP_MAX_MB / 1024}
            step={0.25}
            value={gb}
            aria-describedby="member-relay-cap-range"
            aria-invalid={failed || undefined}
            onChange={(e) => setGb(e.target.value)}
            onBlur={saveCustom}
            onKeyDown={(e) => e.key === 'Enter' && saveCustom()}
          />
        </label>
      )}
      <p id="member-relay-cap-range" className={failed ? 'error small' : 'muted small'} role={failed ? 'alert' : undefined}>
        <FormattedMessage id="memberRelay.capRange" />
      </p>
    </div>
  );
}
