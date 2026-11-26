// G-52 (docs/ux/specs/server-age-limit.md, #578): the server's age limit,
// editable by its owner. The PO's rule from G-77: never open 18+ content to
// minors silently. "No limit" and "16+" let in the same people (the app's
// minimum is 16), so moving between them needs nothing more; raising to 18+
// and lowering from it each need their own confirmation, and cancelling saves
// nothing. An owner under 18 can't choose 18+ (the core refuses it too).
// 18+ channels keep their own keys and members either way (B7-k).
//
// G-51n: a section of the General page's one "Save". The page asks confirm()
// first (the raise or lower dialog); cancelling saves nothing on the page.

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { ageOn } from '../../app/age';
import { useStore } from '../../app/store';
import { Dialog } from '../../components/common';
import { isCoreError, useCore, type AgeRestriction, type ServerSummary } from '../../core';
import { failureOf, FailureNote, type Failure } from './ServerLifecycle';
import './ageLimit.css';
import type { SectionHandle, SectionState } from './generalDraft';

const OPTIONS: AgeRestriction[] = ['none', '16+', '18+'];
const key = (a: AgeRestriction) => (a === 'none' ? 'none' : a.slice(0, 2));

/** Which confirmation a change needs: none between "no limit" and 16+, else raise or lower. */
export function ageChangeKind(from: AgeRestriction, to: AgeRestriction): 'none' | 'raise' | 'lower' {
  if (from === to) return 'none';
  if (to === '18+') return 'raise';
  if (from === '18+') return 'lower';
  return 'none';
}

export const AgeLimitSetting = forwardRef<SectionHandle, { server: ServerSummary; onState: (s: SectionState) => void }>(function AgeLimitSetting(
  { server, onState },
  ref,
) {
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
  // PO (0.6.0): raising names how many members lose access (the core's count; no names).
  const [affected, setAffected] = useState<number | null>(null);
  useEffect(() => {
    if (confirm !== 'raise') return;
    let live = true;
    setAffected(null);
    core.countAgeAffected(server.id, '18+').then(
      (r) => live && setAffected(r.count),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [confirm, core, server.id]);
  const [tooYoung, setTooYoung] = useState(false);
  const checkId = useId();
  // UX on #591: each dialog is described by its explanation (and the count), read with focus on "Cancel".
  const raiseBodyId = useId();
  const raiseCountId = useId();
  const lowerBodyId = useId();

  const dirty = age !== server.ageRestriction;
  useEffect(() => onState({ dirty, invalid: false }), [dirty, onState]);

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    setBusy(true);
    setFailure(null);
    setTooYoung(false);
    try {
      await core.setAgeRestriction(server.id, age);
      return true;
    } catch (e) {
      // A bad request here isn't about a name: the general message.
      const f = failureOf(e);
      if (isCoreError(e) && e.code === 'too-young') setTooYoung(true);
      else setFailure(f.kind === 'bad-name' ? { kind: 'other' } : f);
      return false;
    } finally {
      setBusy(false);
    }
  };
  // The open confirmation's answer, for the page's Save.
  const answer = useRef<((ok: boolean) => void) | null>(null);
  const settle = (ok: boolean) => {
    setConfirm(null);
    answer.current?.(ok);
    answer.current = null;
  };
  const askConfirm = (): Promise<boolean> => {
    const kind = ageChangeKind(server.ageRestriction, age);
    if (kind === 'none') return Promise.resolve(true);
    setChecked(false);
    setConfirm(kind);
    return new Promise((resolve) => (answer.current = resolve));
  };
  // Cancelling the confirmation saves nothing: the choice goes back to the saved limit.
  const cancel = () => {
    setAge(server.ageRestriction);
    settle(false);
  };
  useImperativeHandle(ref, () => ({
    confirm: askConfirm,
    save,
    discard: () => {
      setAge(server.ageRestriction);
      setFailure(null);
      setTooYoung(false);
    },
  }));

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
      <FailureNote server={server} failure={failure} />
      {tooYoung && (
        <p className="error small" role="alert">
          <FormattedMessage id="server.age.ownerMinor" />
        </p>
      )}

      <Dialog
        open={confirm === 'raise'}
        onClose={cancel}
        title={intl.formatMessage({ id: 'server.age.raise.title' })}
        describedBy={`${raiseBodyId} ${raiseCountId}`}
      >
        <p id={raiseBodyId}>
          <FormattedMessage id="server.age.raise.body" />
        </p>
        <p id={raiseCountId} role="status" className="age-affected">
          {affected !== null && <FormattedMessage id="server.age.raise.count" values={{ count: affected }} />}
        </p>
        <div className="actions">
          <button type="button" className="danger" onClick={() => settle(true)}>
            <FormattedMessage id="server.age.raise.confirm" />
          </button>
          <button ref={cancelRef} type="button" className="secondary" onClick={cancel}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </Dialog>

      <Dialog open={confirm === 'lower'} onClose={cancel} title={intl.formatMessage({ id: 'server.age.lower.title' })} describedBy={lowerBodyId}>
        <p id={lowerBodyId}>
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
            onClick={() => checked && settle(true)}
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
});
