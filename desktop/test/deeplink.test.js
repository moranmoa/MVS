// mvs:// parsing (src/deeplink.js): the exact invite format, nothing else.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FOCUS_EVERY_MS, parseInviteLink, parseMessageLink, parseLink, linkFromArgv, hasLinkArg, inviteFromArgv, createFocusThrottle } = require('../src/deeplink');

const S = 'a'.repeat(64);
const I = '0123456789abcdef'.repeat(4);
const K = 'f'.repeat(64); // the server secret (GAP-4)
const GOOD = `mvs://join/${S}/${I}/${K}`;

test('a well-formed invite link passes, canonicalised', () => {
  assert.equal(parseInviteLink(GOOD), GOOD);
  assert.equal(parseInviteLink(`${GOOD}/`), GOOD, 'trailing slash some OSes add');
  assert.equal(parseInviteLink(GOOD.toUpperCase()), GOOD);
  assert.equal(parseInviteLink(`  ${GOOD}\n`), GOOD);
});

test('anything else is refused', () => {
  for (const bad of [
    `mvs://join/${S}`,
    // the old two-part form, without the secret, is no invite any more
    `mvs://join/${S}/${I}`,
    `mvs://join/${S}/${I}/${K.slice(1)}`,
    'mvs://join/' + 'a'.repeat(64) + '/' + 'b'.repeat(64) + '/' + 'c'.repeat(64) + 'x'.repeat(60),
    `mvs://join/${S}/${I}/${K}/extra`,
    `mvs://join/${S.slice(1)}/${I}/${K}`,
    `mvs://join/${S}/${I}/${K}0`,
    `mvs://join/${'g'.repeat(64)}/${I}/${K}`,
    `mvs://other/${S}/${I}/${K}`,
    `mvs://join/${S}/${I}/${K}?x=1`,
    `mvs://join/${S}/${I}/${K}#x`,
    `mvs://user@join/${S}/${I}/${K}`,
    `mvs:join/${S}/${I}/${K}`,
    `https://join/${S}/${I}/${K}`,
    `mvs://join/../../${S}/${I}/${K}`,
    `mvs://join/${S}/%2e%2e`,
    `mvs://join/${S}/${I}/${K}\u0000`,
    `mvs://join/${S}/${I}/${K} --inspect`,
    'x'.repeat(10_000),
    '',
    null,
    42,
  ]) {
    assert.equal(parseInviteLink(bad), null, String(bad).slice(0, 80));
  }
});

test('the link is found in a command line, and only an mvs:// argument counts', () => {
  assert.equal(inviteFromArgv(['C:\\Program Files\\MVS\\mvs.exe', '--allow-file-access', GOOD]), GOOD);
  assert.equal(inviteFromArgv(['mvs', `--x=${GOOD}`]), null);
  assert.equal(inviteFromArgv(['mvs', 'mvs://join/bad']), null);
  assert.equal(inviteFromArgv(['mvs']), null);
  assert.equal(inviteFromArgv('mvs://join'), null);
});

// ---- G-30: message links (docs/design/g30-message-links.md §3) ----------------

const C = 'c'.repeat(64);
const M = '9'.repeat(64);
const MSG = `mvs://m/${S}/${C}/${M}`;
const IDS = { serverId: S, channelId: C, messageId: M };

test('G-30: a message link of the exact form gives the three IDs', () => {
  assert.equal(MSG.length, 202);
  assert.deepEqual(parseMessageLink(MSG), IDS);
  assert.deepEqual(parseMessageLink(`${MSG}/`), IDS, 'trailing slash');
  assert.deepEqual(parseMessageLink(MSG.toUpperCase()), IDS, 'upper case');
  assert.deepEqual(parseMessageLink(`  ${MSG}\n`), IDS);
  assert.deepEqual(parseLink(MSG), { kind: 'message', ...IDS });
  assert.deepEqual(parseLink(GOOD), { kind: 'invite', link: GOOD });
});

test('G-30: anything else is not a message link', () => {
  for (const bad of [
    `mvs://m/${S}/${C}`,
    `mvs://m/${S}/${C}/${M}/extra`,
    `mvs://m/${S}/${C}/${M}0`,
    `mvs://m/${S.slice(1)}/${C}/${M}`,
    `mvs://m/${'g'.repeat(64)}/${C}/${M}`,
    `mvs://m/${S}/${C}/${M}?highlight=1`,
    `mvs://m/${S}/${C}/${M}#x`,
    `mvs://msg/${S}/${C}/${M}`,
    `mvs://m//${C}/${M}`,
    `mvs://user@m/${S}/${C}/${M}`,
    `mvs:m/${S}/${C}/${M}`,
    `https://m/${S}/${C}/${M}`,
    `mvs://m/${S}/${C}/${M} --inspect`,
    `mvs://m/${S}/${C}/${M}\u0000`,
    `mvs://m/${S}/${C}/${M}${'/'.repeat(60)}`,
    'mvs://m/' + 'a'.repeat(300),
    '',
    null,
    {},
  ]) {
    assert.equal(parseMessageLink(bad), null, String(bad).slice(0, 80));
    assert.equal(parseLink(bad), null, String(bad).slice(0, 80));
  }
});

test('G-30: in argv the first mvs:// argument decides, either kind', () => {
  const exe = 'C:\\Program Files\\MVS\\mvs.exe';
  assert.deepEqual(linkFromArgv([exe, '--', MSG]), { kind: 'message', ...IDS });
  assert.deepEqual(linkFromArgv([exe, '--', GOOD]), { kind: 'invite', link: GOOD });
  // The first mvs:// argument decides, even if it's bad and a good one follows.
  assert.equal(linkFromArgv([exe, 'mvs://nonsense', MSG]), null);
  assert.deepEqual(linkFromArgv([exe, MSG, GOOD]), { kind: 'message', ...IDS });
  assert.equal(linkFromArgv([exe, `--x=${MSG}`]), null);
  assert.equal(linkFromArgv(MSG), null);
  // A malformed mvs:// argument is no link, but still counts as a link launch (throttled focus, SL).
  assert.equal(hasLinkArg([exe, 'MVS://nonsense']), true);
  assert.equal(hasLinkArg([exe, MSG]), true);
  assert.equal(hasLinkArg([exe, '--x=mvs://m/1']), false);
  assert.equal(hasLinkArg([exe]), false);
  assert.equal(hasLinkArg('mvs://x'), false);
  // The old helper only ever gives an invite.
  assert.equal(inviteFromArgv([exe, MSG]), null);
});

test('G-30 (SL): the window comes forward at most once every 2 s', () => {
  let t = 0;
  const f = createFocusThrottle({ now: () => t });
  assert.equal(FOCUS_EVERY_MS, 2000);
  assert.equal(f.allow(), true);
  t = 500;
  assert.equal(f.allow(), false);
  t = 1999;
  assert.equal(f.allow(), false);
  t = 2000;
  assert.equal(f.allow(), true);
  t = 2001;
  assert.equal(f.allow(), false);
});
