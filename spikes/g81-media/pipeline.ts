// Spike: the real ui/src/voice/media pipeline with real WebCodecs, silently.
// A synthetic "mic" (an oscillator with a slow envelope) → MediaSession A →
// loopback (jittery, lossy) → MediaSession B → a MediaStreamDestination (never
// the speakers). Bundled by esbuild into pipeline.bundle.js.
import { MediaSession, browserMediaEnv } from '../../ui/src/voice/media/session';
import { loopback } from '../../ui/src/voice/media/transport';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const CALL = 'c'.repeat(32);

export async function runPipeline(seconds = 10) {
  const ctx = new AudioContext({ sampleRate: 48000 });
  // The "mic": 300 Hz with a 2 Hz on/off envelope (speech-like bursts, DTX in the gaps).
  const osc = ctx.createOscillator();
  osc.frequency.value = 300;
  const env = ctx.createGain();
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 2;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.25;
  env.gain.value = 0.25;
  lfo.connect(lfoGain).connect(env.gain);
  osc.connect(env);
  const micDest = ctx.createMediaStreamDestination();
  env.connect(micDest);
  osc.start();
  lfo.start();

  // Receiving side: B's output goes to a silent sink with a meter.
  const sink = ctx.createMediaStreamDestination();
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  const out = ctx.createGain();
  out.connect(sink);
  out.connect(meter);

  let delivered = 0;
  const net = loopback([A, B], {
    delayMs: () => 20 + Math.random() * 60, // 20-80 ms jitter
    drop: () => Math.random() < 0.02, // 2 % loss
  }, (fn, ms) => setTimeout(() => (delivered++, fn()), ms));
  const menv = browserMediaEnv();
  const sa = new MediaSession({ env: menv, transport: net[A]!, context: ctx, output: () => null, accepts: () => true });
  const sb = new MediaSession({ env: menv, transport: net[B]!, context: ctx, output: () => out, accepts: (p) => p === A });
  sb.start(CALL, null);
  sa.start(CALL, micDest.stream.getAudioTracks()[0]!);

  const levels: number[] = [];
  const buf = new Float32Array(meter.fftSize);
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 100));
    meter.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    levels.push(Math.sqrt(s / buf.length));
  }
  const stats = { a: sa.stats(), b: sb.stats() };
  sa.stop();
  sb.stop();
  osc.stop();
  lfo.stop();
  await ctx.close();
  const audible = levels.filter((l) => l > 0.01).length;
  return {
    seconds,
    hasTrackProcessorOnWindow: typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor,
    hasAudioWorklet: typeof AudioWorkletNode,
    sent: stats.a.sent,
    oversize: stats.a.oversize,
    sendError: stats.a.sendError,
    delivered,
    receiver: stats.b.peers[A],
    outputLevelSamples: levels.length,
    outputAudibleShare: +(audible / levels.length).toFixed(2),
    outputPeak: +Math.max(...levels).toFixed(3),
    goal: 'decoded audio reaches the output (about half the time: the source is on/off at 2 Hz), frames ≤ 400 B, losses show as missing, no crash',
  };
}

(globalThis as { runPipeline?: typeof runPipeline }).runPipeline = runPipeline;
