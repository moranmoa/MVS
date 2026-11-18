// 0.5.0 features between two cores (run.sh with SCRIPT=release050.mjs).
// MODE=new: emoji reactions (G-26) between the owner A and a member B: the
// reactions-v1 gate, react/unreact both ways, the FE0F fold, the emoji check,
// the 10-per-member cap, not-found, and that a reaction is never unread; then
// "is typing…" (G-29) on and off and with the indicator off; removed accounts
// (G-53): kick, list, undo, rejoin; and the app lock core (G-78) on the owner:
// limits, the attempt counter and its delay, and the 12 words.
// MODE=backup: restore progress (G-91): B restores A's words on a fresh device
// and getServerRestore goes from searching/waiting to done.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ROLE = process.env.ROLE;
const OTHER = ROLE === 'a' ? 'b' : 'a';
const MODE = process.env.MODE ?? 'new';
const RV = '/rendezvous';
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
async function take(name, timeout = 180_000) {
  const end = Date.now() + timeout;
  const f = join(RV, `${OTHER}.${name}.json`);
  while (Date.now() < end) {
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {}
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${OTHER}'s ${name}`);
}
async function until(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  return null;
}
const secs = (from) => `${((Date.now() - from) / 1000).toFixed(1)} s`;

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
  if (m.id === undefined) {
    if (m.event) events.push({ ...m, at: Date.now() });
    return;
  }
  if (!waiting.has(m.id)) return;
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
/** The error code of a call that must fail, or 'ok' if it did not. */
const code = (p) =>
  p.then(
    () => 'ok',
    (e) => (e.message.match(/"code":"([^"]+)"/) ?? [, e.message])[1],
  );

async function newIdentity(name) {
  await call('createIdentity', { input: { locale: 'en', country: 'IL', birthDate: '1990-01-01' } });
  const words = await call('getRecoveryWords');
  const ch = await call('getRecoveryChallenge').catch(() => null);
  const pos = ch?.positions ?? [1, 5, 9];
  await call('checkRecoveryWords', { answers: Object.fromEntries(pos.map((p) => [p, words[p - 1]])) });
  await call('updateProfile', { input: { displayName: name } });
  return words;
}
async function messages(channelId) {
  const n = await call('getMessageCount', { channelId });
  return n ? (await call('getMessages', { channelId, start: 0, end: n })).messages : [];
}
const chips = (m) => JSON.stringify(m?.reactions ?? []);
const chip = (m, emoji) => m?.reactions?.find((r) => r.emoji === emoji);
const THUMB = '\u{1F44D}';
const TEN = ['\u{1F600}', '\u{1F601}', '\u{1F602}', '\u{1F603}', '\u{1F604}', '\u{1F605}', '\u{1F606}', '\u{1F607}', '\u{1F608}', '\u{1F609}'];

try {
  log(`core ${(await call('getAppInfo')).version}, mode ${MODE}`);
  if (MODE === 'backup') {
    if (ROLE === 'a') {
      const words = await newIdentity('r050-a');
      await call('createServer', { input: { name: 'restore 1', ageRestriction: 'none' } });
      await call('createServer', { input: { name: 'restore 2', ageRestriction: 'none' } });
      const mine = await call('getServerRestore').catch((e) => ({ error: e.message }));
      result(mine.state === 'none', 'getServerRestore is "none" with no restore since this start', JSON.stringify(mine));
      await sleep(5000); // let the backup be put
      put('ready', { words });
      const done = await take('done', 300_000).catch((e) => ({ error: e.message }));
      log('restored device reports:', JSON.stringify(done));
    } else {
      const { words } = await take('ready', 300_000);
      await call('restoreIdentity', { words });
      const start = Date.now();
      const seen = [];
      const done = await until(async () => {
        const r = await call('getServerRestore');
        const s = `${r.state} ${r.found}/${r.waiting}`;
        if (seen.at(-1) !== s) seen.push(s);
        return r.state === 'done' ? r : null;
      }, 240_000);
      result(!!done && done.found === 2 && done.waiting === 0, 'restore progress reaches done: found 2, waiting 0', `${seen.join(' -> ')} in ${secs(start)}`);
      result(seen.every((s) => /^(none|searching|waiting|done) \d+\/\d+$/.test(s)), 'every state is one of none/searching/waiting/done', seen.join(', '));
      const ev = events.filter((e) => e.event === 'serverRestore.changed');
      result(ev.length > 0 && ev.at(-1).payload?.state === 'done', 'serverRestore.changed events end with done', `${ev.length} events: ${ev.map((e) => e.payload?.state).join(',')}`);
      const list = await call('listServers');
      result(list.length === 2, 'both servers are back', list.map((s) => s.name).join(', '));
      put('done', { failed });
    }
  } else if (ROLE === 'a') {
    const words = await newIdentity('r050-a');
    const s = await call('createServer', { input: { name: 'r050', ageRestriction: 'none' } });
    const channel = (await call('listChannels', { serverId: s.id }))[0].id;
    put('ready', { link: s.inviteLink });
    await take('joined', 240_000);
    // After the join: a joiner cannot open what came before it (GAP-8).
    await call('sendMessage', { channelId: channel, body: 'react to me' });
    await call('sendMessage', { channelId: channel, body: 'cap test' });
    put('sent');
    await take('has-msgs', 180_000);
    const t = Date.now();
    const open = await until(async () => ((await call('getUpdateNeeded', { serverId: s.id, cap: 'reactions-v1' })).length === 0 ? true : null), 90_000);
    result(!!open, 'the reactions-v1 gate opens once the member is in', open ? secs(t) : JSON.stringify(await call('getUpdateNeeded', { serverId: s.id, cap: 'reactions-v1' }).catch((e) => e.message)));
    const all = await messages(channel);
    const target = all.find((x) => x.body === 'react to me');
    const capMsg = all.find((x) => x.body === 'cap test');

    result((await code(call('react', { messageId: target.id, emoji: THUMB, on: true }))) === 'ok', 'react 👍 on the message');
    await call('react', { messageId: target.id, emoji: `${THUMB}️`, on: true });
    let m = (await messages(channel)).find((x) => x.id === target.id);
    result(m?.reactions?.length === 1 && chip(m, THUMB)?.count === 1 && chip(m, THUMB)?.mine === true, '👍 and 👍+FE0F are one chip, mine, count 1', chips(m));
    result((await code(call('react', { messageId: target.id, emoji: 'a', on: true }))) === 'bad-request', 'a plain letter is refused (bad-request)');
    result((await code(call('react', { messageId: target.id, emoji: '\u{1F44D}‍', on: true }))) === 'bad-request', 'a trailing ZWJ is refused (bad-request)');
    result((await code(call('react', { messageId: 'f'.repeat(64), emoji: THUMB, on: true }))) === 'not-found', 'an unknown message is not-found');
    for (const e of TEN) await call('react', { messageId: capMsg.id, emoji: e, on: true });
    result((await code(call('react', { messageId: capMsg.id, emoji: '\u{1F60A}', on: true }))) === 'bad-request', 'an 11th emoji on one message is refused (bad-request)');
    await call('react', { messageId: capMsg.id, emoji: TEN[0], on: false });
    result((await code(call('react', { messageId: capMsg.id, emoji: '\u{1F60A}', on: true }))) === 'ok', 'removing one frees a place');
    put('reacted', { target: target.id });

    // B adds 👍 too, then takes it off.
    await take('b-added');
    const t2 = Date.now();
    m = await until(async () => {
      const x = (await messages(channel)).find((y) => y.id === target.id);
      return chip(x, THUMB)?.count === 2 ? x : null;
    }, 60_000);
    result(!!m && chip(m, THUMB).mine === true, 'the owner sees the member\'s 👍 (count 2, still mine)', m ? `${chips(m)} in ${secs(t2)}` : 'not within 60 s');
    put('saw-two');
    await take('b-removed');
    const t3 = Date.now();
    m = await until(async () => {
      const x = (await messages(channel)).find((y) => y.id === target.id);
      return chip(x, THUMB)?.count === 1 ? x : null;
    }, 60_000);
    result(!!m, 'the owner sees the member take it off (count 1)', m ? secs(t3) : 'not within 60 s');
    await call('react', { messageId: target.id, emoji: THUMB, on: false });
    m = (await messages(channel)).find((x) => x.id === target.id);
    result(!m?.reactions, 'with no reactions left the field is absent', chips(m));
    put('cleared');

    // G-29 typing: B types, stops, then turns its indicator off and types again.
    const { bId } = await take('has-msgs-id', 10_000).catch(() => ({}));
    const typingFor = (since) => events.filter((e) => e.event === 'typing' && e.payload?.channelId === channel && e.at >= since);
    const { at: tOn } = await take('typing-off', 120_000);
    const seenOn = typingFor(tOn - 1000).find((e) => e.payload.userIds?.includes(bId));
    result(!!seenOn, 'the owner gets a typing event naming the member', seenOn ? `${seenOn.at - tOn} ms after the first setTyping` : JSON.stringify(typingFor(tOn - 1000).map((e) => e.payload)));
    const cleared = await until(async () => typingFor(tOn).filter((e) => e.payload.userIds?.length === 0).length > 0 || null, 10_000);
    result(!!cleared, 'the typing set empties after setTyping(false)', cleared ? 'empty list' : 'still typing after 10 s');
    const { at: tQuiet } = await take('typing-quiet', 120_000);
    const leaked = typingFor(tQuiet - 7000).filter((e) => e.payload.userIds?.includes(bId));
    result(leaked.length === 0, 'with "Show others when I\'m typing" off, nothing reaches the owner', leaked.length ? `${leaked.length} events` : 'no events');

    // G-53 removed accounts: kick B, list, undo, B rejoins with the invite.
    await take('member-list-tried', 60_000);
    await call('kickMember', { serverId: s.id, userId: bId });
    const removed = await call('listRemovedMembers', { serverId: s.id });
    const rb = removed.find((x) => x.id === bId);
    result(!!rb && rb.displayName === 'r050-b' && !!rb.shortCode && !!rb.removedAt, 'the owner lists the kicked member as removed (name, code, time)', JSON.stringify(removed.map((x) => ({ n: x.displayName, c: !!x.shortCode, t: !!x.removedAt }))));
    put('kicked');
    await take('saw-kick', 120_000);
    await call('undoKick', { serverId: s.id, userId: bId });
    result((await call('listRemovedMembers', { serverId: s.id })).length === 0, 'undoKick empties the removed list');
    result((await code(call('undoKick', { serverId: s.id, userId: bId }))) === 'not-allowed', 'undoKick for someone not removed is not-allowed');
    put('undone', { link: s.inviteLink });
    const t4 = Date.now();
    const back = await until(async () => (await call('listMembers', { serverId: s.id })).some((x) => x.id === bId) || null, 180_000);
    result(!!back, 'after the undo the member rejoins with the invite', back ? secs(t4) : 'not within 180 s');

    // G-78 app lock, core side (this device only).
    const AL = (a) => call('setAppLock', { method: 'passcode', idleMinutes: 5, lockOnSleep: true, ...a });
    const off = await call('getAppLock');
    result(off.enabled === false && off.method === 'passcode' && off.idleMinutes === 5 && off.lockOnSleep === true && !('verifier' in off) && !('salt' in off), 'getAppLock: off by default, no verifier or salt', JSON.stringify(off));
    result((await code(AL({ passcode: '123' }))) === 'bad-request', 'a 3-digit passcode is bad-request');
    result((await code(AL({ passcode: '2468', idleMinutes: 61 }))) === 'bad-request', 'idleMinutes 61 is bad-request');
    result((await AL({ passcode: '246810' }))?.result === 'ok', 'setAppLock with a 6-digit passcode');
    result((await call('getAppLock')).enabled === true, 'getAppLock says enabled');
    result((await call('verifyAppLock', { passcode: '246810' })).result === 'ok', 'the right passcode is ok');
    const noCur = await AL({ passcode: '135790' }).then((r) => r?.result ?? 'ok', (e) => (e.message.match(/"code":"([^"]+)"/) ?? [, e.message])[1]);
    result(noCur !== 'ok', 'changing it without the current passcode is refused', noCur);
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await call('verifyAppLock', { passcode: '000000' }));
    result(answers.every((x) => x.result === 'wrong') && answers[4].retryAfter === 30, 'the 5th wrong passcode in a row starts a 30 s delay', JSON.stringify(answers.map((x) => x.retryAfter ?? x.result)));
    const limited = await call('verifyAppLock', { passcode: '246810' });
    result(limited.result === 'rate-limited' && limited.retryAfter > 0, 'during the delay even the right passcode is rate-limited', JSON.stringify(limited));
    const wl = await call('clearAppLockWithWords', { words: words.join(' ') });
    result(wl.result === 'rate-limited', 'the words share the counter (rate-limited too)', JSON.stringify(wl));
    await sleep((limited.retryAfter ?? 30) * 1000 + 1500);
    const ww = await call('clearAppLockWithWords', { words: 'wrong '.repeat(12).trim() });
    result(ww.result !== 'ok', 'wrong words do not clear it', JSON.stringify(ww));
    // The wrong words above count too (6th in a row: a new delay).
    if (ww.retryAfter) await sleep(ww.retryAfter * 1000 + 1500);
    const cw = await call('clearAppLockWithWords', { words: words.join(' ') });
    const after = await call('getAppLock');
    result(cw.result === 'ok' && after.enabled === false, 'the 12 words clear the lock after the delay', JSON.stringify({ cw, enabled: after.enabled }));
    const done = await take('done', 240_000).catch((e) => ({ error: e.message }));
    log('member reports:', JSON.stringify(done));
  } else {
    const { link } = await take('ready', 300_000);
    await newIdentity('r050-b');
    await call('joinServer', { link });
    const s = await until(async () => (await call('listServers')).find((x) => x.name === 'r050'), 120_000);
    if (!s) throw new Error('join failed');
    const channel = (await call('listChannels', { serverId: s.id }))[0].id;
    put('joined');
    await take('sent', 240_000);
    const t0m = Date.now();
    const both = await until(async () => {
      const b = (await messages(channel)).map((x) => x.body);
      return b.includes('react to me') && b.includes('cap test') ? true : null;
    }, 120_000);
    result(!!both, 'the member gets the owner\'s two messages sent after the join', both ? secs(t0m) : 'not within 120 s');
    await call('markRead', { channelId: channel });
    put('has-msgs');
    const { target } = await take('reacted', 240_000);
    const t = Date.now();
    let m = await until(async () => {
      const x = (await messages(channel)).find((y) => y.id === target);
      return chip(x, THUMB)?.count === 1 ? x : null;
    }, 60_000);
    result(!!m && chip(m, THUMB).mine === false, 'the member sees the owner\'s 👍 (count 1, not mine)', m ? `${chips(m)} in ${secs(t)}` : 'not within 60 s');
    const capView = (await messages(channel)).find((y) => y.body === 'cap test');
    log('the cap message as the member sees it:', chips(capView));
    const c = (await call('listChannels', { serverId: s.id })).find((x) => x.id === channel);
    result(!c.unreadCount && !c.mentions, 'reactions are never unread or a mention', JSON.stringify({ unreadCount: c.unreadCount, mentions: c.mentions }));
    const nudges = events.filter((e) => /notif/i.test(e.event ?? ''));
    result(nudges.length === 0, 'reactions never notify', nudges.map((e) => e.event).join(',') || 'none');
    const updated = events.filter((e) => e.event === 'message.updated');
    result(updated.length > 0, 'message.updated arrived for the reaction', `${updated.length}`);
    await call('react', { messageId: target, emoji: THUMB, on: true });
    m = (await messages(channel)).find((y) => y.id === target);
    result(chip(m, THUMB)?.count === 2 && chip(m, THUMB)?.mine === true, 'my 👍 joins the owner\'s chip (count 2, mine)', chips(m));
    put('b-added');
    await take('saw-two');
    await call('react', { messageId: target, emoji: THUMB, on: false });
    put('b-removed');
    await take('cleared');
    const t2 = Date.now();
    m = await until(async () => {
      const x = (await messages(channel)).find((y) => y.id === target);
      return !x?.reactions ? x : null;
    }, 60_000);
    result(!!m, 'the member sees the chip gone once the owner unreacts', m ? secs(t2) : 'not within 60 s');

    // G-29 typing.
    put('has-msgs-id', { bId: (await call('getIdentity')).id });
    const st = await call('getSettings');
    result(st.typingIndicator === true, '"Show others when I\'m typing" is on by default', JSON.stringify(st));
    const tOn = Date.now();
    for (let i = 0; i < 3; i++) {
      await call('setTyping', { channelId: channel, on: true });
      await sleep(2000);
    }
    await call('setTyping', { channelId: channel, on: false });
    put('typing-off', { at: tOn });
    await sleep(3000);
    await call('setTypingIndicator', { on: false });
    result((await call('getSettings')).typingIndicator === false, 'setTypingIndicator(false) sticks');
    for (let i = 0; i < 3; i++) {
      await call('setTyping', { channelId: channel, on: true });
      await sleep(2000);
    }
    await sleep(2000);
    put('typing-quiet', { at: Date.now() });
    await call('setTypingIndicator', { on: true });

    // G-53: a member can't list removed accounts; then the owner kicks me.
    result((await code(call('listRemovedMembers', { serverId: s.id }))) === 'not-allowed', 'a member asking for the removed list gets not-allowed');
    put('member-list-tried');
    await take('kicked', 120_000);
    const t5 = Date.now();
    const gone = await until(async () => events.some((e) => e.event === 'server.removed' && e.payload?.serverId === s.id) || !(await call('listServers')).some((x) => x.id === s.id) || null, 90_000);
    log('after the kick:', JSON.stringify({ gone: !!gone, in: secs(t5), removedEvents: events.filter((e) => e.event === 'server.removed').map((e) => e.payload) }));
    put('saw-kick');
    const { link: again } = await take('undone', 120_000);
    log('rejoin ->', JSON.stringify(await call('joinServer', { link: again }).catch((e) => e.message)));
    put('done', { failed });
  }
} catch (e) {
  result(false, 'the check stopped', e.message);
  if (ROLE === 'b') put('done', { error: e.message });
}
await sleep(1000);
child.stdin.end();
process.exit(failed ? 1 : 0);
