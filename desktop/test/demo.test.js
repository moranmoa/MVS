'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DEMO_ARG, demoFor, demoProfile } = require('../src/demo');

test('demoFor: a checkout with MVS_DEMO only; never packaged', () => {
  assert.equal(demoFor({ packaged: false, env: { MVS_DEMO: '1' } }), '1');
  assert.equal(demoFor({ packaged: false, env: { MVS_DEMO: 'unchecked' } }), 'unchecked');
  // The !app.isPackaged guard: a release build ignores MVS_DEMO.
  assert.equal(demoFor({ packaged: true, env: { MVS_DEMO: '1' } }), null);
  assert.equal(demoFor({ packaged: undefined, env: { MVS_DEMO: '1' } }), null);
  assert.equal(demoFor({ packaged: 'false', env: { MVS_DEMO: '1' } }), null);
  assert.equal(demoFor({ packaged: false, env: {} }), null);
  for (const bad of ['', ' 1', '1&fresh=1', 'a/b', 'x'.repeat(33), '1\n']) {
    assert.equal(demoFor({ packaged: false, env: { MVS_DEMO: bad } }), null, JSON.stringify(bad));
  }
});

test('demoProfile: a sibling of the real profile, never inside it', () => {
  assert.equal(demoProfile('/home/u/.config/MVS'), '/home/u/.config/MVS-demo');
  assert.equal(demoProfile('C:\\Users\\u\\AppData\\Roaming\\MVS\\'), 'C:\\Users\\u\\AppData\\Roaming\\MVS-demo');
});

test('the preload looks for the same argument main adds', () => {
  // The sandboxed preload can't require demo.js, so it spells it out.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.ok(preload.includes(`process.argv.includes('${DEMO_ARG}')`));
});
