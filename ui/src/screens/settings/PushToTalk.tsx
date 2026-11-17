// G-74 (chat-and-voice-extras.md §6): on Settings → "קול" (G-72's page): voice
// activity or push to talk, the push-to-talk key, and an optional global mute toggle.

import { useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useSettings } from '../../app/settings';
import { useStore } from '../../app/store';
import { acceleratorFrom, acceleratorLabel, defaultVoicePrefs, keyLabel, pttKeyFrom, type VoicePrefs } from '../../app/voicePrefs';

/** A button that waits for one key; Esc cancels. */
function KeyCapture({
  value,
  label,
  describedBy,
  invalid,
  capture,
  onChange,
}: {
  value: string | null;
  label: string;
  describedBy?: string;
  invalid?: boolean;
  capture: (e: KeyboardEvent) => string | null;
  onChange: (v: string) => void;
}) {
  const [waiting, setWaiting] = useState(false);
  return (
    <button
      type="button"
      className={`secondary key-capture ${waiting ? 'waiting' : ''}`}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onClick={() => setWaiting(true)}
      onBlur={() => setWaiting(false)}
      onKeyDown={(e) => {
        if (!waiting) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return setWaiting(false);
        const v = capture(e);
        if (v) {
          onChange(v);
          setWaiting(false);
        }
      }}
    >
      {waiting ? <FormattedMessage id="voice.pttCapture" /> : value ? <kbd>{value}</kbd> : <FormattedMessage id="voice.pttNone" />}
    </button>
  );
}

export function PushToTalkSection() {
  const intl = useIntl();
  const store = useAppStore();
  const { settings, update } = useSettings();
  const prefs = settings.voice ?? defaultVoicePrefs();
  const status = useStore(store, (s) => s.pttStatus);
  const set = (patch: Partial<VoicePrefs>) => update({ voice: { ...prefs, ...patch } });
  const unsupported = status === 'unsupported';
  return (
    <div className="stack voice-settings">
      {unsupported && (
        <p className="muted small" role="note">
          <FormattedMessage id="voice.desktopOnly" />
        </p>
      )}
      <fieldset className="stack" disabled={unsupported}>
        <legend>
          <FormattedMessage id="voice.mode" />
        </legend>
        {(['open', 'ptt'] as const).map((m) => (
          <label key={m} className="radio-row">
            <input type="radio" name="voice-mode" checked={prefs.mode === m} onChange={() => set({ mode: m })} />
            <FormattedMessage id={m === 'open' ? 'voice.mode.open' : 'voice.mode.ptt'} />
          </label>
        ))}
      </fieldset>
      {prefs.mode === 'ptt' && (
        <div className="stack">
          <span className="field-label" id="ptt-key-label">
            <FormattedMessage id="voice.pttKey" />
          </span>
          <KeyCapture
            value={prefs.pttKey ? keyLabel(prefs.pttKey) : null}
            label={intl.formatMessage({ id: 'voice.pttKey' })}
            describedBy="ptt-key-hint"
            invalid={status === 'invalid'}
            capture={(e) => pttKeyFrom(e)}
            onChange={(pttKey) => set({ pttKey })}
          />
          <p id="ptt-key-hint" className="muted small">
            <FormattedMessage id={prefs.pttKey ? 'voice.pttFocusOnly' : 'voice.pttNeedsKey'} />
          </p>
        </div>
      )}
      <div className="stack">
        <span className="field-label">
          <FormattedMessage id="voice.globalMute" />
        </span>
        <div className="row">
          <KeyCapture
            value={prefs.globalMute ? acceleratorLabel(prefs.globalMute) : null}
            label={intl.formatMessage({ id: 'voice.globalMute' })}
            describedBy="global-mute-hint"
            invalid={status === 'shortcut-taken'}
            capture={(e) => acceleratorFrom(e)}
            onChange={(globalMute) => set({ globalMute })}
          />
          {prefs.globalMute && (
            <button type="button" className="link small" onClick={() => set({ globalMute: null })}>
              <FormattedMessage id="voice.globalMuteClear" />
            </button>
          )}
        </div>
        <p id="global-mute-hint" className={status === 'shortcut-taken' ? 'error small' : 'muted small'} role={status === 'shortcut-taken' ? 'alert' : undefined}>
          <FormattedMessage id={status === 'shortcut-taken' ? 'voice.shortcutTaken' : 'voice.globalMuteHint'} />
        </p>
      </div>
    </div>
  );
}
