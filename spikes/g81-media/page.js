// G-81 spike, renderer side. See main.js for the modes.
const mode = new URLSearchParams(location.search).get('mode');
const status = (t) => {
  document.getElementById('status').textContent = t;
  spike.send('log', t);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.ceil((s.length * p) / 100) - 1)].toFixed(2) : null;
};
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) });

const SR = 48000;
const FRAME_MS = 40;
const FRAME = (SR * FRAME_MS) / 1000;

/** A speech-like test signal: a few harmonics with a slow envelope, plus a little noise. */
function speechish(i0, n) {
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = (i0 + k) / SR;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[k] = 0.2 * env * v + 0.01 * (Math.random() * 2 - 1);
  }
  return out;
}

// ---- codec: WebCodecs Opus, encode+decode per 40 ms frame, fed in real time ----
async function codec() {
  const config = { codec: 'opus', sampleRate: SR, numberOfChannels: 1, bitrate: 24000, opus: { frameDuration: FRAME_MS * 1000, usedtx: true } };
  const support = await AudioEncoder.isConfigSupported(config);
  const dsupport = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 });
  if (!support.supported || !dsupport.supported) return { error: 'opus not supported', support, dsupport };
  const fedAt = new Map();
  const encMs = [];
  const decMs = [];
  const totalMs = [];
  const sizes = [];
  const decIn = new Map();
  const decoder = new AudioDecoder({
    output: (data) => {
      const t0 = decIn.get(data.timestamp);
      if (t0 !== undefined) {
        const now = performance.now();
        decMs.push(now - t0);
        totalMs.push(now - fedAt.get(data.timestamp));
      }
      data.close();
    },
    error: (e) => status('decoder error ' + e.message),
  });
  decoder.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 });
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const t0 = fedAt.get(chunk.timestamp);
      if (t0 !== undefined) encMs.push(performance.now() - t0);
      sizes.push(chunk.byteLength);
      decIn.set(chunk.timestamp, performance.now());
      decoder.decode(chunk);
    },
    error: (e) => status('encoder error ' + e.message),
  });
  encoder.configure(config);
  const frames = 750; // 30 s of audio
  status(`codec: encoding ${frames} frames in real time…`);
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    const due = start + i * FRAME_MS;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    const ts = i * FRAME_MS * 1000;
    const data = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: ts, data: speechish(i * FRAME, FRAME) });
    fedAt.set(ts, performance.now());
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  await decoder.flush();
  return {
    config,
    encodeMs: stats(encMs),
    decodeMs: stats(decMs),
    encodePlusDecodeMs: stats(totalMs),
    bytesPerFrame: stats(sizes),
    goal: 'p95 encode+decode < 10 ms',
    pass: pct(totalMs, 95) < 10,
  };
}

// ---- ipc: 4 peers x 25 frames/s through main and a stdio JSON child ----
async function ipcRun(seconds, withBig) {
  const sentAt = new Map();
  const rtt = [];
  spike.on('voice.frame', (m) => {
    const t0 = sentAt.get(`${m.from}:${m.seq}`);
    if (t0 !== undefined) {
      rtt.push(performance.now() - t0);
      sentAt.delete(`${m.from}:${m.seq}`);
    }
  });
  const payload = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(120)))); // ~24 kbps Opus frame
  const peers = 4;
  const start = performance.now();
  let tick = 0;
  let bigId = 0;
  while (performance.now() - start < seconds * 1000) {
    const due = start + tick * FRAME_MS;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    // 4 peers at 25 fps each = one frame per peer every 40 ms.
    for (let p = 0; p < peers; p++) {
      sentAt.set(`p${p}:${tick}`, performance.now());
      spike.send('voiceFrame', { callId: 'c'.repeat(32), peer: `p${p}`, seq: tick, ts: tick * FRAME_MS, data: payload });
    }
    if (withBig && tick % 50 === 0) spike.send('big', ++bigId); // a ~1 MB reply every 2 s
    tick++;
  }
  await sleep(500);
  return { seconds, framesPerSecond: (peers * 1000) / FRAME_MS, withOneMegabyteRepliesEvery2s: withBig, lost: sentAt.size, rttMs: stats(rtt) };
}

async function ipc() {
  status('ipc: plain…');
  const plain = await ipcRun(20, false);
  status('ipc: with big replies…');
  const loaded = await ipcRun(20, true);
  return { plain, loaded, goal: 'p95 round trip < 20 ms at 4 x 25 fps', pass: plain.rttMs.p95 < 20 && loaded.rttMs.p95 < 20 };
}

// ---- aec: plays noise OUT LOUD; measures how much reaches the mic ----
async function micMeter(echoCancellation) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContext({ sampleRate: SR });
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  return {
    async rms(ms) {
      const vals = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        vals.push(Math.sqrt(s / buf.length));
        await sleep(20);
      }
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    },
    close() {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** Starts the test sound on one playout path; returns stop(). */
async function play(path) {
  const ctx = new AudioContext({ sampleRate: SR });
  const len = SR * 8;
  const b = ctx.createBuffer(1, len, SR);
  b.copyToChannel(speechish(0, len).map((v) => v * 2), 0);
  const src = ctx.createBufferSource();
  src.buffer = b;
  if (path === 'webaudio') {
    src.connect(ctx.destination);
    src.start();
    return () => (src.stop(), void ctx.close());
  }
  // loopback: through a local RTCPeerConnection pair (iceServers: [], in-process), played as a WebRTC track.
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  const a = new RTCPeerConnection({ iceServers: [] });
  const z = new RTCPeerConnection({ iceServers: [] });
  a.onicecandidate = (e) => e.candidate && z.addIceCandidate(e.candidate);
  z.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const audio = new Audio();
  z.ontrack = (e) => {
    audio.srcObject = e.streams[0];
    void audio.play();
  };
  dest.stream.getTracks().forEach((t) => a.addTrack(t, dest.stream));
  await a.setLocalDescription(await a.createOffer());
  await z.setRemoteDescription(a.localDescription);
  await z.setLocalDescription(await z.createAnswer());
  await a.setRemoteDescription(z.localDescription);
  src.start();
  return () => (src.stop(), audio.pause(), a.close(), z.close(), void ctx.close());
}

async function aec() {
  const out = {};
  for (const path of ['webaudio', 'loopback']) {
    for (const ec of [false, true]) {
      status(`aec: ${path}, echoCancellation ${ec}…`);
      const mic = await micMeter(ec);
      await sleep(500);
      const room = await mic.rms(1500);
      const stop = await play(path);
      await sleep(2500); // AEC convergence
      const during = await mic.rms(4000);
      stop();
      mic.close();
      await sleep(1000);
      out[`${path}/${ec ? 'aec' : 'raw'}`] = { roomRms: +room.toFixed(5), playingRms: +during.toFixed(5), echoAboveRoomDb: +(20 * Math.log10(during / Math.max(room, 1e-6))).toFixed(1) };
    }
  }
  const att = (path) => +(20 * Math.log10(out[`${path}/raw`].playingRms / Math.max(out[`${path}/aec`].playingRms, 1e-6))).toFixed(1);
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const pick = (k) => devs.filter((d) => d.kind === k && (d.deviceId === 'default' || d.deviceId === 'communications')).map((d) => d.deviceId + ': ' + d.label);
    out.devices = { input: pick('audioinput'), output: pick('audiooutput') };
  } catch {}
  out.summary = { webaudioAttenuationDb: att('webaudio'), loopbackAttenuationDb: att('loopback'), goal: 'AEC removes the played sound: echo with aec near the room level (about 20 dB or more attenuation)' };
  return out;
}

(async () => {
  let result;
  try {
    result = mode === 'ipc' ? await ipc() : mode === 'aec' ? await aec() : mode === 'pipeline' ? await globalThis.runPipeline(10) : await codec();
  } catch (e) {
    result = { error: String(e?.stack || e) };
  }
  result.env = { userAgent: navigator.userAgent, mode };
  status('done');
  spike.send('done', result);
})();
