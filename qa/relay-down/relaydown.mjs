// Relay down (run.sh): owner O relays for members, members A and B.
// See run.sh for the topologies. Prints PASS/FAIL, XFAIL/XPASS (known gap),
// and INFO (a path the topology may not have).

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ROLE = process.env.ROLE;
const TOPO = process.env.TOPO ?? 'lan';
const OTHERS = ['o', 'a', 'b'].filter((r) => r !== ROLE);
const RV = '/rendezvous';
const DATA = '/home/pwuser/mvs-data';
const t0 = Date.now();
const log = (...m) => console.log(`[${ROLE} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const result = (ok, text, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${ROLE}: ${text}${detail ? ` (${detail})` : ''}`);
};
const put = (name, data = {}) => {
  const f = join(RV, `${ROLE}.${name}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(data));
  renameSync(`${f}.tmp`, f);
};
async function take(who, name, timeout = 300_000) {
  const end = Date.now() + timeout;
  const f = join(RV, `${who}.${name}.json`);
  while (Date.now() < end) {
    // A Windows bind mount can show the file a moment before it can be read.
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {}
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${who}'s ${name}`);
}

// --- the core, restartable with the same data folder ---------------------
let child;
let call;
function start(tag) {
  child = spawn('/core/mvs-core', ['--data-dir', DATA, '--relay', process.env.MVS_RELAY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: 'info,sync=debug,api=debug' },
  });
  child.stderr.pipe(createWriteStream(join(RV, `core-${ROLE}.log`), { flags: 'a' }));
  const waiting = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined || !waiting.has(m.id)) return;
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.ok);
  });
  call = (cmd, a = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject: (e) => reject(new Error(`${cmd}: ${e.message}`)) });
      child.stdin.write(`${JSON.stringify({ id, cmd, args: a })}\n`);
    });
  log(`core started (${tag})`);
}
async function stop() {
  const exited = new Promise((r) => child.once('exit', r));
  child.stdin.end();
  await Promise.race([exited, sleep(15_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let channel;
async function bodies() {
  const n = await call('getMessageCount', { channelId: channel });
  return n ? (await call('getMessages', { channelId: channel, start: 0, end: n })).messages.map((m) => m.body) : [];
}
/** Seconds until every body is seen, or null. */
async function see(list, timeout) {
  const at = Date.now();
  const end = at + timeout;
  while (Date.now() < end) {
    const got = await bodies().catch(() => []);
    if (list.every((b) => got.includes(b))) return (Date.now() - at) / 1000;
    await sleep(1000);
  }
  return null;
}
/** Must this pair still talk once the relay is down, in this topology? */
const mustTalk = (x, y) => TOPO === 'split' || (x !== 'o' && y !== 'o');

try {
  start('first');
  await call('createIdentity', { input: { locale: 'en', country: 'IL', birthDate: '1990-01-01' } });
  const words = await call('getRecoveryWords');
  const ch = await call('getRecoveryChallenge').catch(() => null);
  const pos = ch?.positions ?? [1, 5, 9];
  await call('checkRecoveryWords', { answers: Object.fromEntries(pos.map((p) => [p, words[p - 1]])) });
  await call('updateProfile', { input: { displayName: `rdown-${ROLE}` } });

  let serverId;
  if (ROLE === 'o') {
    // Cores before 0.4.6 have no member relays: say so and go on.
    const mr = await call('setMemberRelay', { setting: 'on' })
      .then(() => call('markMemberRelayDisclosureSeen'))
      .then(() => call('getMemberRelay'))
      .catch((e) => ({ unsupported: e.message }));
    if (mr.unsupported) console.log(`INFO o: no member relays in this core (${mr.unsupported})`);
    else result(mr.effective === true, 'the owner relays for members (acked)', JSON.stringify(mr));
    const s = await call('createServer', { input: { name: 'relay down', ageRestriction: 'none' } });
    serverId = s.id;
    put('ready', { link: s.inviteLink });
  } else {
    const { link } = await take('o', 'ready');
    await call('joinServer', { link });
    const end = Date.now() + 180_000;
    while (Date.now() < end && !serverId) {
      serverId = (await call('listServers')).find((s) => s.name === 'relay down')?.id;
      if (!serverId) await sleep(1000);
    }
    result(!!serverId, 'joined the owner\'s server through the relay');
  }
  channel = (await call('listChannels', { serverId }))[0].id;
  put('joined');
  for (const r of OTHERS) await take(r, 'joined');

  // Relay up: everyone talks.
  await call('sendMessage', { channelId: channel, body: `pre ${ROLE}` });
  const pre = await see(OTHERS.map((r) => `pre ${r}`), 120_000);
  const have = pre === null ? await bodies().catch(() => []) : [];
  const lacking = OTHERS.map((r) => `pre ${r}`).filter((b) => !have.includes(b));
  result(pre !== null, 'relay up: sees both others\' messages', pre === null ? `not within 120 s; missing: ${lacking.join(', ')}` : `${pre.toFixed(1)} s`);
  put('pre');
  for (const r of OTHERS) await take(r, 'pre');

  // Kill the relay (run.sh does it on the owner's word).
  if (ROLE === 'o') put('kill');
  const { at: killedAt } = await take('relay', 'killed', 120_000);
  log('relay killed');
  await sleep(5000);

  // (a) Messages after the relay is gone.
  await call('sendMessage', { channelId: channel, body: `post ${ROLE}` });
  // Wait for every other side at once, so each arrival time is its own.
  const posts = await Promise.all(
    OTHERS.map(async (r) => {
      const s = await see([`post ${r}`], 240_000);
      return { r, s, since: ((Date.now() - killedAt) / 1000).toFixed(0) };
    }),
  );
  for (const { r, s, since } of posts) {
    if (mustTalk(ROLE, r)) result(s !== null, `relay down: gets ${r}'s message`, s === null ? 'not within 240 s' : `${s.toFixed(1)} s after sending, ${since} s after the kill`);
    else console.log(`INFO ${ROLE}: relay down: ${r}'s message ${s === null ? 'not received within 240 s (no path in this topology)' : `received, ${s.toFixed(1)} s after sending, ${since} s after the kill`}`);
  }
  if (pre === null) {
    // Did the first messages, missed while the relay was up, come in later?
    const late = await bodies().catch(() => []);
    console.log(`INFO ${ROLE}: the missed first messages, after the relay-down round: ${lacking.map((b) => `${b} ${late.includes(b) ? 'now here' : 'still missing'}`).join(', ')}`);
  }
  put('post');
  for (const r of OTHERS) await take(r, 'post');

  // (b) B restarts while the relay is down.
  if (ROLE === 'b') {
    await stop();
    start('restarted, relay down');
    channel = (await call('listChannels', { serverId }))[0].id;
    put('restarted');
    await call('sendMessage', { channelId: channel, body: 'after restart b' });
    const s = await see(['after restart a'], 180_000);
    console.log(`${s === null ? 'XFAIL' : 'XPASS'} b: after a restart with the relay down, gets A's new message (${s === null ? 'offline, expected today' : `${s.toFixed(1)} s: fixed?`})`);
  } else {
    await take('b', 'restarted');
    if (ROLE === 'a') await call('sendMessage', { channelId: channel, body: 'after restart a' });
    const s = await see(['after restart b'], 180_000);
    const must = mustTalk(ROLE, 'b');
    if (must) console.log(`${s === null ? 'XFAIL' : 'XPASS'} ${ROLE}: gets the restarted B's message (${s === null ? 'offline, expected today' : `${s.toFixed(1)} s: fixed?`})`);
    else console.log(`INFO ${ROLE}: the restarted B's message ${s === null ? 'not received (no path in this topology)' : 'received'}`);
  }
  put('done');
  for (const r of OTHERS) await take(r, 'done', 400_000).catch(() => {});
} catch (e) {
  result(false, 'the check stopped', e.message);
  put('done');
}
await stop();
process.exit(failed ? 1 : 0);
