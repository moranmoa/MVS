// The metered check (run.sh): NetworkManager's Metered flag → the shell's
// checkMetered() → setMetered → the core's member relaying.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const { checkMetered } = require('/desktop-src/metered.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const result = (ok, text, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}${detail ? ` (${detail})` : ''}`);
};

const nm = (...args) => execFileSync('nmcli', args, { encoding: 'utf8' });
/** NetworkManager's global Metered (NMMetered: 1 yes, 2 no, 3 guess-yes, 4 guess-no). */
const nmMetered = () =>
  Number(
    /uint32 (\d+)/.exec(
      execFileSync('gdbus', ['call', '--system', '--dest', 'org.freedesktop.NetworkManager', '--object-path', '/org/freedesktop/NetworkManager', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.NetworkManager', 'Metered'], { encoding: 'utf8' }),
    )?.[1],
  );
async function setConnection(value, want) {
  nm('connection', 'modify', 'qa', 'connection.metered', value);
  nm('connection', 'up', 'qa');
  const end = Date.now() + 15_000;
  while (Date.now() < end && !want.includes(nmMetered())) await sleep(200);
  return nmMetered();
}

// The core.
const child = spawn('/core/mvs-core', ['--data-dir', mkdtempSync(join(tmpdir(), 'mvs-metered-'))], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  if (m.type === 'event') return void events.push(m);
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  m.error ? w.reject(new Error(`${w.cmd}: ${JSON.stringify(m.error)}`)) : w.resolve(m.ok);
});
const call = (cmd, args = {}) =>
  new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject, cmd });
    child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
  });
/** What main.js does: ask, then tell the core. */
async function shellStep() {
  const metered = await checkMetered();
  await call('setMetered', { metered });
  return { metered, relay: await call('getMemberRelay') };
}
const relayText = (r) => `effective ${r.effective}${r.reason ? `, reason ${r.reason}` : ''}`;

try {
  await call('createIdentity', { input: { locale: 'en', country: 'IL', birthDate: '1990-01-01' } });
  const words = await call('getRecoveryWords');
  const ch = await call('getRecoveryChallenge').catch(() => null);
  const pos = ch?.positions ?? [1, 5, 9];
  await call('checkRecoveryWords', { answers: Object.fromEntries(pos.map((p) => [p, words[p - 1]])) });
  await call('createServer', { input: { name: 'metered', ageRestriction: 'none' } });
  await call('setMemberRelay', { setting: 'on' });
  await call('markMemberRelayDisclosureSeen');

  const base = await shellStep();
  result(!base.metered && base.relay.effective, 'default connection: not metered, relaying on', `NMMetered ${nmMetered()}, ${relayText(base.relay)}`);

  const yes = await setConnection('yes', [1]);
  const before = events.length;
  const m = await shellStep();
  result(yes === 1 && m.metered === true, 'connection.metered yes: NetworkManager and checkMetered() say metered', `NMMetered ${yes}`);
  result(m.relay.effective === false && m.relay.reason === 'metered', 'metered: the core stops relaying (reason metered)', relayText(m.relay));
  result(events.slice(before).some((e) => e.event === 'memberRelay.changed'), 'metered: memberRelay.changed is sent');

  const no = await setConnection('no', [2]);
  const u = await shellStep();
  result(no === 2 && u.metered === false, 'connection.metered no: not metered again', `NMMetered ${no}`);
  result(u.relay.effective === true && !u.relay.reason, 'unmetered: relaying is back on', relayText(u.relay));

  const unknown = await setConnection('unknown', [3, 4]);
  const g = await shellStep();
  result(g.metered === (unknown === 3), 'connection.metered unknown: checkMetered() follows the guess', `NMMetered ${unknown} → ${g.metered}`);
} catch (e) {
  result(false, 'the check stopped', e.message);
}
child.stdin.end();
process.exit(failed ? 1 : 0);
