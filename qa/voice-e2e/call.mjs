// One side of the two-peer voice e2e (ROLE=a is the owner, ROLE=b the member).
// Runs inside the app container (compose.yaml): launches the desktop app with
// the real mvs-core, sets up the account and server through the bridge, then
// does the call through the UI and checks it with WebRTC's own stats.
//
// The two sides meet through files in /rendezvous (put / take). Each check
// prints "PASS|FAIL|SKIP <case> <text>"; the case IDs are the ones in
// docs/qa/voice-v1-test-plan.md. Exit code 1 if any check failed.

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/repo/desktop/package.json');
const { _electron: electron } = require('playwright-core');

const ROLE = process.env.ROLE;
// Join variants (#join hang repro): MODE=restore makes B the owner's identity
// restored on a second computer; JOIN_VIA=ui joins from the app's own dialog;
// JOIN_ONLY=1 stops after the join (no call).
const MODE = process.env.MODE || 'new';
const JOIN_VIA = process.env.JOIN_VIA || 'bridge';
const JOIN_ONLY = !!process.env.JOIN_ONLY;
// G-81 (calls across networks): EXPECT_PATH=direct|relay makes the path check
// strict (unset: report only); SETUP_MAX_MS is the PO's setup target (#426).
const EXPECT_PATH = process.env.EXPECT_PATH || '';
const SETUP_MAX_MS = Number(process.env.SETUP_MAX_MS || 10_000);
if (EXPECT_PATH && !['direct', 'relay'].includes(EXPECT_PATH)) throw new Error('EXPECT_PATH must be direct or relay');
// G-81 two-NAT scenarios (run-two-nat.sh), inert unless set:
// EXPECT_CONNECT=none: the call must fail ("no voice connection" within
//   CONNECT_FAIL_MAX_MS, never a relay candidate); the audio checks are
//   skipped and the run ends after the G81 checks (G81.3).
// EXPECT_STUN=answered|unreachable: the voice settings' connection
//   diagnostics show STUN as answered or unreachable (G81.4, needs #496).
const EXPECT_CONNECT = process.env.EXPECT_CONNECT || '';
const CONNECT_FAIL_MAX_MS = Number(process.env.CONNECT_FAIL_MAX_MS || 35_000);
const EXPECT_STUN = process.env.EXPECT_STUN || '';
if (EXPECT_CONNECT && EXPECT_CONNECT !== 'none') throw new Error('EXPECT_CONNECT must be none');
if (EXPECT_STUN && !['answered', 'unreachable'].includes(EXPECT_STUN)) throw new Error('EXPECT_STUN must be answered or unreachable');
/** Thrown to end an EXPECT_CONNECT=none run after its checks (not a failure). */
const EARLY_END = Symbol('early end');
/** When I pressed OK on the IP notice (the join), for the setup time. */
let joinedAt = 0;
const OTHER = ROLE === 'a' ? 'b' : 'a';
const NAME = { a: 'QA-A owner', b: 'QA-B member' };
const SERVER = 'voice e2e';
const RV = '/rendezvous';
const STEP_TIMEOUT = 150_000;

if (!['a', 'b'].includes(ROLE)) throw new Error('ROLE must be a or b');
if (!process.env.MVS_RELAY) throw new Error('MVS_RELAY is not set (run through run.sh)');

const results = [];
const t0 = Date.now();
// Whatever hangs, the run ends: results so far are printed, exit 1.
setTimeout(() => {
  console.log('FAIL run watchdog: the scenario did not finish in 8 minutes');
  writeFileSync(join(RV, `${ROLE}.abort.json`), '{}');
  writeFileSync(join(RV, `results-${ROLE}.json`), JSON.stringify(results, null, 2));
  process.exit(1);
}, 8 * 60_000).unref();
const log = (...m) => console.log(`[${ROLE} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
function record(status, id, text, detail) {
  results.push({ status, id, text, ...(detail === undefined ? {} : { detail }) });
  console.log(`${status} ${id} ${ROLE}: ${text}${detail === undefined ? '' : ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
}
async function check(id, text, fn) {
  try {
    const detail = await fn();
    record('PASS', id, text, detail);
    return true;
  } catch (e) {
    record('FAIL', id, text, e?.message ?? String(e));
    return false;
  }
}

// ---- rendezvous ------------------------------------------------------------

const put = (name, data = {}) => writeFileSync(join(RV, `${ROLE}.${name}.json`), JSON.stringify(data));
async function take(name, timeout = STEP_TIMEOUT) {
  const file = join(RV, `${OTHER}.${name}.json`);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    if (existsSync(join(RV, `${OTHER}.abort.json`))) throw new Error(`${OTHER} aborted before "${name}"`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${OTHER}'s "${name}"`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeout = 30_000, every = 250) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`${what}: not within ${timeout / 1000} s${last ? ` (${last.message})` : ''}`);
}

// ---- the app ---------------------------------------------------------------

const PROFILE = mkdtempSync(join(tmpdir(), `mvs-voice-${ROLE}-`));
const app = await electron.launch({
  cwd: '/repo/desktop',
  // The fake microphone only. Not --use-fake-ui-for-media-stream: it grants
  // media before the shell's permission handler is asked, which would hide
  // what #228 / V-C2 decide (Electron has no prompt UI to fake anyway).
  args: ['--use-fake-device-for-media-stream', '/repo/desktop'],
  env: { ...process.env, MVS_TEST_USER_DATA: PROFILE },
});
let mainOut = '';
app.process().stdout.on('data', (d) => (mainOut += d));
app.process().stderr.on('data', (d) => (mainOut += d));
const page = await app.firstWindow();
page.on('console', (m) => {
  log(`console.${m.type()}:`, m.text());
});
page.on('pageerror', (e) => log('pageerror:', e.message));
await page.waitForFunction(() => typeof window.mvs?.invoke === 'function');
// G-78 (#513): the shell gates every command until the core says whether the
// app lock is on (pending), and a fresh profile has it off. Wait for that.
{
  // An explicit loop: waitForFunction with an async predicate isn't awaited.
  // A fresh profile has no lock, but the shell fails closed (lock screen) if
  // the core hasn't answered getAppLock in time, and asks again once the core
  // is up. Log every state change, so a late open and a stuck lock differ.
  const start = Date.now();
  const end = start + 120_000;
  let s = null;
  let last = '';
  for (;;) {
    s = await page.evaluate(() => (window.mvs.lock?.state ? window.mvs.lock.state() : { none: true })).catch((e) => ({ error: e.message }));
    const now = JSON.stringify(s);
    if (now !== last) console.log(`[${ROLE}] app lock +${((Date.now() - start) / 1000).toFixed(1)} s: ${now}`);
    last = now;
    if (s?.none || (s && !s.error && !s.pending && !s.locked)) break;
    if (Date.now() > end) throw new Error(`the app lock never opened in 120 s: ${now}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
// Main may reload the page once the lock is decided: wait for it again.
await page.waitForFunction(() => typeof window.mvs?.invoke === 'function');
// Diagnostic (QA, 2026-11-26): which core events reach the page after the lock opens.
await page.evaluate(() => { window.__ev = []; window.mvs.onEvent?.((name) => window.__ev.push(`${Math.round(performance.now() / 1000)}s ${name}`)); });

async function invoke(cmd, ...args) {
  const res = await page.evaluate(([c, a]) => window.mvs.invoke(c, a), [cmd, args]);
  if (res?.error) throw new Error(`${cmd}: ${JSON.stringify(res.error)}`);
  return res.ok;
}

/** Wraps RTCPeerConnection so the test can read the engine's connections. */
async function watchPeerConnections() {
  await page.evaluate(() => {
    if (window.__pcs) return;
    window.__pcs = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) {
      const pc = new Native(...a);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Native);
  });
}

/** G-63/G-64: records every tone the UI plays (its cues are oscillator notes). */
async function watchTones() {
  await page.evaluate(() => {
    if (window.__tones) return;
    window.__tones = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...a) {
      window.__tones.push({ f: Math.round(this.frequency.value), at: Date.now() });
      return start.apply(this, a);
    };
  });
}
const tonesSince = (at) => page.evaluate((t) => (window.__tones ?? []).filter((x) => x.at >= t).map((x) => x.f), at);
const CUE = { join: [523, 784], leave: [659, 440] };
const heard = (fs, cue) => cue.every((f) => fs.includes(f));

/** Per live connection: state, the SDP's fingerprint, the presented cert, and audio counters. */
function connectionReport() {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach((s) => byId.set(s.id, s));
      let pair, transport;
      const inbound = [];
      const outbound = [];
      stats.forEach((s) => {
        if (s.type === 'transport') transport = s;
        if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound.push(s);
        if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound.push(s);
      });
      if (transport?.selectedCandidatePairId) pair = byId.get(transport.selectedCandidatePairId);
      const remoteCert = transport?.remoteCertificateId ? byId.get(transport.remoteCertificateId) : null;
      const sdpFp = /a=fingerprint:(\S+) (\S+)/i.exec(pc.remoteDescription?.sdp ?? '');
      const local = pair ? byId.get(pair.localCandidateId) : null;
      const remote = pair ? byId.get(pair.remoteCandidateId) : null;
      out.push({
        state: pc.connectionState,
        ice: pc.iceConnectionState,
        dtls: transport?.dtlsState ?? null,
        sdpFingerprint: sdpFp ? `${sdpFp[1].toLowerCase()} ${sdpFp[2].toUpperCase()}` : null,
        certFingerprint: remoteCert ? `${remoteCert.fingerprintAlgorithm.toLowerCase()} ${remoteCert.fingerprint.toUpperCase()}` : null,
        candidates: local && remote ? `${local.candidateType}/${local.protocol} -> ${remote.candidateType}/${remote.protocol}` : null,
        // G-81: the selected pair's candidate types only (never addresses).
        localType: local?.candidateType ?? null,
        remoteType: remote?.candidateType ?? null,
        bytesIn: inbound.reduce((n, s) => n + (s.bytesReceived ?? 0), 0),
        packetsIn: inbound.reduce((n, s) => n + (s.packetsReceived ?? 0), 0),
        energyIn: inbound.reduce((n, s) => n + (s.totalAudioEnergy ?? 0), 0),
        bytesOut: outbound.reduce((n, s) => n + (s.bytesSent ?? 0), 0),
        codec: inbound[0]?.codecId ? byId.get(inbound[0].codecId)?.mimeType ?? null : null,
        role: pc.localDescription?.type ?? null,
        transceivers: pc.getTransceivers().map((t) => ({
          mid: t.mid,
          direction: t.direction,
          current: t.currentDirection,
          track: t.sender.track ? `${t.sender.track.readyState}${t.sender.track.enabled ? '' : ' (disabled)'}` : null,
        })),
      });
    }
    return out;
  });
}
const live = async () => (await connectionReport()).filter((c) => c.state !== 'failed');

// ---- mvs-core's sockets (V3) -------------------------------------------------

const relayIp = (await lookup('relay')).address;

/** The socket inodes held by processes named mvs-core in this container. */
function coreInodes() {
  const out = new Set();
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'mvs-core') continue;
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) out.add(m[1]);
      }
    } catch {
      // gone, or not ours
    }
  }
  return out;
}

function addr(hex) {
  if (hex.length === 8) return hex.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.');
  if (/^0{20}FFFF0{4}/i.test(hex) || /^0{16}0{4}FFFF/i.test(hex)) return addr(hex.slice(24));
  if (/^0+$/.test(hex)) return '::';
  if (/^0{24}01000000$/i.test(hex)) return '::1';
  return `v6:${hex}`;
}

/** mvs-core's TCP links and its TCP/UDP listeners, from /proc/net. */
function sockets() {
  const mine = coreInodes();
  const established = [];
  const listening = [];
  for (const proto of ['tcp', 'tcp6', 'udp', 'udp6']) {
    let lines;
    try {
      lines = readFileSync(`/proc/net/${proto}`, 'utf8').trim().split('\n').slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      if (!mine.has(f[9])) continue;
      const [lh, lp] = f[1].split(':');
      const [rh] = f[2].split(':');
      const s = { proto, local: addr(lh), port: parseInt(lp, 16) };
      if (proto.startsWith('tcp') && f[3] === '0A') listening.push(s);
      else if (proto.startsWith('udp') && f[3] === '07' && /^0+$/.test(f[2].replace(':', ''))) listening.push(s);
      else if (proto.startsWith('tcp') && f[3] === '01') established.push({ ...s, remote: addr(rh) });
    }
  }
  return { established, listening };
}

// ---- the shell's file log (CHECK_LOG=1) ----------------------------------------

/**
 * mvs.log (desktop/src/logfile.js): the join steps at info, sync's debug lines
 * with MVS_DEBUG_LOG=1, and nothing that says where or who someone is.
 */
function checkFileLog() {
  const files = execSync(`find ${PROFILE} ${process.env.HOME} -name 'mvs.log*' -type f 2>/dev/null || true`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync(join(RV, `mvslog-${ROLE}.txt`), text);
  const lines = text.split('\n').filter(Boolean);
  record(files.length ? 'PASS' : 'FAIL', 'LOG.0', 'mvs.log exists', `${files.length} file(s), ${lines.length} lines`);
  const joinLines = lines.filter((l) => /join/i.test(l) && !/joinCall|call/i.test(l));
  if (ROLE === 'b') {
    record(joinLines.length ? 'PASS' : 'FAIL', 'LOG.1', 'the join steps are in mvs.log at info', joinLines.slice(0, 4).map((l) => l.slice(25, 140)).join(' / ') || 'none');
  }
  const debug = lines.filter((l) => /\bDEBUG\b/.test(l) && /sync/.test(l));
  if (process.env.MVS_DEBUG_LOG === '1') record(debug.length ? 'PASS' : 'FAIL', 'LOG.2', 'MVS_DEBUG_LOG=1: sync debug lines in mvs.log', `${debug.length} lines`);
  else record(debug.length ? 'FAIL' : 'PASS', 'LOG.2', 'without MVS_DEBUG_LOG: no sync debug lines', `${debug.length} lines`);
  const leaks = [];
  const scan = (name, re) => {
    const hits = lines.filter((l) => re.test(l.slice(24))); // skip the timestamp
    if (hits.length) leaks.push(`${name}: ${hits.length} (e.g. ${hits[0].slice(24, 120).replace(re, '«…»')})`);
  };
  scan('IPv4 (or IP:port)', /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  // sync=debug prints SocketAddrs: [v6]:port, and bare v6 outside a multiaddr.
  scan('IPv6 (or [IPv6]:port)', /\[[0-9a-f:.%]*:[0-9a-f:.%]*\]|(?<![0-9A-Za-z_:])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){7})[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![0-9A-Za-z_])(?<=[0-9a-f])/i);
  scan('invite link', /mv[sp]:\/\/join\/(?!<)/i);
  scan('peer ID', /\b(?:12D3KooW|Qm)[1-9A-HJ-NP-Za-km-z]{40,}/);
  scan('64-hex ID', /\b[0-9a-f]{64}\b/i);
  if (serverId) scan('server ID', new RegExp(serverId.slice(0, 16), 'i'));
  scan('relay multiaddr host', /\/dns4?\/(?!<host>)[^/\s]+/);
  record(leaks.length ? 'FAIL' : 'PASS', 'LOG.3', 'mvs.log is redacted (no IPs, peer IDs, server IDs, hosts)', leaks.join('; ') || `${lines.length} lines checked`);
}

// ---- UI --------------------------------------------------------------------

// Voice rooms (0.4.3): the pinned "Join chat" row opens a new room; a room's row joins it.
const entry = () => page.locator('.voice-root');
const roomRow = () => page.locator('.voice-room-row').first();
/** The first live room in the server, through the bridge. */
const firstRoom = async () => (await invoke('listVoiceRooms', serverId))[0];
const roster = () => page.locator('ul.voice-room-people > li');
const rosterNames = () => roster().locator('.call-person').allInnerTexts();
async function rosterHas(names) {
  const got = (await rosterNames()).map((t) => t.trim());
  return names.every((n) => got.some((g) => g.startsWith(n))) && got.length === names.length ? got : null;
}

/** Joins as a user does: Home → "Join with a link" → paste → Join. Logs what the dialog shows. */
async function joinFromDialog(link) {
  await page.reload();
  await page.waitForFunction(() => typeof window.mvs?.invoke === 'function');
  await page.getByRole('button', { name: /^(Join with a link|הצטרפות בלינק)/ }).first().click({ timeout: 30_000 });
  await page.getByLabel(/^(Invite link|לינק הזמנה)$/).fill(link);
  await page.getByRole('button', { name: /^(Join|הצטרפות)$/ }).click();
  // Record each new text the dialog shows until the server is in the rail.
  const seen = [];
  const end = Date.now() + 120_000;
  const railButton = page.getByRole('button', { name: new RegExp(`^${SERVER}`) });
  while (Date.now() < end) {
    const text = (await page.getByRole('dialog').allInnerTexts().catch(() => [])).join(' | ').replace(/\s+/g, ' ').slice(0, 160);
    if (text && text !== seen[seen.length - 1]) {
      seen.push(text);
      log(`join dialog: ${text}`);
    }
    if (await railButton.count()) break;
    await sleep(250);
  }
  log(`join dialog states: ${seen.length}; server in the rail: ${(await railButton.count()) > 0}`);
  if (!(await railButton.count())) await page.screenshot({ path: join(RV, `${ROLE}-join-stuck.png`) }).catch(() => {});
}

async function openServer() {
  await page.reload();
  await page.waitForFunction(() => typeof window.mvs?.invoke === 'function');
  const rail = page.locator('nav').filter({ has: page.getByRole('button', { name: new RegExp(`^${SERVER}`) }) }).first();
  await rail.getByRole('button', { name: new RegExp(`^${SERVER}`) }).click({ timeout: 30_000 });
  await entry().waitFor({ timeout: 30_000 });
}

/** A opens the room (it takes turns: A is in first), B joins A's room from its row. */
async function joinViaUi() {
  await watchPeerConnections();
  if (ROLE === 'a') await entry().click();
  else {
    await roomRow().waitFor({ timeout: 30_000 });
    await roomRow().click();
  }
  // First call on this computer: the IP notice (#225) comes before any join.
  const notice = page.locator('.ip-notice');
  await check('V6.1', 'the IP notice shows before the first join, and no call starts until OK', async () => {
    await notice.waitFor({ timeout: 10_000 });
    await sleep(1000);
    if (await page.locator('.call-bar').count()) throw new Error('the call bar showed before OK');
    const pcs = await page.evaluate(() => window.__pcs.length);
    if (pcs) throw new Error(`${pcs} peer connection(s) before OK`);
  });
  await notice.locator('button.primary').click();
  joinedAt = Date.now();
  await check('V6.3', 'after OK: joined, the notice is remembered, focus on Mute', async () => {
    await page.locator('.call-bar').waitFor({ timeout: 15_000 });
    const key = await page.evaluate(() => localStorage.getItem('mvs.notices.voiceIp.v2'));
    if (key !== '1') throw new Error(`mvs.notices.voiceIp.v2 = ${key}`);
    const focused = await page.evaluate(() => document.activeElement?.classList.contains('call-mute'));
    return focused ? 'focus on Mute' : 'joined (focus not on Mute)';
  });
}

/** Mic, camera and screen from the page, as the shell's permission handler answers. */
const PROBES = {
  mic: { audio: true },
  camera: { video: true },
  micAndCamera: { audio: true, video: true },
  screen: { display: { video: true } },
  screenAudio: { display: { video: true, audio: true } },
  desktopAudio: { audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: false },
};
/** One request; a request that never settles counts as "no answer" (not granted, but noted). */
async function probeOne(name) {
  const attempt = page.evaluate(async (c) => {
    try {
      const s = c.display ? await navigator.mediaDevices.getDisplayMedia(c.display) : await navigator.mediaDevices.getUserMedia(c);
      s.getTracks().forEach((t) => t.stop());
      return 'granted';
    } catch (e) {
      return `refused (${e.name})`;
    }
  }, PROBES[name]);
  attempt.catch(() => {});
  const res = await Promise.race([attempt, sleep(6000).then(() => 'no answer in 6 s')]);
  log(`probe ${name}: ${res}`);
  return res;
}
async function mediaProbe(names = Object.keys(PROBES)) {
  const out = {};
  for (const n of names) out[n] = await probeOne(n);
  return out;
}

// ---- the scenario ------------------------------------------------------------

let ok = true;
let serverId;
let memberId; // the owner learns B's id from the rendezvous, for MR.1
try {
  scenario: {
  log('setting up the account');
  // MODE=restore: B restores A's words (the same identity on a second computer).
  let words = null;
  if (!(ROLE === 'b' && MODE === 'restore')) {
    await invoke('createIdentity', { locale: 'he', country: 'IL', birthDate: '1995-03-03' });
    words = await invoke('getRecoveryWords');
    const challenge = await invoke('getRecoveryChallenge').catch(() => null);
    const positions = challenge?.positions ?? [1, 5, 9];
    await invoke('checkRecoveryWords', Object.fromEntries(positions.map((p) => [p, words[p - 1]])));
    await invoke('updateProfile', { displayName: NAME[ROLE] });
  }

  if (ROLE === 'a') {
    const server = await invoke('createServer', { name: SERVER, ageRestriction: 'none' });
    serverId = server.id;
    put('invite', { link: server.inviteLink, ...(MODE === 'restore' ? { words } : {}) });
    log('server created, invite handed over');
    memberId = (await take('joined')).id;
  } else {
    const { link, words: ownerWords } = await take('invite');
    if (MODE === 'restore') {
      const me = await invoke('restoreIdentity', ownerWords);
      log(`restored the owner's identity (${me.id.slice(0, 8)})`);
    }
    const started = Date.now();
    if (JOIN_VIA === 'ui') await joinFromDialog(link);
    else await invoke('joinServer', link);
    const ok1 = await check('S1.1', 'B joins A\'s server by invite over the relay', async () => {
      await until('server in the list', async () => (await invoke('listServers')).some((s) => s.name === SERVER), 120_000, 1000);
      return `${((Date.now() - started) / 1000).toFixed(1)} s`;
    });
    if (!ok1) throw new Error('join failed');
    serverId = (await invoke('listServers')).find((s) => s.name === SERVER).id;
    put('joined', { id: (await invoke('getIdentity')).id });
  }
  if (JOIN_ONLY) break scenario;

  // 0.4.6: an owner sees the member-relay disclosure (modal) once a member
  // is there; it has to be answered before anything else can be clicked.
  if (ROLE === 'a') {
    await check('MR.1', 'the owner sees the "Relay for your members" disclosure; OK closes it and relaying stays on', async () => {
      // The disclosure comes once the OWNER's core has the member, which can
      // be well after B sees the server: wait for that first, then for it.
      const t0 = Date.now();
      await until('the member in the owner\'s list', async () => (await invoke('listMembers', serverId)).some((m) => m.id === memberId), 120_000, 1000);
      const seenAfter = ((Date.now() - t0) / 1000).toFixed(1);
      // The UI opens it when the core says relaying is (or would be) on:
      // effective, or `role` (an owner with members), set on the core's tick.
      const due = await until('the core reports member relaying due', async () => {
        const r = await invoke('getMemberRelay');
        return r && (r.effective || r.role) ? r : null;
      }, 120_000, 1000);
      const dueAfter = ((Date.now() - t0) / 1000).toFixed(1);
      log(`the owner had the member ${seenAfter} s, and relaying was due ${dueAfter} s, after B's "joined" (${JSON.stringify(due)})`);
      log(`events the page got so far: ${JSON.stringify(await page.evaluate(() => (window.__ev ?? []).slice(-40)))}`);
      const dlg = page.locator('dialog.member-relay-disclosure');
      // Diagnostic (QA, 2026-11-26): how long after "due" the UI shows it.
      const tDue = Date.now();
      await dlg.waitFor({ state: 'visible', timeout: 120_000 });
      const lag = (Date.now() - tDue) / 1000;
      log(`the disclosure showed ${lag.toFixed(1)} s after the core said relaying was due`);
      if (lag > 15) throw new Error(`the disclosure showed ${lag.toFixed(1)} s after the core said relaying was due (UI lag)`);
      await dlg.getByRole('button', { name: /^(OK|הבנתי|אישור)$/ }).click();
      await dlg.waitFor({ state: 'hidden', timeout: 10_000 });
      const mr = await invoke('getMemberRelay').catch(() => null);
      if (mr && (!mr.disclosureSeen || !mr.effective)) throw new Error(JSON.stringify(mr));
      return mr ? `disclosureSeen ${mr.disclosureSeen}, effective ${mr.effective}` : 'closed';
    });
  }

  await openServer();
  log('server open in the UI');
  await watchTones();

  await check('V1.1', 'one pinned "Join chat" row with the speaker icon in the sidebar', async () => {
    const n = await entry().count();
    if (n !== 1) throw new Error(`${n} entries`);
    if (!(await entry().locator('svg').count())) throw new Error('no icon');
    return (await entry().getAttribute('aria-label')) ?? '';
  });
  await check('V5.9', 'no microphone outside a call (V-C2)', async () => {
    const p = await mediaProbe(['mic']);
    if (p.mic === 'granted') throw new Error(JSON.stringify(p));
    return p.mic;
  });

  if (ROLE === 'a') {
    await joinViaUi();
    await check('V2.1', 'A is in the roster after joining', () => until('A in roster', () => rosterHas([NAME.a]), 20_000));
    put('in');
    await take('in');
  } else {
    await take('in');
    await check('V1.4', 'B, not in the call, sees A in the roster', () => until('A in roster', () => rosterHas([NAME.a]), 30_000));
    await joinViaUi();
    put('in');
  }

  await check('V1.4', 'both people show in the roster', () => until('2 in roster', () => rosterHas([NAME.a, NAME.b]), 30_000));
  if (ROLE === 'a') {
    await check('G64.1', 'A hears the join cue (two rising notes) when B joins', () =>
      until('join cue', async () => heard(await tonesSince(0), CUE.join) && (await tonesSince(0)).join(','), 10_000),
    );
  } else {
    await check('G64.2', 'B hears no join cue for its own join', async () => {
      await sleep(1500);
      const f = await tonesSince(0);
      if (heard(f, CUE.join)) throw new Error(f.join(','));
      return f.join(',') || 'no tones';
    });
  }
  await check('V2.1', 'the call bar is up with Mute and Leave', async () => {
    await page.locator('.call-bar .call-mute').waitFor({ timeout: 5000 });
    await page.locator('.call-bar .call-leave').waitFor({ timeout: 5000 });
  });

  // Voice rooms (0.4.4): the owner renames the room and sets its limit, both sides see it,
  // and a member who is neither the host nor the owner can't edit it.
  const rowShows = async () => {
    const t = await roomRow().innerText().catch(() => '');
    return /QA room/.test(t) && /2\/2/.test(t) ? t.replace(/\s+/g, ' ') : null;
  };
  if (ROLE === 'a') {
    await check('VR.1', 'the owner renames the room and sets its limit to 2', async () => {
      await invoke('editVoiceRoom', (await firstRoom()).roomId, 'QA room', 2);
      return until('edit shown', rowShows, 15_000);
    });
    put('edited');
  } else {
    await take('edited');
    await check('VR.2', 'B sees the new name and 2/2', () => until('edit seen', rowShows, 15_000));
    await check('VR.3', 'a member (not host, not owner) can\'t edit the room', async () => {
      const res = await invoke('editVoiceRoom', (await firstRoom()).roomId, 'B was here', 3).then(
        () => 'accepted',
        (e) => `refused: ${e?.code ?? e?.message ?? e}`,
      );
      if (res === 'accepted') throw new Error('editVoiceRoom accepted from a member');
      return res;
    });
  }

  let connectedAfterMs = 0;
  /** Local candidate types per connection, from the SDP: "udp host" etc. Never an address. */
  const localCandidateTypes = () =>
    page.evaluate(() =>
      (window.__pcs ?? [])
        .filter((pc) => pc.connectionState !== 'closed')
        .map((pc) => (pc.localDescription?.sdp.match(/a=candidate:[^\r\n]*/g) ?? []).map((c) => { const f = c.split(' '); return `${f[2].toLowerCase()} ${f[7]}`; })),
    );
  if (EXPECT_CONNECT === 'none') {
    const from = Date.now();
    await check('G81.3', `the call fails cleanly: "no voice connection" within ${CONNECT_FAIL_MAX_MS / 1000} s, never connected, no relay candidate`, async () => {
      await until('peer-failed shown', async () => (await page.locator('.call-peer-failed').count()) > 0, CONNECT_FAIL_MAX_MS, 250);
      const took = `${((Date.now() - from) / 1000).toFixed(1)} s`;
      if ((await live()).some((x) => x.state === 'connected')) throw new Error(`a connection reached "connected" (${took})`);
      const types = (await localCandidateTypes()).flat();
      if (types.some((t) => t.endsWith(' relay'))) throw new Error(`a relay candidate: ${types.join(', ')}`);
      return `shown after ${took}; local ${[...new Set(types)].join(', ') || 'none'}`;
    });
  }
  const connected = EXPECT_CONNECT === 'none' ? false : await check('V2.2', 'the WebRTC connection to the other side reaches "connected"', async () => {
    const c = await until('connected', async () => (await live()).find((x) => x.state === 'connected'), 45_000, 250);
    if (joinedAt) connectedAfterMs = Date.now() - joinedAt;
    return `${c.candidates}, dtls ${c.dtls}`;
  });
  if (!connected) {
    // What the engine's connections got to: offer/answer exchanged? candidates?
    const diag = await page.evaluate(() =>
      (window.__pcs ?? []).map((pc) => ({
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
        local: pc.localDescription?.type ?? null,
        remote: pc.remoteDescription?.type ?? null,
        // Protocol and type only (fields 3 and 8): never the candidate's address or port.
        localCandidates: (pc.localDescription?.sdp.match(/a=candidate:[^\r\n]*/g) ?? []).map((c) => { const f = c.split(' '); return `${f[2]} ${f[7]}`; }),
        remoteCandidates: (pc.remoteDescription?.sdp.match(/a=candidate:[^\r\n]*/g) ?? []).map((c) => { const f = c.split(' '); return `${f[2]} ${f[7]}`; }),
      })),
    );
    log('peer connections:', JSON.stringify(diag));
    log('peer failures shown:', JSON.stringify(await page.locator('.call-peer-failed').allInnerTexts()));
  }
  if (connected) {
    await check('V2.2', 'the presented DTLS certificate matches the signed SDP fingerprint', async () => {
      await sleep(3000); // the engine's own getStats check runs once connected
      const c = (await live()).find((x) => x.state === 'connected');
      if (!c) throw new Error('the connection was dropped after connecting (engine refused it?)');
      if (!c.sdpFingerprint || !c.certFingerprint) throw new Error(JSON.stringify(c));
      if (c.sdpFingerprint !== c.certFingerprint) throw new Error(`${c.sdpFingerprint} != ${c.certFingerprint}`);
      if (await page.locator('.call-peer-failed').count()) throw new Error(await page.locator('.call-peer-failed').innerText());
      return c.certFingerprint.split(' ')[0];
    });
    // G-81: the path the call took, direct (host/srflx/prflx on both ends) or
    // through a TURN relay; types only, never an address.
    await check('G81.1', `the call's path is ${EXPECT_PATH || 'reported'} (direct = host/srflx/prflx, relay = TURN)`, async () => {
      const c = (await live()).find((x) => x.state === 'connected');
      if (!c?.localType || !c?.remoteType) throw new Error('no selected candidate pair');
      const known = ['host', 'srflx', 'prflx', 'relay'];
      if (!known.includes(c.localType) || !known.includes(c.remoteType)) throw new Error(`unknown candidate type ${c.localType}/${c.remoteType}`);
      const path = c.localType === 'relay' || c.remoteType === 'relay' ? 'relay' : 'direct';
      const detail = `${path} (${c.localType} -> ${c.remoteType})`;
      if (/\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{1,4}:/i.test(detail)) throw new Error('an address reached the report');
      if (EXPECT_PATH && path !== EXPECT_PATH) throw new Error(`expected ${EXPECT_PATH}, got ${detail}`);
      return detail;
    });
    // The joiner (b) measures setup: from its OK to "connected" (PO, #426: under 10 s at p95).
    if (ROLE === 'b') {
      await check('G81.2', `call setup under ${SETUP_MAX_MS / 1000} s (OK to connected, the joiner)`, () => {
        if (!connectedAfterMs) throw new Error('no setup time measured');
        if (connectedAfterMs > SETUP_MAX_MS) throw new Error(`${(connectedAfterMs / 1000).toFixed(1)} s`);
        return `${(connectedAfterMs / 1000).toFixed(1)} s`;
      });
    }
    await check('V2.2', 'audio arrives from the other side (inbound RTP bytes and audio energy growing)', async () => {
      const a1 = (await live()).find((x) => x.state === 'connected');
      await sleep(3000);
      const a2 = (await live()).find((x) => x.state === 'connected');
      if (!(a2.bytesIn > 0)) throw new Error(`bytesIn ${a2.bytesIn}; my side is the ${a2.role}: ${JSON.stringify(a2.transceivers)}`);
      if (!(a2.bytesIn > a1.bytesIn)) throw new Error(`not growing: ${a1.bytesIn} -> ${a2.bytesIn}`);
      // Bytes alone could be silence: the fake microphone beeps, so energy must grow.
      const energy = a2.energyIn - a1.energyIn;
      if (!(energy > 0)) throw new Error(`no audio energy in 3 s (bytes ${a2.bytesIn}); my side is the ${a2.role}`);
      return `${a2.bytesIn} B in, ${a2.packetsIn} packets, energy +${energy.toExponential(2)} in 3 s, ${a2.codec}, as the ${a2.role}`;
    });
    await check('V2.2', 'my microphone audio goes out (outbound RTP bytes > 0)', async () => {
      const c = (await live()).find((x) => x.state === 'connected');
      if (!(c?.bytesOut > 0)) throw new Error(`bytesOut ${c?.bytesOut}; my side is the ${c?.role}: ${JSON.stringify(c?.transceivers)}`);
      return `${c.bytesOut} B out as the ${c.role}`;
    });
  }

  // N10 (Security Lead): STUN only, so my candidates are host and srflx, and
  // one host per transport. Types only, never an address.
  await check('G81.5', 'my local candidates are only host and srflx, one host per transport', async () => {
    const per = await localCandidateTypes();
    if (!per.length || per.every((l) => !l.length)) throw new Error('no local candidates');
    for (const list of per) {
      const bad = list.filter((t) => !/ (host|srflx)$/.test(t));
      if (bad.length) throw new Error(`not host/srflx: ${bad.join(', ')}`);
      const hosts = {};
      for (const t of list.filter((x) => x.endsWith(' host'))) hosts[t.split(' ')[0]] = (hosts[t.split(' ')[0]] ?? 0) + 1;
      const many = Object.entries(hosts).filter(([, n]) => n !== 1);
      if (many.length) throw new Error(`hosts per transport: ${JSON.stringify(hosts)}`);
    }
    return per.map((l) => [...new Set(l)].join(' + ')).join('; ');
  });

  // G-81 STUN diagnostics (#496): the call bar's voice settings, "connection diagnostics".
  if (EXPECT_STUN) {
    await check('G81.4', `the connection diagnostics show STUN ${EXPECT_STUN}`, async () => {
      await page.locator('.call-bar .call-settings').click();
      const dlg = page.locator('dialog.voice-settings, .voice-settings[role="dialog"]').first();
      await dlg.waitFor({ state: 'visible', timeout: 5000 });
      const diag = dlg.locator('details.voice-diag');
      if (!(await diag.count())) throw new Error('no details.voice-diag (needs #496)');
      if (!(await diag.evaluate((d) => d.open))) await diag.locator('summary').click();
      const stun = diag.locator('.diag-stun');
      await stun.waitFor({ state: 'visible', timeout: 15_000 });
      // Give a pending probe a moment to settle, then read the class only.
      await sleep(2000);
      const cls = (await stun.getAttribute('class')) ?? '';
      const got = /\berror\b/.test(cls) ? 'unreachable' : 'answered';
      await page.keyboard.press('Escape').catch(() => {});
      if (got !== EXPECT_STUN) throw new Error(`got ${got} (class "${cls}")`);
      return `class "${cls}"`;
    });
  }

  if (EXPECT_CONNECT === 'none') {
    // Nothing else can run without a connection: end here, together.
    put('g81-done');
    await take('g81-done', 60_000).catch(() => {});
    throw EARLY_END;
  }

  // Permissions while in the call: microphone yes; camera, screen, desktop audio no.
  // The legacy desktop capture (chromeMediaSource) is probed last, in V6.4:
  // Chromium kills the renderer for it.
  const probe = await mediaProbe(['mic', 'camera', 'micAndCamera', 'screen', 'screenAudio']);
  await check('V5.2', 'microphone granted to the app while in the call', () => {
    if (probe.mic !== 'granted') throw new Error(JSON.stringify(probe));
    return probe.mic;
  });
  await check('V5.3', 'camera refused (video, audio+video)', () => {
    if (probe.camera === 'granted' || probe.micAndCamera === 'granted') throw new Error(JSON.stringify(probe));
    return `${probe.camera}; ${probe.micAndCamera}`;
  });
  await check('V5.4', 'screen capture refused', () => {
    if (probe.screen === 'granted') throw new Error(probe.screen);
    return probe.screen;
  });
  await check('V5.5', 'system audio with a screen share refused', () => {
    if (probe.screenAudio === 'granted') throw new Error(probe.screenAudio);
    return probe.screenAudio;
  });

  // Mute: A mutes, B sees it and stops hearing A.
  if (ROLE === 'a') {
    await take('ready-for-mute');
    await page.locator('.call-bar .call-mute').click();
    await check('V2.3', 'A\'s Mute button is pressed', async () => {
      await until('aria-pressed', async () => (await page.locator('.call-mute').getAttribute('aria-pressed')) === 'true', 5000);
    });
    put('muted', { at: Date.now() });
    await take('saw-mute');
    await page.locator('.call-bar .call-mute').click();
    put('unmuted');
    await take('saw-unmute');
  } else {
    const before = (await live()).find((x) => x.state === 'connected');
    await sleep(3000);
    const after = (await live()).find((x) => x.state === 'connected');
    const energyUnmuted = (after?.energyIn ?? 0) - (before?.energyIn ?? 0);
    put('ready-for-mute');
    await take('muted');
    const seen = Date.now();
    await check('V2.3', 'B sees A\'s mic-off icon in the roster', async () => {
      await until('mic-off on A', async () => (await roster().filter({ hasText: NAME.a }).locator('.call-muted').count()) === 1, 15_000);
      return `${((Date.now() - seen) / 1000).toFixed(1)} s`;
    });
    await sleep(1500);
    const m1 = (await live()).find((x) => x.state === 'connected');
    await sleep(3000);
    const m2 = (await live()).find((x) => x.state === 'connected');
    const energyMuted = (m2?.energyIn ?? 0) - (m1?.energyIn ?? 0);
    await check('V2.3', 'B hears nothing from A while A is muted (audio energy)', () => {
      if (!(energyUnmuted > 0)) throw new Error(`no energy even before mute: ${energyUnmuted}`);
      if (energyMuted > energyUnmuted * 0.05) throw new Error(`muted ${energyMuted} vs unmuted ${energyUnmuted}`);
      return `energy ${energyUnmuted.toExponential(2)} -> ${energyMuted.toExponential(2)}`;
    });
    put('saw-mute');
    await take('unmuted');
    await check('V2.3', 'the mic-off icon goes away when A unmutes', () =>
      until('mic-off gone', async () => (await roster().filter({ hasText: NAME.a }).locator('.call-muted').count()) === 0, 15_000),
    );
    put('saw-unmute');
  }

  // G-74 push to talk: A picks it in Settings → Voice with the key T. Idle,
  // B hears nothing; while A holds T, B hears A. Then A goes back to open.
  const voiceSettings = async (mode) => {
    await page.locator('.me-profile').click();
    const dlg = page.locator('.settings-dialog');
    await dlg.getByRole('button', { name: /^(Voice|קול)$/ }).click();
    await dlg.getByRole('radio', { name: mode === 'ptt' ? /Push to talk|לחיצה לדיבור/ : /Voice activity|פתוח לדיבור/ }).check();
    if (mode === 'ptt') {
      const cap = dlg.locator('.key-capture').first();
      if (!(await cap.locator('kbd').count())) {
        await cap.click();
        await page.keyboard.press('KeyT');
        await until('key captured', async () => (await cap.locator('kbd').count()) === 1, 5000);
      }
    }
    await dlg.getByRole('button', { name: /^(Close|סגירה)$/ }).first().click();
    await dlg.waitFor({ state: 'hidden', timeout: 5000 });
  };
  const energyOver = async (ms) => {
    const a = (await live()).find((x) => x.state === 'connected');
    await sleep(ms);
    const b = (await live()).find((x) => x.state === 'connected');
    return (b?.energyIn ?? 0) - (a?.energyIn ?? 0);
  };
  if (ROLE === 'a') {
    const set = await check('G74.1', 'A turns on push to talk with the key T (Settings → Voice)', async () => {
      await voiceSettings('ptt');
      if ((await page.locator('.call-mute').getAttribute('aria-pressed')) === 'true') throw new Error('the mute button turned on');
      return 'mute button still off';
    });
    put('ptt-idle', { set });
    await take('ptt-measured');
    if (set) {
      await page.keyboard.down('KeyT');
      await check('G74.2', 'holding T shows A as talking on the mute button', () =>
        until('talking', async () => /\btalking\b/.test((await page.locator('.call-mute').getAttribute('class')) ?? ''), 5000),
      );
    }
    put('ptt-held');
    await take('ptt-heard');
    if (set) {
      await page.keyboard.up('KeyT');
      await check('G74.3', 'letting go of T ends talking (after the release delay)', () =>
        until('not talking', async () => !/\btalking\b/.test((await page.locator('.call-mute').getAttribute('class')) ?? ''), 3000),
      );
      await check('G74.4', 'A goes back to voice activity', () => voiceSettings('open').then(() => 'open'));
    }
    put('ptt-done');
  } else {
    const { set } = await take('ptt-idle');
    await sleep(1500);
    const idle = await energyOver(3000);
    put('ptt-measured');
    await take('ptt-held');
    await sleep(1500);
    const held = await energyOver(3000);
    put('ptt-heard');
    if (set) {
      await check('G74.5', 'B hears nothing from A while push to talk is idle, and hears A while T is held', () => {
        if (!(held > 0)) throw new Error(`no energy while held: ${held}`);
        if (idle > held * 0.05) throw new Error(`idle ${idle} vs held ${held}`);
        return `energy idle ${idle.toExponential(2)}, held ${held.toExponential(2)}`;
      });
    }
    await take('ptt-done');
  }

  // #513 (engine lift): a call survives opening Home. A opens Home; the call
  // stays up and B still hears A; back on the server it's the same call.
  if (ROLE === 'a') {
    await page.locator('.rail-home').first().click();
    const onHome = await check('G78H.1', 'A opens Home in a call: the connection stays up and A still hears B', async () => {
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 10_000 }).catch(() => {});
      await sleep(1500);
      const e = await energyOver(3000);
      if (!(await live()).some((x) => x.state === 'connected')) throw new Error('no connected peer on Home');
      if (!(e > 0)) throw new Error(`no audio energy from B on Home: ${e}`);
      return `energy ${e.toExponential(2)} in 3 s on Home`;
    });
    put('on-home', { onHome });
    await take('home-heard');
    const rail = page.locator('nav').filter({ has: page.getByRole('button', { name: new RegExp(`^${SERVER}`) }) }).first();
    await rail.getByRole('button', { name: new RegExp(`^${SERVER}`) }).click();
    await check('G78H.2', 'back on the server: the call bar is up and both are still in the roster', async () => {
      await page.locator('.call-bar .call-leave').waitFor({ timeout: 10_000 });
      await until('2 in roster', () => rosterHas([NAME.a, NAME.b]), 10_000);
      return 'same call';
    });
    put('home-back');
  } else {
    await take('on-home');
    await sleep(1500);
    const e = await energyOver(3000);
    await check('G78H.3', 'B still hears A while A is on Home', () => {
      if (!(e > 0)) throw new Error(`no audio energy from A: ${e}`);
      return `energy ${e.toExponential(2)} in 3 s`;
    });
    put('home-heard');
    await take('home-back');
  }

  // Leave: B leaves first; then A leaves while B watches from outside the call.
  if (ROLE === 'b') {
    await page.locator('.call-bar .call-leave').click();
    await check('V2.4', 'B\'s call bar goes away and "Join chat" is available again', async () => {
      await page.locator('.call-bar').waitFor({ state: 'detached', timeout: 10_000 });
      await until('entry enabled', async () => (await entry().getAttribute('aria-disabled')) !== 'true', 5000);
    });
    await check('V2.4', 'B, now outside, still sees A alone in the roster', () => until('A only', () => rosterHas([NAME.a]), 15_000));
    await check('V2.4', 'B\'s peer connection is closed after leaving', async () => {
      const left = await live();
      if (left.some((c) => c.state === 'connected')) throw new Error(JSON.stringify(left));
    });
    await check('V5.9', 'B has no microphone after leaving (V-C2)', async () => {
      const p = await mediaProbe(['mic']);
      if (p.mic === 'granted') throw new Error(p.mic);
      return p.mic;
    });
    put('left', { at: Date.now() });
    await take('left');
    const at = Date.now();
    await check('V2.4', 'when A leaves too, B sees the roster empty', async () => {
      await until('roster empty', async () => (await roster().count()) === 0, 15_000);
      return `${((Date.now() - at) / 1000).toFixed(1)} s`;
    });
    await check('VR.4', 'B sees the room end when everyone has left (no row)', () =>
      until('no room row', async () => (await page.locator('.voice-room-row').count()) === 0, 15_000),
    );
    put('saw-empty');
  } else {
    const { at } = await take('left');
    await check('V2.4', 'A sees B leave the roster', async () => {
      await until('B gone', () => rosterHas([NAME.a]), 15_000);
      return `about ${((Date.now() - at) / 1000).toFixed(1)} s after B's click`;
    });
    await check('G64.3', 'A hears the leave cue (two falling notes) when B leaves', () =>
      until('leave cue', async () => heard(await tonesSince(at - 2000), CUE.leave) && (await tonesSince(at - 2000)).join(','), 10_000),
    );
    await check('V2.4', 'A\'s connection to B ends', () =>
      until('no live connection', async () => !(await live()).some((c) => c.state === 'connected'), 30_000),
    );
    await page.locator('.call-bar .call-leave').click();
    await check('V2.4', 'A\'s call bar goes away and the roster is empty', async () => {
      await page.locator('.call-bar').waitFor({ state: 'detached', timeout: 10_000 });
      await until('roster empty', async () => (await roster().count()) === 0, 10_000);
    });
    await check('VR.4', 'the room ends when everyone has left (no room in the core, no row)', () =>
      until(
        'no rooms',
        async () => (await invoke('listVoiceRooms', serverId)).length === 0 && (await page.locator('.voice-room-row').count()) === 0,
        15_000,
      ),
    );
    put('left');
    // Rejoining (V6.4) before B has seen the empty roster would race its check.
    await take('saw-empty');
  }

  await check('V6.4', 'a second join needs no IP notice (it was remembered)', async () => {
    await entry().click();
    await page.locator('.call-bar').waitFor({ timeout: 15_000 });
    if (await page.locator('.ip-notice').isVisible()) throw new Error('the notice came back');
    await page.locator('.call-bar .call-leave').click();
    await page.locator('.call-bar').waitFor({ state: 'detached', timeout: 10_000 });
  });

  // V3: B turns relay-only on (A stays outside): the room entry is off up
  // front, the core refuses the join, and B's core keeps no direct link.
  if (ROLE === 'b') {
    const before = sockets();
    await invoke('setRelayOnly', true);
    await check('V3.1', 'relay-only: "Join chat" is disabled up front, with the reason', async () => {
      await until('entry disabled', async () => (await entry().getAttribute('aria-disabled')) === 'true', 10_000);
      const reason = await page.locator('.voice-room-reason').innerText({ timeout: 5000 });
      return reason;
    });
    await check('V3.2', 'relay-only: the core refuses to open a room', async () => {
      const res = await invoke('createVoiceRoom', serverId).then(
        () => 'joined',
        (e) => e.message,
      );
      if (!/relay-only/.test(res)) throw new Error(res);
      return res;
    });
    await check('V3.3', 'relay-only: no IP notice, and clicking the entry joins nothing', async () => {
      await entry().click({ force: true });
      await sleep(1500);
      if (await page.locator('.ip-notice').isVisible()) throw new Error('the IP notice showed');
      if (await page.locator('.call-bar').count()) throw new Error('a call started');
    });
    await check('V3.5', 'relay-only: no direct connection to A, and no direct listener', async () => {
      await sleep(3000); // turning it on closes direct links (#274)
      const now = sockets();
      const loopback = (a) => a.startsWith('127.') || a === '::1';
      const direct = now.established.filter((s) => s.remote !== relayIp && !loopback(s.remote));
      const listeners = now.listening.filter((s) => !loopback(s.local));
      log('sockets before:', JSON.stringify(before), 'after:', JSON.stringify(now));
      if (direct.length) throw new Error(`still connected to ${direct.map((s) => s.remote).join(', ')}`);
      if (listeners.length) throw new Error(`still listening on ${listeners.map((s) => `${s.proto} ${s.local}:${s.port}`).join(', ')}`);
      return `${before.established.length} -> ${now.established.length} TCP links (relay ${relayIp} only)`;
    });
    await invoke('setRelayOnly', false);
    await check('V3.1', 'relay-only off: "Join chat" is available again', () =>
      until('entry enabled', async () => (await entry().getAttribute('aria-disabled')) !== 'true', 10_000),
    );
    put('v3-done');
  } else {
    await take('v3-done');
  }

  // V4: both back in one room (A opens it, B joins it), then the owner kicks B.
  if (ROLE === 'a') {
    await entry().click();
    await page.locator('.call-bar').waitFor({ timeout: 15_000 });
    put('v4-room');
  } else {
    await take('v4-room');
    await roomRow().waitFor({ timeout: 30_000 });
    await roomRow().click();
    await page.locator('.call-bar').waitFor({ timeout: 15_000 });
  }
  await until('both in roster', () => rosterHas([NAME.a, NAME.b]), 30_000).catch(() => {});
  const room = await firstRoom();
  put('in-for-kick');
  await take('in-for-kick');
  if (ROLE === 'a') {
    const members = await invoke('listMembers', serverId);
    const b = members.find((m) => m.displayName === NAME.b);
    if (!b) throw new Error(`B is not in the member list: ${JSON.stringify(members.map((m) => m.displayName))}`);
    const at = Date.now();
    await invoke('kickMember', serverId, b.id);
    put('kicked', { at });
    await check('V4.1', 'the kicked member leaves the owner\'s roster within a tick or two (SYNC_EVERY is 2 s)', async () => {
      await until('B gone', () => rosterHas([NAME.a]), 15_000, 100);
      const s = (Date.now() - at) / 1000;
      // The 30 s hello timeout would mean the kick didn't purge the entry.
      if (s > 5) throw new Error(`${s.toFixed(1)} s`);
      return `${s.toFixed(1)} s`;
    });
    await check('V4.1', 'the owner\'s connection to the kicked member ends', () =>
      until('no live connection', async () => !(await live()).some((c) => c.state === 'connected'), 30_000),
    );
    await check('V4.4', 'the owner is still in the call, alone', async () => {
      if (!(await page.locator('.call-bar').count())) throw new Error('the owner\'s call ended');
      const r = await firstRoom();
      if (r?.members.length !== 1) throw new Error(JSON.stringify(r?.members));
    });
    await take('kick-checked');
  } else {
    const { at } = await take('kicked');
    await check('V4.3', 'the kicked member\'s call ends', async () => {
      await page.locator('.call-bar').waitFor({ state: 'detached', timeout: 15_000 });
      return `${((Date.now() - at) / 1000).toFixed(1)} s after the kick`;
    });
    await check('V4.1', 'the kicked member\'s connection ends', () =>
      until('no live connection', async () => !(await live()).some((c) => c.state === 'connected'), 30_000),
    );
    const refused = async (what, fn) => {
      try {
        await fn();
      } catch (e) {
        if (/not-allowed|not-found/.test(e.message)) return e.message;
        throw e;
      }
      throw new Error(`${what} was allowed`);
    };
    await check('V4.2', 'the kicked member can\'t read the room or join the call again', async () => {
      const r1 = await until('listVoiceRooms refused', () => refused('listVoiceRooms', () => invoke('listVoiceRooms', serverId)), 15_000);
      const r2 = await refused('joinCall', () => invoke('joinCall', room.roomId));
      return `${r1}; ${r2}`;
    });
    await check('V4.3', 'the kicked member no longer sees the room\'s roster', async () => {
      await until('no roster', async () => (await roster().count()) === 0, 15_000);
    });
    await check('V5.9', 'no microphone after being kicked (V-C2)', async () => {
      const p = await mediaProbe(['mic']);
      if (p.mic === 'granted') throw new Error(p.mic);
      return p.mic;
    });
    put('kick-checked');
  }

  // Last, because Chromium may kill the renderer for it: the legacy desktop
  // capture, while in a call (the microphone is allowed then). The owner
  // only: B was kicked.
  if (ROLE === 'a') await check('V5.5', 'desktop audio (legacy chromeMediaSource) refused while in a call', async () => {
    const res = await probeOne('desktopAudio');
    if (res === 'granted') throw new Error(res);
    const crashed = await page.evaluate(() => 1).then(() => false, () => true);
    return crashed ? `${res}; the renderer was killed` : res;
  });
  }
} catch (e) {
  if (e === EARLY_END) {
    log('EXPECT_CONNECT=none: ended after the G81 checks');
  } else {
    ok = false;
    record('FAIL', 'run', 'the scenario stopped', e?.message ?? String(e));
    put('abort', { error: e?.message ?? String(e) });
  }
} finally {
  await page.screenshot({ path: join(RV, `${ROLE}-final.png`) }).catch(() => {});
  await sleep(2000);
  await app.close().catch(() => {});
  if (process.env.CHECK_LOG) checkFileLog();
  writeFileSync(join(RV, `results-${ROLE}.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(RV, `main-${ROLE}.log`), mainOut);
}

const failed = results.filter((r) => r.status === 'FAIL');
log(`${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(ok && failed.length === 0 ? 0 : 1);
