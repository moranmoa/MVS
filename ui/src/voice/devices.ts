// G-72: the chosen microphone and speaker, remembered on this computer, and
// the speaker test sound. Shared by the in-call engine hook and Settings → Voice.

/** localStorage key of the chosen devices. */
const DEVICES_KEY = 'mvs.voice.devices.v1';
/** Fired on window when the choice changes, so a running call follows Settings. */
export const DEVICES_EVENT = 'mvs:voice-devices';

export interface DeviceChoice {
  input?: string;
  output?: string;
}

const okId = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v) ? v : undefined);

/** The stored device choice; only short printable IDs (browsers use opaque hashes). */
export function loadDevices(): DeviceChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICES_KEY) ?? '{}') as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return { input: okId(raw.input), output: okId(raw.output) };
  } catch {
    return {};
  }
}

/** Stores the choice and tells a running call. "" or undefined means the system default. */
export function saveDevices(d: DeviceChoice, notify = true): void {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify({ input: okId(d.input), output: okId(d.output) }));
  } catch {
    // Not remembered; it still applies now.
  }
  if (notify && typeof window !== 'undefined') window.dispatchEvent(new Event(DEVICES_EVENT));
}

export interface OutputDevice {
  deviceId: string;
  label: string;
}

/**
 * The speakers on this computer. Names are empty until the microphone was
 * allowed once (a browser rule); then they read "Speaker 1", "Speaker 2"…
 * via `unnamed`.
 */
export async function listOutputs(unnamed: (n: number) => string): Promise<OutputDevice[]> {
  try {
    const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    return all
      .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || unnamed(i + 1) }));
  } catch {
    return [];
  }
}

/** Plays sine notes (Hz) one after another, `gap` s apart, at `peak` gain, on the chosen speaker. */
async function playNotes(notes: number[], { gap, length, peak }: { gap: number; length: number; peak: number }, outputId?: string): Promise<void> {
  if (typeof AudioContext !== 'function') return;
  const ctx = new AudioContext();
  try {
    const out = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.connect(out);
    const t0 = ctx.currentTime + 0.05;
    for (const [i, freq] of notes.entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      const at = t0 + i * gap;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length - 0.02);
      osc.start(at);
      osc.stop(at + length);
    }
    const audio = new Audio();
    audio.srcObject = out.stream;
    if (outputId && 'setSinkId' in audio) await audio.setSinkId(outputId).catch(() => {});
    await audio.play().catch(() => {});
    await new Promise((r) => setTimeout(r, (0.05 + (notes.length - 1) * gap + length) * 1000 + 100));
    audio.pause();
    audio.srcObject = null;
  } finally {
    void ctx.close().catch(() => {});
  }
}

/**
 * "Play test sound": a short two-note chime on the chosen speaker (the system
 * default without one). No microphone needed. Resolves when it has played.
 */
export function playTestSound(outputId?: string): Promise<void> {
  return playNotes([660, 880], { gap: 0.25, length: 0.24, peak: 0.2 }, outputId);
}

/** G-63: a new message that would notify: one short, quiet two-note blip. */
export function playMessageCue(outputId?: string): Promise<void> {
  return playNotes([880, 1174.66], { gap: 0.08, length: 0.1, peak: 0.05 }, outputId);
}

/**
 * G-64: someone joined my call (rising) or left it (falling). Short and
 * quiet: two soft notes, well under the test sound's level.
 */
export function playCallCue(kind: 'join' | 'leave', outputId?: string): Promise<void> {
  const notes = kind === 'join' ? [523.25, 783.99] : [659.25, 440];
  return playNotes(notes, { gap: 0.12, length: 0.14, peak: 0.06 }, outputId);
}
