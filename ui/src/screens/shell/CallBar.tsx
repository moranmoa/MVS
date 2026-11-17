// Voice v1, piece E (#223) and E2 (voice-room amendment): the UI around a call.
// The call bar (mute, leave) and what the voice rooms share (VoiceRooms.tsx):
// the IP notice, the join error line, the roster notes. The audio itself (microphone, WebRTC, speaking levels) is the
// voice engine's, piece D in ui/src/voice.

import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { Dialog, Name } from '../../components/common';
import { AlertIcon, GearIcon, HangUpIcon, HeadphonesIcon, HeadphonesOffIcon, MicIcon, MicOffIcon, PhoneIcon } from '../../components/icons';
import { useCore, type Id, type Member } from '../../core';
import { useVoiceEngine, type PeerFailure, type VoiceEngineView } from '../../voice';

/**
 * The voice engine (piece D, ui/src/voice) as the call UI uses it. `peerFailed`
 * comes from the engine (#245): `failed` (the connection failed) or `refused` (a
 * security check failed: fingerprint or unverified signal).
 */
export interface CallEngine extends VoiceEngineView {
  /** No microphone, denied, or one picked after joining without one: listen-only. */
  noMic: boolean;
}

/**
 * The one engine for my call. Call it once (the channel sidebar does) and pass
 * it down: each useVoiceEngine makes its own WebRTC engine.
 *
 * For demos and QA with the mock, `?voiceSim=noMic|rejoin|peerFailed|peerRefused`
 * acts out the engine's failure states, on top of what the engine reports.
 */
export function useCallEngine(myId: Id): CallEngine {
  const store = useAppStore();
  const core = useCore();
  const call = useStore(store, (s) => s.call);
  const stunUrl = useStunUrl();
  const view = useVoiceEngine(call, myId, { stunUrl });
  const sim = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('voiceSim') : null;
  const error = call && sim === 'noMic' ? 'no-device' : call && sim === 'rejoin' ? 'rejoin-to-talk' : view.error;
  const other = call?.participants.find((p) => p.identity !== myId)?.identity;
  // No microphone (none, permission denied, or unplugged mid-call): stay in the
  // call to listen, and show the others I'm muted (#232 V5.7/V5.8). rejoin-to-talk
  // is still listen-only: the new mic only works after a rejoin.
  const noMic = !!call && (error === 'no-device' || error === 'mic-denied' || error === 'rejoin-to-talk');
  const meMuted = !!call?.participants.find((p) => p.identity === myId)?.muted;
  useEffect(() => {
    if (noMic && !meMuted) void core.setMuted(true).catch(() => {});
  }, [noMic, meMuted, core]);
  // G-72: a chosen device was unplugged: say which, once.
  const fallback = view.deviceFallback;
  useEffect(() => {
    if (!fallback) return;
    const base = fallback.kind === 'input' ? 'call.micUnplugged' : 'call.speakerUnplugged';
    if (fallback.label) store.showFlash(base, { name: fallback.label });
    else store.showFlash(`${base}NoName`);
  }, [fallback, store]);
  const simFailure: PeerFailure | null = sim === 'peerFailed' ? 'failed' : sim === 'peerRefused' ? 'refused' : null;
  const peerFailed = simFailure && other ? { ...view.peerFailed, [other]: simFailure } : view.peerFailed;
  return { ...view, error, noMic, peerFailed };
}

/**
 * Our STUN server (#222): the desktop shell puts it on every core.status (the
 * latest one reaches late listeners too). Null without one: calls then work
 * on the same network only.
 */
function useStunUrl(): string | null {
  const core = useCore();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => core.on('core.status', (s) => setUrl(s.stunUrl ?? null)), [core]);
  return url;
}

const NO_MEMBERS: Member[] = [];

/** The short code the app shows for someone not (yet) in the member list. */
export function codeOf(id: Id): string {
  const s = id.replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const ERROR_TEXT: Record<string, string> = {
  'call-full': 'call.error.full',
  'relay-only': 'call.error.relayOnly',
  'in-call-elsewhere': 'call.error.inCallElsewhere',
  'room-cap': 'voiceRooms.capReached',
  'not-implemented': 'call.error.notImplemented',
  'not-allowed': 'call.error.notAllowed',
};

export const FAILURE_TEXT: Record<PeerFailure, [text: string, hint: string]> = {
  failed: ['call.peerFailed', 'call.peerFailedHint'],
  refused: ['call.peerRefused', 'call.peerRefusedHint'],
};

/** docs/ux/specs/voice-ip-notice.md: shown once per computer, before the first join. */
const IP_NOTICE_KEY = 'mvs.notices.voiceIp.v1';
export function ipNoticeSeen(): boolean {
  try {
    return localStorage.getItem(IP_NOTICE_KEY) === '1';
  } catch {
    return false; // no storage: explain every time rather than join unexplained
  }
}
export function rememberIpNotice(): void {
  try {
    localStorage.setItem(IP_NOTICE_KEY, '1');
  } catch {
    // Shown again next time.
  }
}

/** Why joining or opening a room failed, under the "Join chat" row, until dismissed or retried. */
export function CallError() {
  const store = useAppStore();
  const intl = useIntl();
  const code = useStore(store, (s) => s.callError);
  if (!code) return null;
  return (
    <div className="offline-banner call-blocked" role="status">
      <AlertIcon />
      <span>
        <FormattedMessage id={ERROR_TEXT[code] ?? 'call.error.other'} />
      </span>
      <button type="button" className="link small" onClick={() => store.clearCallError()} aria-label={intl.formatMessage({ id: 'common.close' })}>
        <FormattedMessage id="common.close" />
      </button>
    </div>
  );
}

/**
 * My call: where, mute and leave. In the channel sidebar, above my panel. Who
 * is in it shows once, in the room entry's roster.
 */
export function CallBar({ myId, engine }: { myId: Id; engine: CallEngine }) {
  const store = useAppStore();
  const core = useCore();
  const intl = useIntl();
  const call = useStore(store, (s) => s.call);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** G-84: deafening muted my mic, so undeafening unmutes it. */
  const mutedByDeafen = useRef(false);
  // The call may be in another server's room than the one on screen.
  const serverId = useStore(store, (s) => Object.entries(s.voiceRooms).find(([, rooms]) => rooms.some((r) => r.roomId === s.call?.channelId))?.[0]);
  const serverName = useStore(store, (s) => s.servers.find((x) => x.id === serverId)?.name ?? '');
  const members = useStore(store, (s) => (serverId ? s.members[serverId] : undefined)) ?? NO_MEMBERS;
  if (!call) return null;

  const me = call.participants.find((p) => p.identity === myId);
  const noMic = engine.noMic;
  const noMicText = intl.formatMessage({ id: engine.error === 'rejoin-to-talk' ? 'call.rejoinToTalk' : 'call.noMic' });
  const setMute = (muted: boolean) => {
    engine.setMicMuted(muted);
    void core.setMuted(muted).catch(() => {});
  };
  const toggleMute = () => {
    if (noMic) return;
    const muted = !me?.muted;
    // As in Discord: unmuting while deafened undeafens too.
    if (!muted && engine.deafened) {
      engine.setDeafened(false);
      mutedByDeafen.current = false;
    }
    setMute(muted);
  };
  // G-84: deafen silences everyone and mutes me (others see me muted);
  // undeafen plays them again and unmutes me if deafening muted me.
  const toggleDeafen = () => {
    if (!engine.deafened) {
      engine.setDeafened(true);
      if (!me?.muted && !noMic) {
        mutedByDeafen.current = true;
        setMute(true);
      }
    } else {
      engine.setDeafened(false);
      if (mutedByDeafen.current) setMute(false);
      mutedByDeafen.current = false;
    }
  };

  return (
    <section className="call-bar" aria-label={intl.formatMessage({ id: 'call.label' })}>
      <p className="call-where">
        <PhoneIcon />
        <FormattedMessage id="call.inCall" values={{ server: serverName }} />
      </p>
      {engine.deafened && (
        <p id="call-deafened" className="call-no-mic" role="status">
          <HeadphonesOffIcon />
          <FormattedMessage id="call.deafenedNote" />
        </p>
      )}
      {noMic && (
        <p id="call-no-mic" className="call-no-mic" role="status">
          <MicOffIcon />
          {noMicText}
        </p>
      )}
      <div className="call-actions">
        <button
          type="button"
          className={`icon-button call-mute ${me?.muted ? 'muted' : ''}`}
          aria-pressed={!!me?.muted}
          aria-disabled={noMic || undefined}
          aria-describedby={noMic ? 'call-no-mic' : undefined}
          aria-label={intl.formatMessage({ id: 'call.mute' })}
          title={noMic ? noMicText : intl.formatMessage({ id: 'call.mute' })}
          onClick={toggleMute}
        >
          {me?.muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          type="button"
          className={`icon-button call-deafen ${engine.deafened ? 'muted' : ''}`}
          aria-pressed={engine.deafened}
          aria-label={intl.formatMessage({ id: 'call.deafen' })}
          title={intl.formatMessage({ id: 'call.deafen' })}
          onClick={toggleDeafen}
        >
          {engine.deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
        </button>
        <button
          type="button"
          className="icon-button call-settings"
          aria-haspopup="dialog"
          aria-label={intl.formatMessage({ id: 'call.voiceSettings' })}
          title={intl.formatMessage({ id: 'call.voiceSettings' })}
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className="icon-button call-leave"
          aria-label={intl.formatMessage({ id: 'call.leave' })}
          title={intl.formatMessage({ id: 'call.leave' })}
          onClick={() => void store.leaveCall()}
        >
          <HangUpIcon />
        </button>
      </div>
      <VoiceSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        engine={engine}
        muted={!!me?.muted}
        others={call.participants
          .filter((p) => p.identity !== myId)
          .map((p) => ({ id: p.identity, name: members.find((m) => m.id === p.identity)?.displayName || codeOf(p.identity) }))}
      />
    </section>
  );
}

/**
 * G-72: pick the microphone and the speaker, and test the mic. In a call only:
 * the desktop shell grants the microphone (and with it the device names)
 * only during one. The choice lasts for this session.
 */
function VoiceSettings({
  open,
  onClose,
  engine,
  muted,
  others,
}: {
  open: boolean;
  onClose: () => void;
  engine: CallEngine;
  muted: boolean;
  /** G-73: the others in my call, for their volume. */
  others: { id: Id; name: string }[];
}) {
  const intl = useIntl();
  const level = useInputLevel(open && !engine.noMic && !muted, engine.inputLevel);
  const pct = Math.round(level * 100);
  const system = intl.formatMessage({ id: 'call.systemDefault' });
  return (
    <Dialog open={open} onClose={onClose} title={<FormattedMessage id="call.voiceSettings" />} className="voice-settings">
      <label className="field">
        <span>
          <FormattedMessage id="call.microphone" />
        </span>
        <select value={engine.inputId ?? ''} onChange={(e) => engine.setInput(e.target.value)} disabled={engine.inputs.length === 0}>
          <option value="">{system}</option>
          {engine.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          <FormattedMessage id="call.speaker" />
        </span>
        <select value={engine.outputId ?? ''} onChange={(e) => engine.setOutput(e.target.value)} disabled={engine.outputs.length === 0}>
          <option value="">{system}</option>
          {engine.outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mic-test">
        <span id="mic-test-label">
          <FormattedMessage id="call.micTest" />
        </span>
        <div
          className="mic-level"
          role="meter"
          aria-labelledby="mic-test-label"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="mic-level-fill" style={{ inlineSize: `${pct}%` }} />
        </div>
        <p className="hint">
          <FormattedMessage id={engine.noMic ? 'call.noMic' : muted ? 'call.micTestMuted' : 'call.micTestHint'} />
        </p>
      </div>
      {others.length > 0 && (
        <fieldset className="call-volumes">
          <legend>
            <FormattedMessage id="call.volumes" />
          </legend>
          {others.map((o) => {
            const pct = engine.volumes[o.id] ?? 100;
            const text = intl.formatNumber(pct / 100, { style: 'percent' });
            return (
              <label key={o.id} className="field range">
                <span>
                  <Name>{o.name}</Name>
                  <output>{text}</output>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={pct}
                  aria-valuetext={text}
                  onChange={(e) => engine.setVolume(o.id, Number(e.target.value))}
                />
              </label>
            );
          })}
          <p className="hint">
            <FormattedMessage id="call.volumesHint" />
          </p>
        </fieldset>
      )}
    </Dialog>
  );
}

/** Polls the mic level ten times a second while `on`; 0 otherwise. */
function useInputLevel(on: boolean, read: () => number): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!on) {
      setLevel(0);
      return;
    }
    const t = setInterval(() => setLevel(read()), 100);
    return () => clearInterval(t);
  }, [on, read]);
  return level;
}
