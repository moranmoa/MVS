// G-72 part 2, Settings → Voice (UX spec #427 §4, option (a)). The desktop
// shell allows the microphone only during a call (V-C2), so the microphone
// controls and the mic test live in the call's Voice settings dialog. Here:
// the speaker and a test sound, which need no microphone, and where to test
// the mic. The choice is remembered on this computer and a running call
// follows it.

import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useSettings } from '../../app/settings';
import { listOutputs, loadDevices, playTestSound, saveDevices, type OutputDevice } from '../../voice/devices';
import { PushToTalkSection } from './PushToTalk';

export function VoiceSection() {
  const intl = useIntl();
  const { settings, update } = useSettings();
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [output, setOutput] = useState(() => loadDevices().output ?? '');
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      void listOutputs((n) => intl.formatMessage({ id: 'voice.speakerN' }, { n })).then((list) => live && setOutputs(list));
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, [intl]);

  const pick = (id: string) => {
    setOutput(id);
    saveDevices({ ...loadDevices(), output: id || undefined });
  };
  // A remembered speaker that isn't plugged in now shows as the default.
  const shown = outputs.some((d) => d.deviceId === output) ? output : '';

  return (
    <div className="stack voice-section">
      <label className="field">
        <span>
          <FormattedMessage id="voice.speaker" />
        </span>
        <select value={shown} onChange={(e) => pick(e.target.value)}>
          <option value="">{intl.formatMessage({ id: 'voice.systemDefault' })}</option>
          {outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <div>
        <button
          type="button"
          className="secondary"
          aria-busy={playing || undefined}
          disabled={playing}
          onClick={() => {
            setPlaying(true);
            void playTestSound(shown || undefined).finally(() => setPlaying(false));
          }}
        >
          <FormattedMessage id="voice.playTest" />
        </button>
      </div>
      <p className="hint" role="note">
        <FormattedMessage id="voice.micTestInCall" />
      </p>
      <PushToTalkSection />
      <label className="switch-row">
        <span>
          <FormattedMessage id="voice.callSounds" />
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={settings.callSounds !== false}
          onChange={(e) => update({ callSounds: e.target.checked })}
        />
      </label>
    </div>
  );
}
