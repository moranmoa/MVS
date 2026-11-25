// G-48 (B24): the abuse-report address from the build-time config (#534),
// re-checked in the shell (TL on #534) and added by main to the getAppInfo
// answer the page gets (like stunUrl). The core has no part in it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abuseAddressFor, validAbuseAddress, abuseHost, withAbuseAddress, MAX_ABUSE } = require('../src/config');

function resources(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvs-res-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'mvs-config.json'), content);
  return dir;
}

test('valid abuse addresses: a plain e-mail or an https URL with a dotted host', () => {
  for (const ok of ['abuse@example.org', 'report-abuse@mail.example.co.il', 'https://example.org/report', 'https://a.example.org:8443/x?y=1']) {
    assert.equal(validAbuseAddress(ok), true, ok);
  }
});

test('anything else is refused', () => {
  for (const bad of [
    '',
    ' abuse@example.org',
    'a b@example.org',
    'abuse@localhost',
    'abuse@example.org<script>',
    'x"@example.org',
    "x'@example.org",
    'x\\@example.org',
    'x`@example.org',
    'אבוז@example.org',
    'http://example.org',
    'https://example',
    'https://user:pw@example.org',
    'javascript:alert(1)',
    'mailto:abuse@example.org',
    'a'.repeat(MAX_ABUSE - 11) + '@example.org',
    42,
    ['abuse@example.org'],
  ]) {
    assert.equal(validAbuseAddress(bad), false, String(bad));
  }
});

test('packaged: from mvs-config.json; MVS_ABUSE_ADDRESS is ignored; a bad one warns without naming it', () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  const env = { MVS_ABUSE_ADDRESS: 'env@example.org' };
  assert.equal(abuseAddressFor({ packaged: true, resourcesPath: resources(JSON.stringify({ abuseAddress: 'abuse@example.org' })), env, warn }), 'abuse@example.org');
  assert.equal(abuseAddressFor({ packaged: true, resourcesPath: resources(), env, warn }), null, 'no file');
  assert.equal(abuseAddressFor({ packaged: true, resourcesPath: resources('{}'), env, warn }), null, 'no key');
  assert.equal(abuseAddressFor({ packaged: true, resourcesPath: resources('{nope'), env, warn }), null, 'broken JSON');
  assert.deepEqual(warns, []);
  assert.equal(abuseAddressFor({ packaged: true, resourcesPath: resources(JSON.stringify({ abuseAddress: 'http://bad.example.org' })), env, warn }), null);
  assert.equal(warns.length, 1);
  assert.ok(warns.every((w) => !w.includes('example')), warns.join());
});

test('checkout: from MVS_ABUSE_ADDRESS only', () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  assert.equal(abuseAddressFor({ packaged: false, env: { MVS_ABUSE_ADDRESS: 'https://example.org/abuse' }, warn }), 'https://example.org/abuse');
  assert.equal(abuseAddressFor({ packaged: false, env: {}, warn }), null);
  assert.equal(abuseAddressFor({ packaged: false, env: { MVS_ABUSE_ADDRESS: 'nope' }, warn }), null);
  assert.equal(warns.length, 1);
});

test('its domain is found for the file log to hide', () => {
  assert.equal(abuseHost('abuse@example.org'), 'example.org');
  assert.equal(abuseHost('https://a.example.org:8443/x'), 'a.example.org');
  assert.equal(abuseHost(null), null);
});

test('getAppInfo: the address is added to an ok answer only', () => {
  const ok = { ok: { version: '0.5.0', updateChannel: 'stable' } };
  assert.deepEqual(withAbuseAddress(ok, 'abuse@example.org'), { ok: { version: '0.5.0', updateChannel: 'stable', abuseAddress: 'abuse@example.org' } });
  assert.equal(withAbuseAddress(ok, null), ok, 'no address: unchanged');
  const err = { error: { code: 'core-unavailable' } };
  assert.equal(withAbuseAddress(err, 'abuse@example.org'), err, 'errors pass through');
  assert.equal(withAbuseAddress({ ok: null }, 'abuse@example.org').ok, null);
  assert.equal(withAbuseAddress(undefined, 'abuse@example.org'), undefined);
});
