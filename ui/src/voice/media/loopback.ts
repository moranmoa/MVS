// G-81 B playout (spike, AEC run 2: 27.3 dB): B's decoded audio is played as a
// WebRTC track, so Chromium's echo canceller takes it as its reference. Plain
// Web Audio playout couldn't be shown to be cancelled.
//
//   per-peer gains → bus → MediaStreamDestination → local RTCPeerConnection
//   pair (in this renderer only) → <audio> on the chosen output
//
// TL L1-L4 (#550): the pair's SDP and candidates never leave this function
// (no core.sendSignal, no IPC); `iceServers: []`, no TURN; it comes from its
// own factory, which relay-only allows (it reaches no one); one shared pair per
// call, closed with it.

/** How long the pair may take to deliver its track before the caller falls back (TL). */
export const LOOPBACK_TRACK_MS = 2_000;

/** The pair's only configuration: no ICE servers, nothing else (the loopback factory uses it; it takes no arguments). */
export const LOOPBACK_CONFIG: RTCConfiguration = { iceServers: [] };

export interface LoopbackPlayout {
  /** Connect each peer's gain here. */
  input: AudioNode;
  setSink(deviceId: string | undefined): void;
  close(): void;
}

/**
 * Builds the shared playout. `makePc` is the loopback factory (never the
 * remote one); `makeAudio` gives the element that plays it. `onFail` is
 * called once if the pair can't negotiate or either end fails: the caller
 * then plays to the speakers directly instead (better heard than silent).
 */
export function loopbackPlayout(ctx: AudioContext, makePc: () => RTCPeerConnection, makeAudio: () => HTMLAudioElement, onFail: () => void = () => {}): LoopbackPlayout {
  const bus = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  bus.connect(dest);
  const a = makePc();
  const z = makePc();
  const audio = makeAudio();
  audio.autoplay = true;
  let closed = false;
  let failed = false;
  const fail = () => {
    if (closed || failed) return;
    failed = true;
    onFail();
  };
  for (const pc of [a, z]) pc.onconnectionstatechange = () => pc.connectionState === 'failed' && fail();
  // No track in time: as good as failed.
  const noTrack = setTimeout(fail, LOOPBACK_TRACK_MS);
  // Candidates go straight to the other end of the pair, in this function only.
  a.onicecandidate = (e) => {
    if (e.candidate && !closed) void z.addIceCandidate(e.candidate).catch(() => {});
  };
  z.onicecandidate = (e) => {
    if (e.candidate && !closed) void a.addIceCandidate(e.candidate).catch(() => {});
  };
  z.ontrack = (e) => {
    clearTimeout(noTrack);
    if (closed) return;
    audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    void audio.play?.()?.catch?.(() => {});
  };
  for (const t of dest.stream.getAudioTracks()) a.addTrack(t, dest.stream);
  void (async () => {
    try {
      await a.setLocalDescription(await a.createOffer());
      if (closed) return;
      await z.setRemoteDescription(a.localDescription!);
      await z.setLocalDescription(await z.createAnswer());
      if (closed) return;
      await a.setRemoteDescription(z.localDescription!);
    } catch {
      fail(); // no loopback: the caller falls back to the speakers
    }
  })();
  return {
    input: bus,
    setSink(deviceId) {
      const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === 'function') void el.setSinkId(deviceId ?? '').catch(() => {});
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(noTrack);
      try {
        bus.disconnect();
      } catch {
        // already gone
      }
      for (const t of dest.stream.getTracks()) t.stop();
      audio.pause?.();
      audio.srcObject = null;
      a.close();
      z.close();
    },
  };
}
