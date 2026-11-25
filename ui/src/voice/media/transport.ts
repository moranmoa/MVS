// G-81 B: how frames leave and arrive. The real one is the shell's frame
// channel to the core's fast path (§2.3, #526); the loopback is for tests and the
// spike, with knobs for delay, loss, reordering and duplicates.

import { cleanInFrame, outArgs, type InFrame, type OutFrame } from './frame';

export interface MediaTransport {
  /** Fire-and-forget: the core sends it to every B peer in my current call. */
  send(frame: OutFrame): void;
  onFrame(cb: (frame: InFrame) => void): () => void;
}

/**
 * The desktop shell's frame channel (#526): `window.mvs.voice`. Fire-and-forget
 * send; one frame listener (a new one replaces it). Main drops frames unless
 * I'm in a call and unlocked (G-78 path B keeps receiving), and caps them.
 * Not a CoreCommand: it never goes through core:invoke (SL, TL).
 */
export interface VoiceBridge {
  send(args: { callId: string; seq: number; ts: number; data: string }): void;
  onFrame(cb: (raw: unknown) => void): () => void;
}

/** The shell's bridge, when this build has it. */
export function voiceBridge(): VoiceBridge | null {
  const v = (globalThis as { mvs?: { voice?: Partial<VoiceBridge> } }).mvs?.voice;
  return v && typeof v.send === 'function' && typeof v.onFrame === 'function' ? (v as VoiceBridge) : null;
}

/** Over the shell: outgoing frames encoded for the channel, incoming ones checked (cleanInFrame). */
export function bridgeTransport(bridge: VoiceBridge): MediaTransport {
  return {
    send: (f) => bridge.send(outArgs(f)),
    onFrame: (cb) =>
      bridge.onFrame((raw) => {
        const f = cleanInFrame(raw);
        if (f) cb(f);
      }),
  };
}

export interface LoopbackLink {
  /** Delivery delay per frame, in ms (a function for jitter). */
  delayMs?: number | ((seq: number) => number);
  /** Drop this frame. */
  drop?: (seq: number) => boolean;
  /** Deliver this frame twice. */
  duplicate?: (seq: number) => boolean;
}

/**
 * Two (or more) ends wired together, like a call's mesh: what one end sends
 * reaches every other end, with `from` set to the sender's identity.
 */
export function loopback(ids: string[], link: LoopbackLink = {}, schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms)): Record<string, MediaTransport> {
  const listeners = new Map<string, Set<(f: InFrame) => void>>(ids.map((id) => [id, new Set()]));
  const deliver = (to: string, f: InFrame) => listeners.get(to)?.forEach((cb) => cb(f));
  return Object.fromEntries(
    ids.map((me) => [
      me,
      {
        send(f: OutFrame) {
          if (link.drop?.(f.seq)) return;
          const copies = link.duplicate?.(f.seq) ? 2 : 1;
          const delay = typeof link.delayMs === 'function' ? link.delayMs(f.seq) : link.delayMs ?? 0;
          for (const to of ids) {
            if (to === me) continue;
            for (let c = 0; c < copies; c++) schedule(() => deliver(to, { ...f, data: f.data.slice(), from: me }), delay);
          }
        },
        onFrame(cb: (f: InFrame) => void) {
          listeners.get(me)!.add(cb);
          return () => listeners.get(me)!.delete(cb);
        },
      } satisfies MediaTransport,
    ]),
  );
}
