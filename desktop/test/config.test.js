// The relay setting (src/config.js) and how it reaches mvs-core's arguments.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { relayFor, relaysFor, bootstrapFor, validRelay, logHost, MAX_RELAY, MAX_RELAYS, MAX_BOOTSTRAP, stunFor, validStun, stunHost, MAX_STUN } = require('../src/config');
const { createLog } = require('../src/logfile');
const { Sidecar } = require('../src/sidecar');

const ID = '12D3KooW' + 'A'.repeat(44);
const RELAY = `/dns4/relay.example.org/tcp/443/wss/p2p/${ID}`;

function resources(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvs-res-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'mvs-config.json'), content);
  return dir;
}

test('valid relay addresses', () => {
  assert.equal(validRelay(RELAY), true);
  assert.equal(validRelay(`/ip4/192.0.2.1/udp/4001/quic-v1/p2p/${ID}`), true);
});

test('invalid relay values are refused', () => {
  for (const bad of [
    // #114: the peer ID must be pinned
    '/dns4/relay.example.org/tcp/443/wss',
    `/dns4/relay.example.org/tcp/443/wss/p2p/${ID.slice(0, 40)}`,
    `/dns4/relay.example.org/tcp/443/wss/p2p/${ID}0OIl`,
    `/dns4/relay.example.org/tcp/443/wss/p2p/${ID}/extra`,
    '', '/', 'relay.example.org:4001', ` ${RELAY}`, `${RELAY} --inspect`, `${RELAY}\n`, '/' + 'a'.repeat(MAX_RELAY), 42, null, {}, ['/x']]) {
    assert.equal(validRelay(bad), false, String(bad).slice(0, 40));
  }
});

test('packaged: the relay comes from resources/mvs-config.json', () => {
  assert.equal(relayFor({ packaged: true, resourcesPath: resources(JSON.stringify({ relay: RELAY })) }), RELAY);
});

test('packaged: no file, {} or an empty relay means no relay, silently', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(relayFor({ packaged: true, resourcesPath: resources(), warn }), null);
  assert.equal(relayFor({ packaged: true, resourcesPath: resources('{}'), warn }), null);
  assert.equal(relayFor({ packaged: true, resourcesPath: resources('{"relay":""}'), warn }), null);
  assert.deepEqual(warnings, []);
});

test('packaged: broken JSON or a bad relay is ignored with a warning', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(relayFor({ packaged: true, resourcesPath: resources('{relay'), warn }), null);
  assert.equal(relayFor({ packaged: true, resourcesPath: resources('{"relay":"tcp://evil --x"}'), warn }), null);
  assert.equal(relayFor({ packaged: true, resourcesPath: resources('{"relay":["/x"]}'), warn }), null);
  assert.equal(warnings.length, 3);
});

test('packaged: MVS_RELAY in the environment is ignored', () => {
  assert.equal(relayFor({ packaged: true, resourcesPath: resources(), env: { MVS_RELAY: RELAY } }), null);
});

test('checkout: the relay comes from MVS_RELAY only', () => {
  const dir = resources(JSON.stringify({ relay: '/ignored' }));
  assert.equal(relayFor({ packaged: false, resourcesPath: dir, env: { MVS_RELAY: RELAY } }), RELAY);
  assert.equal(relayFor({ packaged: false, resourcesPath: dir, env: {} }), null);
  assert.equal(relayFor({ packaged: false, env: { MVS_RELAY: 'nope' }, warn() {} }), null);
});

function spawnedArgs(options) {
  let args;
  const spawnImpl = (_exe, a) => {
    args = a;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => {};
    return child;
  };
  new Sidecar({ exe: path.resolve('/opt/mvs-core'), dataDir: path.resolve('/data'), onEvent() {}, spawnImpl, ...options }).start();
  return args;
}

test('mvs-core gets --relay only when there is one', () => {
  const data = path.resolve('/data');
  assert.deepEqual(spawnedArgs({}), ['--data-dir', data]);
  assert.deepEqual(spawnedArgs({ relay: null }), ['--data-dir', data]);
  assert.deepEqual(spawnedArgs({ relay: RELAY }), ['--data-dir', data, '--relay', RELAY]);
});

test('extra switches are appended and must be strings', () => {
  const data = path.resolve('/data');
  assert.deepEqual(spawnedArgs({ relay: RELAY, extraArgs: ['--update-root', '/u'] }), ['--data-dir', data, '--relay', RELAY, '--update-root', '/u']);
  assert.throws(() => spawnedArgs({ extraArgs: [42] }), /strings/);
  assert.throws(() => spawnedArgs({ extraArgs: '--x' }), /strings/);
});

const TCP = `/dns4/relay-direct.example.org/tcp/4001/p2p/${ID}`;

test('packaged: bootstrap comes from resources/mvs-config.json, checked like the relay', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources(JSON.stringify({ relay: RELAY, bootstrap: [TCP] })) }), [TCP]);
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources(JSON.stringify({ relay: RELAY })), warn }), []);
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources(), warn }), []);
  assert.deepEqual(warnings, [], 'absent bootstrap is not a warning');
  const mixed = { bootstrap: [TCP, '/dns4/x/tcp/4001', `${TCP} --inspect`, 42] };
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources(JSON.stringify(mixed)), warn }), [TCP]);
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources('{"bootstrap":"/x"}'), warn }), []);
  const many = { bootstrap: Array(MAX_BOOTSTRAP + 2).fill(TCP) };
  assert.equal(bootstrapFor({ packaged: true, resourcesPath: resources(JSON.stringify(many)), warn }).length, MAX_BOOTSTRAP);
  assert.equal(warnings.length, 3);
});

test('checkout: bootstrap comes from MVS_BOOTSTRAP only', () => {
  const dir = resources(JSON.stringify({ bootstrap: [TCP] }));
  assert.deepEqual(bootstrapFor({ packaged: false, resourcesPath: dir, env: {} }), []);
  assert.deepEqual(bootstrapFor({ packaged: false, env: { MVS_BOOTSTRAP: `${TCP},${TCP}` } }), [TCP, TCP]);
});

test('mvs-core gets --bootstrap after --relay, and only with a relay', () => {
  const data = path.resolve('/data');
  assert.deepEqual(spawnedArgs({ relay: RELAY, bootstrap: [TCP] }), ['--data-dir', data, '--relay', RELAY, '--bootstrap', TCP]);
  assert.deepEqual(spawnedArgs({ relay: null, bootstrap: [TCP] }), ['--data-dir', data]);
  assert.throws(() => spawnedArgs({ bootstrap: [42] }), /strings/);
  assert.throws(() => spawnedArgs({ bootstrap: TCP }), /strings/);
});

// STUN for voice (#222): a plain stun:/stuns: URL, the same rule as the UI's iceServersFor.
test('valid STUN URLs', () => {
  for (const ok of ['stun:stun.example.org:3478', 'stuns:stun.example.org:5349', 'STUN:stun.example.org', 'stun:198.51.100.7:3478', 'stun:[2001:db8::7]:3478', '  stun:stun.example.org:3478  ']) {
    assert.equal(validStun(ok), true, ok);
  }
});

test('anything but a plain STUN URL is refused', () => {
  for (const bad of ['turn:turn.example.org:3478', 'turns:turn.example.org', 'stun:user:pass@stun.example.org', 'stun:stun.example.org/path', 'stun:stun.example.org?transport=udp', 'stun:stun.example.org#x', 'stun:stun example.org', 'stun:', 'https://stun.example.org', '//stun.example.org', 'stun.example.org:3478', 'stun:' + 'a'.repeat(MAX_STUN), '', 7, null, ['stun:stun.example.org'], {}]) {
    assert.equal(validStun(bad), false, String(bad));
  }
});

test('packaged: STUN comes from mvs-config.json; MVS_STUN is ignored', () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  const env = { MVS_STUN: 'stun:env.example.org:3478' };
  assert.equal(stunFor({ packaged: true, resourcesPath: resources(JSON.stringify({ relay: RELAY, stun: ' stun:stun.example.org:3478 ' })), env, warn }), 'stun:stun.example.org:3478');
  assert.equal(stunFor({ packaged: true, resourcesPath: resources(), env, warn }), null, 'no file');
  assert.equal(stunFor({ packaged: true, resourcesPath: resources(JSON.stringify({ relay: RELAY })), env, warn }), null, 'no stun key');
  assert.equal(stunFor({ packaged: true, resourcesPath: resources('{nope'), env, warn }), null, 'broken JSON');
  assert.deepEqual(warns, []);
  assert.equal(stunFor({ packaged: true, resourcesPath: resources(JSON.stringify({ stun: 'turn:t.example.org:3478' })), env, warn }), null);
  assert.equal(stunFor({ packaged: true, resourcesPath: resources(JSON.stringify({ stun: ['stun:a.example.org'] })), env, warn }), null);
  assert.equal(warns.length, 2);
  // The warning never names the value.
  assert.ok(warns.every((w) => !w.includes('example')), warns.join());
});

test('checkout: STUN comes from MVS_STUN only', () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  assert.equal(stunFor({ packaged: false, env: { MVS_STUN: 'stun:stun.example.org:3478' }, warn }), 'stun:stun.example.org:3478');
  assert.equal(stunFor({ packaged: false, env: {}, warn }), null);
  assert.equal(stunFor({ packaged: false, env: { MVS_STUN: '' }, warn }), null);
  assert.equal(stunFor({ packaged: false, env: { MVS_STUN: 'stun:u:p@stun.example.org' }, warn }), null);
  assert.equal(warns.length, 1);
});

test('the STUN host is found for the file log to hide', () => {
  assert.equal(stunHost('stun:stun.example.org:3478'), 'stun.example.org');
  assert.equal(stunHost('stuns:stun.example.org'), 'stun.example.org');
  assert.equal(stunHost('stun:198.51.100.7:3478'), '198.51.100.7');
  assert.equal(stunHost('stun:[2001:db8::7]:3478'), '2001:db8::7');
  assert.equal(stunHost(null), null);
});

test('relay and bootstrap hosts, DNS or IP, never reach the file log', () => {
  const peer = '12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc';
  assert.equal(logHost(`/dns4/relay.example.org/tcp/443/wss/p2p/${peer}`), 'relay.example.org');
  assert.equal(logHost(`/ip4/198.51.100.7/tcp/4001/p2p/${peer}`), '198.51.100.7');
  assert.equal(logHost(`/ip6/2001:db8::7/udp/4001/quic-v1/p2p/${peer}`), '2001:db8::7');
  assert.equal(logHost(`/p2p/${peer}`), null);
  assert.equal(logHost(null), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvs-loghost-'));
  try {
    const log = createLog(dir);
    for (const addr of [`/ip4/198.51.100.7/tcp/4001/p2p/${peer}`, `/ip6/2001:db8::7/udp/4001/quic-v1/p2p/${peer}`]) {
      log.hide(logHost(addr));
    }
    // Glued to other text, past the generic IP redaction's word boundaries.
    log('core: dial failed to v198.51.100.7x and [2001:db8::7]:4001');
    const text = fs.readFileSync(path.join(dir, 'mvs.log'), 'utf8');
    assert.ok(!text.includes('198.51.100.7') && !text.includes('2001:db8::7'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap takes the relay\'s QUIC address beside its TCP one (#243)', () => {
  const quic = `/dns4/relay-direct.example.org/udp/4001/quic-v1/p2p/${ID}`;
  const quic4 = `/ip4/198.51.100.7/udp/4001/quic-v1/p2p/${ID}`;
  const warnings = [];
  const config = JSON.stringify({ relay: RELAY, bootstrap: [TCP, quic, quic4] });
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources(config), warn: (m) => warnings.push(m) }), [TCP, quic, quic4]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(bootstrapFor({ packaged: false, env: { MVS_BOOTSTRAP: `${TCP},${quic}` } }), [TCP, quic]);
  // Still pinned: a QUIC address without the relay's /p2p ID is dropped.
  assert.deepEqual(bootstrapFor({ packaged: true, resourcesPath: resources(JSON.stringify({ bootstrap: ['/dns4/x/udp/4001/quic-v1'] })), warn() {} }), []);
  // Its host stays out of the file log like the TCP one's.
  assert.equal(logHost(quic), 'relay-direct.example.org');
  assert.equal(logHost(quic4), '198.51.100.7');
});

// ---- multi-relay part A ------------------------------------------------------

const ID2 = '12D3KooW' + 'B'.repeat(44);
const ID3 = '12D3KooW' + 'C'.repeat(44);
const RELAY2 = `/dns4/relay2.example.org/tcp/443/wss/p2p/${ID2}`;
const RELAY3 = `/dns4/relay3.example.org/tcp/443/wss/p2p/${ID3}`;

test('packaged: the relay list comes from mvs-config.json "relays", in order', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const cfg = (o) => ({ packaged: true, resourcesPath: resources(JSON.stringify(o)), warn });
  assert.deepEqual(relaysFor(cfg({ relays: [RELAY, RELAY2], relay: RELAY3 })), [RELAY, RELAY2]);
  assert.deepEqual(warnings, []);
});

test('the relay list drops bad entries and repeats of a relay, keeps at most 4, never naming them', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const cfg = (o) => ({ packaged: true, resourcesPath: resources(JSON.stringify(o)), warn });
  // A bad entry and a second address for the same relay (peer ID).
  const sameId = `/dns4/relay-direct.example.org/tcp/4001/p2p/${ID}`;
  assert.deepEqual(relaysFor(cfg({ relays: [RELAY, '/dns4/x/tcp/443', sameId, `${RELAY2} --inspect`, RELAY2] })), [RELAY, RELAY2]);
  // More than four.
  const five = Array.from({ length: MAX_RELAYS + 1 }, (_, i) => `/dns4/r${i}.example.org/tcp/443/wss/p2p/12D3KooW${String.fromCharCode(68 + i).repeat(44)}`);
  assert.equal(relaysFor(cfg({ relays: five })).length, MAX_RELAYS);
  assert.ok(warnings.length >= 3);
  assert.ok(warnings.every((w) => !/example\.org|12D3KooW/.test(w)), 'warnings never name an address');
});

test('the single relay is the fallback: no list, an empty one, a malformed one, or nothing usable', () => {
  const warn = () => {};
  const cfg = (o) => ({ packaged: true, resourcesPath: resources(typeof o === 'string' ? o : JSON.stringify(o)), warn });
  assert.deepEqual(relaysFor(cfg({ relay: RELAY })), [RELAY]);
  assert.deepEqual(relaysFor(cfg({ relays: [], relay: RELAY })), [RELAY]);
  assert.deepEqual(relaysFor(cfg({ relays: RELAY2, relay: RELAY })), [RELAY], 'a string is not a list');
  assert.deepEqual(relaysFor(cfg({ relays: ['/bad'], relay: RELAY })), [RELAY]);
  assert.deepEqual(relaysFor(cfg({})), []);
  assert.deepEqual(relaysFor(cfg('{relays')), []);
  assert.deepEqual(relaysFor({ packaged: true, resourcesPath: resources(), warn }), []);
});

test('checkout: MVS_RELAYS (lines or commas), else MVS_RELAY; never the packaged file', () => {
  const warn = () => {};
  const dir = resources(JSON.stringify({ relays: [RELAY3] }));
  assert.deepEqual(relaysFor({ packaged: false, resourcesPath: dir, env: { MVS_RELAYS: `${RELAY}\n${RELAY2}\n` }, warn }), [RELAY, RELAY2]);
  assert.deepEqual(relaysFor({ packaged: false, resourcesPath: dir, env: { MVS_RELAYS: `${RELAY}, ${RELAY2}` }, warn }), [RELAY, RELAY2]);
  assert.deepEqual(relaysFor({ packaged: false, resourcesPath: dir, env: { MVS_RELAYS: ' ', MVS_RELAY: RELAY }, warn }), [RELAY]);
  assert.deepEqual(relaysFor({ packaged: false, resourcesPath: dir, env: {}, warn }), []);
});

test('mvs-core gets one --relay per relay, in order, then --bootstrap', () => {
  const data = path.resolve('/data');
  assert.deepEqual(spawnedArgs({ relays: [RELAY, RELAY2], bootstrap: [TCP] }), ['--data-dir', data, '--relay', RELAY, '--relay', RELAY2, '--bootstrap', TCP]);
  // One relay: exactly the arguments of a single-relay build.
  assert.deepEqual(spawnedArgs({ relays: [RELAY], bootstrap: [TCP] }), spawnedArgs({ relay: RELAY, bootstrap: [TCP] }));
  assert.deepEqual(spawnedArgs({ relays: [], bootstrap: [TCP] }), ['--data-dir', data]);
  assert.throws(() => spawnedArgs({ relays: RELAY }), /strings/);
  assert.throws(() => spawnedArgs({ relays: [42] }), /strings/);
});

test('checkout: relay and bootstrap lists take commas and/or newlines, spaces and empty entries ignored', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.deepEqual(relaysFor({ packaged: false, env: { MVS_RELAYS: ` ${RELAY} ,, ${RELAY2},` }, warn }), [RELAY, RELAY2]);
  assert.deepEqual(relaysFor({ packaged: false, env: { MVS_RELAYS: `${RELAY},\r\n${RELAY2}\r\n` }, warn }), [RELAY, RELAY2]);
  // The same relay twice, once per separator: dropped, not named.
  assert.deepEqual(relaysFor({ packaged: false, env: { MVS_RELAYS: `${RELAY},${RELAY}\n${RELAY2}` }, warn }), [RELAY, RELAY2]);
  assert.deepEqual(bootstrapFor({ packaged: false, env: { MVS_BOOTSTRAP: ` ${TCP} ,\n,` }, warn }), [TCP]);
  assert.ok(warnings.every((w) => !/example\.org|12D3KooW/.test(w)), 'warnings never name an address');
});
