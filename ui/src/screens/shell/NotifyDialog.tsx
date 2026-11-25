// G-61 with G-03 / G-17: "Notifications" from a server's or a channel's menu,
// the one place to set its level and its mute. Both stay on this computer:
// the level in settings.notify, the mute in app/mute.ts (store.mutes).

import { FormattedMessage } from 'react-intl';
import { useAppStore } from '../../app/App';
import { channelMuteKey, MUTE_DURATIONS, mutedUntil, serverMuteKey, type MuteDuration } from '../../app/mute';
import { defaultNotifyPrefs, reportsOn, withLevel, withReports, type NotifyLevel } from '../../app/notify';
import { useSettings } from '../../app/settings';
import { useStore } from '../../app/store';
import { Dialog, Name } from '../../components/common';
import type { Id } from '../../core';
import { useMutedLabel } from './MuteDialog';

/** `name` is the plain name; the channel title adds the # inside the isolate. */
export type NotifyTarget = { kind: 'server' | 'channel'; id: Id; name: string };

export function NotifyDialog({ target, onClose }: { target: NotifyTarget; onClose: () => void }) {
  const { kind, id, name } = target;
  const store = useAppStore();
  const { settings, update } = useSettings();
  const prefs = settings.notify ?? defaultNotifyPrefs();
  const key = kind === 'server' ? 'servers' : 'channels';
  // A channel can follow its server ('inherit') or choose its own level.
  const levels: (NotifyLevel | 'inherit')[] = kind === 'channel' ? ['inherit', 'all', 'mentions', 'none'] : ['all', 'mentions', 'none'];
  const level = prefs[key][id]?.level ?? (kind === 'channel' ? 'inherit' : 'mentions');
  const setLevel = (l: NotifyLevel | 'inherit') => update({ notify: withLevel(prefs, key, id, l === 'inherit' ? null : l) });

  // G-48 (PO): staff only, servers only: reports come through a mute and the
  // level "none"; this switch is the one way to silence them here.
  const staff = useStore(store, (s) => kind === 'server' && !!s.identity && s.servers.find((x) => x.id === id)?.ownerId === s.identity.id);

  const muteKey = kind === 'server' ? serverMuteKey(id) : channelMuteKey(id);
  const until = useStore(store, (s) => mutedUntil(s.mutes, muteKey));
  const mutedLabel = useMutedLabel();

  return (
    <Dialog
      open
      onClose={onClose}
      title={<FormattedMessage id={kind === 'server' ? 'notify.dialog.titleServer' : 'notify.dialog.titleChannel'} values={{ name: <Name>{name}</Name> }} />}
      className="notify-dialog"
    >
      <div className="stack">
        <fieldset className="radio-group">
          <legend>
            <FormattedMessage id="notify.menu" />
          </legend>
          {levels.map((l) => (
            <label key={l} className="radio">
              <input type="radio" name={`notify-level-${id}`} checked={level === l} onChange={() => setLevel(l)} />
              <FormattedMessage id={`notify.${l}`} />
            </label>
          ))}
        </fieldset>
        <fieldset className="radio-group">
          <legend>
            <FormattedMessage id="notify.mute.label" />
          </legend>
          {until !== null ? (
            <>
              <p role="status">{mutedLabel(until)}</p>
              <div className="actions">
                <button type="button" className="secondary" onClick={() => store.unmute(muteKey)}>
                  <FormattedMessage id="notify.unmute" />
                </button>
              </div>
            </>
          ) : (
            <div className="choice-list mute-choices">
              {(Object.keys(MUTE_DURATIONS) as MuteDuration[]).map((d) => (
                <button key={d} type="button" className="choice" onClick={() => store.mute(muteKey, d)}>
                  <FormattedMessage id={`notify.mute.${d}`} />
                </button>
              ))}
            </div>
          )}
        </fieldset>
        {staff && (
          <div className="stack-tight">
            <label className="switch-row">
              <span>
                <FormattedMessage id="notify.reports.label" />
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={reportsOn(prefs, id)}
                aria-describedby={`notify-reports-hint-${id}`}
                onChange={(e) => update({ notify: withReports(prefs, id, e.target.checked) })}
              />
            </label>
            <p id={`notify-reports-hint-${id}`} className="muted small">
              <FormattedMessage id="notify.reports.hint" />
            </p>
          </div>
        )}
        <p className="muted small">
          <FormattedMessage id="notify.localHint" />
        </p>
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>
            <FormattedMessage id="common.close" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
