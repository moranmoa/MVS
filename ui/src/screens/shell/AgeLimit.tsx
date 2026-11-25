// G-52 (docs/ux/specs/server-age-limit.md, #578): the server's age limit,
// editable by its owner. The PO's rule from G-77: never open 18+ content to
// minors silently. "No limit" and "16+" let in the same people (the app's
// minimum is 16), so moving between them needs nothing more; raising to 18+
// and lowering from it each need their own confirmation, and cancelling saves
// nothing. An owner under 18 can't choose 18+ (the core refuses it too).
// 18+ channels keep their own keys and members either way (B7-k).
//
// Until G-51's page-wide "Save" exists, this section saves with its own button.

import { useEffect, useId, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { ageOn } from '../../app/age';
import { useStore } from '../../app/store';
import { Dialog } from '../../components/common';
import { useCore, type AgeRestriction, type ServerSummary } from '../../core';
import { failureOf, FailureNote, type Failure } from './ServerLifecycle';
import './ageLimit.css';

const OPTIONS: AgeRestriction[] = ['none', '16+', '18+'];
const key = (a: AgeRestriction) => (a === 'none' ? 'none' : a.slice(0, 2));

/** Which confirmation a change needs: none between "no limit" and 16+, else raise or lower. */
export function ageChangeKind(from: AgeRestriction, to: AgeRestriction): 'none' | 'raise' | 'lower' {
  if (from === to) return 'none';
  if (to === '18+') return 'raise';
  if (from === '18+') return 'lower';
  return 'none';
}

export function AgeLimitSetting({ server }: { server: ServerSummary }) {
  const core = useCore();
  const intl = useIntl();
  const store = useAppStore();
  const birthDate = useStore(store, (s) => s.identity?.birthDate);
  const ownerMinor = !!birthDate && ageOn(birthDate) < 18;
  const [age, setAge] = useState<AgeRestriction>(server.ageRestriction);
  useEffect(() => setAge(server.ageRestriction), [server.ageRestriction]);
  const [confirm, setConfirm] = useState<'raise' | 'lower' | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const minorId = useId();
  // The spec: each confirmation opens with focus on "Cancel". The dialog's
  // showModal runs after mount and would move it to the close button.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => cancelRef.current?.focus());
    return () => clearTimeout(t);
  }, [confirm]);
  const checkId = useId();

  const save = async () => {
    setConfirm(null);
    setBusy(true);
    setFailure(null);
    setSaved(false);
    try {
      await core.setAgeRestriction(server.id, age);
      setSaved(true);
    } catch (e) {
      // A bad request here isn't about a name: the general message.
      const f = failureOf(e);
      setFailure(f.kind === 'bad-name' ? { kind: 'other' } : f);
    } finally {
      setBusy(false);
    }
  };
  const onSave = () => {
    const kind = ageChangeKind(server.ageRestriction, age);
    if (kind === 'none') return void save();
    setChecked(false);
    setConfirm(kind);
  };
  // Cancelling the confirmation saves nothing: the choice goes back to the saved limit.
  const cancel = () => {
    setConfirm(null);
    setAge(server.ageRestriction);
  };

  return (
    <div className="stack age-limit">
      <fieldset className="radio-group" aria-describedby={ownerMinor ? minorId : undefined}>
        <legend>
          <FormattedMessage id="server.settings.age" />
        </legend>
        {OPTIONS.map((a) => {
          const disabled = busy || (a === '18+' && ownerMinor);
          return (
            <label key={a} className={`radio${disabled ? ' disabled' : ''}`}>
              <input
                type="radio"
                name={`age-${server.id}`}
                value={a}
                checked={age === a}
                disabled={disabled}
                onChange={() => {
                  setAge(a);
                  setSaved(false);
                  setFailure(null);
                }}
              />
              <FormattedMessage id={`create.age.${key(a)}`} />
            </label>
          );
        })}
        {ownerMinor && (
          <p className="muted small" id={minorId}>
            <FormattedMessage id="server.age.ownerMinor" />
          </p>
        )}
      </fieldset>
      <div className="actions">
        <button type="button" className="primary" disabled={busy || age === server.ageRestriction} onClick={onSave}>
          <FormattedMessage id="server.age.save" />
        </button>
        {saved && (
          <span className="success small" role="status">
            <FormattedMessage id="server.age.saved" />
          </span>
        )}
      </div>
      <FailureNote server={server} failure={failure} />

      <Dialog open={confirm === 'raise'} onClose={cancel} title={intl.formatMessage({ id: 'server.age.raise.title' })}>
        <p>
          <FormattedMessage id="server.age.raise.body" />
        </p>
        <div className="actions">
          <button type="button" className="danger" onClick={() => void save()}>
            <FormattedMessage id="server.age.raise.confirm" />
          </button>
          <button ref={cancelRef} type="button" className="secondary" onClick={cancel}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </Dialog>

      <Dialog open={confirm === 'lower'} onClose={cancel} title={intl.formatMessage({ id: 'server.age.lower.title' })}>
        <p>
          <FormattedMessage id="server.age.lower.body" />
        </p>
        <label className="checkbox-row">
          <input id={checkId} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>
            <FormattedMessage id="server.age.lower.check" />
          </span>
        </label>
        <div className="actions">
          <button
            type="button"
            className="primary"
            aria-disabled={!checked || undefined}
            aria-describedby={checkId}
            onClick={() => checked && void save()}
          >
            <FormattedMessage id="server.age.lower.confirm" />
          </button>
          <button ref={cancelRef} type="button" className="secondary" onClick={cancel}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </Dialog>
    </div>
  );
}
