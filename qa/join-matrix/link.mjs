// Device link ("approve on your other device", #391/#393/#394/#398) between
// two cores through a throwaway relay (run.sh with SCRIPT=link.mjs).
// A is the signed-in device, B a new device with no identity.
//
// MODE=flow       a wrong code, A says "don't match", the 3-attempt lock,
//                 B says "don't match" (nothing applied), then the happy path
// MODE=expire     the code is gone after 5 minutes
// MODE=relayonly  both relay-only (run with SAME_LAN=1): the link still works,
//                 and neither side holds a TCP link to anything but the relay
//
// Nothing secret goes to /rendezvous: only codes, digits and public ids.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ROLE = process.env.ROLE;
const OTHER = ROLE === 'a' ? 'b' : 'a';
const MODE = process.env.MODE ?? 'flow';
const RV = '/rendezvous';
const t0 = Date.now();
const log = (...m) => console.log(`[${ROLE} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const result = (ok, text, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}${detail ? ` (${detail})` : ''}`);
};
const put = (name, data = {}) => {
  const f = join(RV, `${ROLE}.${name}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(data));
  renameSync(`${f}.tmp`, f);
};
async function take(name, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const f = join(RV, `${OTHER}.${name}.json`);
    // A Windows bind mount can show the file a moment before it can be read.
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {}
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${OTHER}'s ${name}`);
}

const child = spawn('/core/mvs-core', ['--data-dir', mkdtempSync(join(tmpdir(), `mvs-${ROLE}-`)), '--relay', process.env.MVS_RELAY], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, RUST_LOG: 'info,sync=debug,api=debug' },
});
child.stderr.pipe(createWriteStream(join(RV, `core-${ROLE}.log`)));
const waiting = new Map();
const events = [];
let next = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'event') {
    events.push({ at: Date.now(), event: m.event, payload: m.payload });
    if (m.event === 'deviceLink.state') log('deviceLink.state', JSON.stringify(m.payload));
    return;
  }
  if (m.id === undefined || !waiting.has(m.id)) return;
  const { resolve, reject } = waiting.get(m.id);
  waiting.delete(m.id);
  m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.ok);
});
const call = (cmd, a = {}) =>
  new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject: (e) => reject(new Error(`${cmd}: ${e.message}`)) });
    child.stdin.write(`${JSON.stringify({ id, cmd, args: a })}\n`);
  });
/** The call's error code, or 'ok'. */
const outcome = (p) =>
  p.then(
    () => 'ok',
    (e) => (/"code":"([^"]+)"/.exec(e.message)?.[1] ?? e.message),
  );
/** The next deviceLink.state after `since` matching `states`. */
async function linkState(states, since, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const e = events.find((x) => x.at >= since && x.event === 'deviceLink.state' && states.includes(x.payload?.state));
    if (e) return e.payload;
    await sleep(100);
  }
  return null;
}
const identity = () => call('getIdentity').catch(() => null);

const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BIRTH = '1990-01-01';

/** Remote IPv4s of established TCP links in this container (/proc/net/tcp). */
function tcpPeers() {
  const out = new Set();
  for (const line of readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== '01') continue;
    const hex = f[2].split(':')[0];
    out.add([3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.'));
  }
  out.delete('127.0.0.1');
  return [...out];
}

// --- A: the signed-in device ------------------------------------------------
async function signedIn() {
  await call('createIdentity', { input: { locale: 'en', country: 'IL', birthDate: BIRTH } });
  const words = await call('getRecoveryWords');
  const ch = await call('getRecoveryChallenge').catch(() => null);
  const pos = ch?.positions ?? [1, 5, 9];
  await call('checkRecoveryWords', { answers: Object.fromEntries(pos.map((p) => [p, words[p - 1]])) });
  await call('updateProfile', { input: { displayName: 'link-a', avatarSmall: PIC, color: '#12ab34' } });
  await call('createServer', { input: { name: 'link server', ageRestriction: 'none' } });
  return call('getIdentity');
}

/** A approves B's code: compares the digits with B's and answers `approve`. */
async function approve(round, code, approve) {
  const appr = await call('beginDeviceApproval', { qrOrCode: code });
  put(`sas-${round}`, { sas: appr.sas });
  const b = await take(`sas-${round}`);
  result(appr.sas === b.sas && /^\d{6}$/.test(appr.sas), `${round}: both devices show the same 6 digits`, `${appr.sas} / ${b.sas}`);
  return outcome(call('confirmDeviceApproval', { approve }));
}

// --- B: the new device -------------------------------------------------------
/** B offers a link; returns the code. */
async function offer(round) {
  const o = await call('startDeviceLink');
  result(/^[A-Z2-7]{10}$/.test(o.code) && o.expiresAt - Date.now() > 4.5 * 60_000, `${round}: B gets a 10-character code, valid for 5 minutes`, `${o.code}, ${Math.round((o.expiresAt - Date.now()) / 1000)} s`);
  put(`offer-${round}`, { code: o.code, qr: o.qr });
  return o;
}
/** B waits for the digits and shares them. */
async function digits(round, since) {
  const st = await linkState(['confirm', 'failed', 'expired'], since);
  put(`sas-${round}`, { sas: st?.sas ?? null });
  return st;
}

try {
  log(`core ${(await call('getAppInfo')).version}, mode ${MODE}`);
  if (MODE === 'relayonly') {
    await call('setRelayOnly', { on: true });
    result((await call('getAppInfo')).relayOnly === true, 'relay-only is on');
  }
  if (ROLE === 'a') {
    const me = await signedIn();
    put('ready', { id: me.id });

    if (MODE === 'flow') {
      // 1. A wrong code: not-found, and it uses no attempt.
      const { code: c1 } = await take('offer-1');
      const wrong = (c1[0] === 'A' ? 'B' : 'A') + c1.slice(1);
      const w = await outcome(call('beginDeviceApproval', { qrOrCode: wrong }));
      result(w === 'not-found', 'a wrong code is not found', w);
      // 2. A says "don't match" (attempt 1).
      const no = await approve('1', c1, false);
      result(no === 'ok', '1: A answers "don\'t match"', no);
      put('a-refused');
      await take('checked-1');
      // 3. Attempts 2 and 3 on the same link, then the 4th is refused.
      const tries = [];
      for (let i = 2; i <= 3; i++) tries.push(await outcome(call('beginDeviceApproval', { qrOrCode: c1 })));
      const fourth = await outcome(call('beginDeviceApproval', { qrOrCode: c1 }));
      result(fourth === 'rate-limited', 'after 3 attempts the link is locked (rate-limited)', `attempts 2-3: ${tries.join(', ')}; 4th: ${fourth}`);
      put('locked');
      // 4. B says "don't match": A approves anyway, B must apply nothing.
      const { code: c2 } = await take('offer-2');
      const yes = await approve('2', c2, true);
      log(`2: A's approval after B refused: ${yes}`);
      put('a-approved-2');
      await take('checked-2');
      // 5. The happy path.
      const { code: c3 } = await take('offer-3');
      const ok = await approve('3', c3, true);
      result(ok === 'ok', '3: A approves', ok);
      const done = await take('done', 240_000);
      result(done.id === me.id, '3: B is now my account (same id)', `${done.id?.slice(0, 12)} / ${me.id.slice(0, 12)}`);
    } else if (MODE === 'expire') {
      const { code } = await take('offer-1');
      const wait = Math.max(0, (await take('expires')).at - Date.now()) + 15_000;
      log(`waiting ${Math.round(wait / 1000)} s for the code to expire`);
      await sleep(wait);
      const r = await outcome(call('beginDeviceApproval', { qrOrCode: code }));
      result(r === 'not-found', 'after 5 minutes the code is not found', r);
      put('tried');
    } else {
      const { code } = await take('offer-1');
      const ok = await approve('1', code, true);
      result(ok === 'ok', 'relay-only: A approves', ok);
      const done = await take('done', 240_000);
      result(done.id === me.id, 'relay-only: B is now my account (same id)');
      const relay = (await lookup('relay')).address;
      const peers = tcpPeers();
      result(peers.every((p) => p === relay), 'relay-only: A has TCP links to the relay only', `${peers.length} peer(s), relay ${peers.includes(relay) ? 'among them' : 'missing'}`);
      put('a-checked');
    }
  } else {
    const a = await take('ready');
    result(!(await identity()), 'B starts with no identity');

    if (MODE === 'flow') {
      // 1-3. A refuses, then locks the link.
      let since = Date.now();
      await offer('1');
      await digits('1', since);
      await take('a-refused');
      await sleep(3000);
      result(!(await identity()), '1: after A\'s "don\'t match", nothing is applied on B');
      put('checked-1');
      await take('locked');
      // 4. B says "don't match".
      // B starts over (the "cancelled" state of link 1 must not count as link 2's).
      await call('cancelDeviceLink').catch(() => {});
      await sleep(1000);
      since = Date.now();
      await offer('2');
      const st2 = await linkState(['confirm', 'expired'], since);
      put('sas-2', { sas: st2?.sas ?? null });
      result(st2?.state === 'confirm', '2: B shows the digits', JSON.stringify(st2));
      const r2 = await outcome(call('confirmDeviceLink', { match: false }));
      const failedState = await linkState(['failed'], since, 15_000);
      result(r2 === 'ok' && !!failedState, '2: B answers "don\'t match" and the link fails', `${r2}, ${JSON.stringify(failedState)}`);
      await take('a-approved-2');
      await sleep(5000);
      result(!(await identity()), '2: nothing is applied on B, even though A approved');
      put('checked-2');
      // 5. The happy path.
      since = Date.now();
      await offer('3');
      const st3 = await digits('3', since);
      const r3 = await outcome(call('confirmDeviceLink', { match: true }));
      result(st3?.state === 'confirm' && r3 === 'ok', '3: B confirms the digits', `${st3?.sas}, ${r3}`);
      const done = await linkState(['done', 'failed', 'expired'], since, 120_000);
      result(done?.state === 'done', '3: the link is done on B', JSON.stringify(done));
      const me = await identity();
      put('done', { id: me?.id ?? null });
      result(me?.id === a.id, '3: B has A\'s identity');
      result(me?.displayName === 'link-a' && me?.color === '#12ab34', '3: B has A\'s profile (name, colour)', JSON.stringify({ name: me?.displayName, color: me?.color }));
      result(me?.birthDate === BIRTH, '3: B has the birth date (no age question)', me?.birthDate);
      const servers = await (async () => {
        const end = Date.now() + 90_000;
        while (Date.now() < end) {
          const l = await call('listServers').catch(() => []);
          if (l.some((s) => s.name === 'link server')) return l;
          await sleep(1000);
        }
        return null;
      })();
      result(!!servers, '3: B gets A\'s server back (restore path)', servers ? `${servers.length} server(s)` : 'not within 90 s');
      // The link carries the small post picture (avatarSmall), which members see;
      // getIdentity's avatarDataUrl is the separate large picture, not linked.
      if (servers) {
        const s = servers.find((x) => x.name === 'link server');
        const row = (await call('listMembers', { serverId: s.id }).catch(() => [])).find((m) => m.displayName === 'link-a');
        result(row?.avatarDataUrl === PIC, '3: B\'s member row shows A\'s small picture', `${row?.avatarDataUrl?.length ?? 0} chars`);
      }
    } else if (MODE === 'expire') {
      const since = Date.now();
      const o = await offer('1');
      put('expires', { at: o.expiresAt });
      const st = await linkState(['expired'], since, 6 * 60_000);
      result(st?.state === 'expired', 'B sees the link expire after 5 minutes', st ? `${Math.round((Date.now() - since) / 1000)} s` : 'no expired state');
      await take('tried', 120_000);
      result(!(await identity()), 'nothing is applied on B');
    } else {
      const since = Date.now();
      await offer('1');
      const st = await digits('1', since);
      const r = await outcome(call('confirmDeviceLink', { match: true }));
      result(st?.state === 'confirm' && r === 'ok', 'relay-only: B confirms the digits', `${st?.sas}, ${r}`);
      const done = await linkState(['done', 'failed', 'expired'], since, 120_000);
      result(done?.state === 'done', 'relay-only: the link is done on B', JSON.stringify(done));
      const me = await identity();
      put('done', { id: me?.id ?? null });
      result(me?.id === a.id, 'relay-only: B has A\'s identity');
      const relay = (await lookup('relay')).address;
      const peers = tcpPeers();
      result(peers.every((p) => p === relay), 'relay-only: B has TCP links to the relay only', `${peers.length} peer(s)`);
      await take('a-checked');
    }
  }
} catch (e) {
  result(false, 'the check stopped', e.message);
  if (ROLE === 'b') put('done', { error: e.message });
}
log(`done, ${failed} failed`);
await sleep(1000);
child.stdin.end();
process.exit(failed ? 1 : 0);
