#!/usr/bin/env node
// A stand-in for mvs-core that speaks the same line protocol (core/api
// README, "Sidecar") and misbehaves on cue, for the shell's tests:
//   getAppInfo        -> answers with its argv and the env keys it got
//   joinServer        -> an event, then the response (events come first)
//   getRecoveryWords  -> words (the shell must never log them)
//   getStorageUsage   -> never answers (timeout)
//   clearCache        -> exits (crash)
//   exportDiagnostics -> a 17 MiB line (over the shell's cap)
//   joinCall          -> call.state, then the CallState (me alone); channel
//                        'e'x64 is ended by the core 300 ms later
//   leaveCall         -> call.state with no participants, then null
//   getAppLock        -> <data-dir>/fake-applock.json if there is one (G-78
//                        e2e); else the default echo, which reads as "off"
//   verifyAppLock     -> ok for the stored passcode (default '2468'), else
//                        wrong; set/clear/words share one attempt counter
'use strict';

const WORDS = ['fake', 'words', 'never', 'logged'];
let buf = '';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.stderr.write('fake core up\n');

// Every command received is appended to <data-dir>/commands.log, so tests can
// see what main sent on its own (e.g. joinServer from an mvs:// link).
const fs = require('node:fs');
const path = require('node:path');
const dataDir = process.argv[process.argv.indexOf('--data-dir') + 1];
const record = (m) => {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'commands.log'), `${JSON.stringify({ cmd: m.cmd, args: m.args })}\n`);
  } catch {
    // no data dir in some unit tests
  }
};

// G-78: the lock lives in <data-dir>/fake-applock.json, like the real core's
// DB row: { enabled, passcode, idleMinutes, lockOnSleep, wrong, until }. One
// attempt counter (verify, set's current, clear, words): the 5th wrong in a
// row answers wrong with retryAfter 30, then rate-limited until it runs out.
const LOCK_FILE = () => path.join(dataDir, 'fake-applock.json');
const readLock = () => {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE(), 'utf8'));
  } catch {
    return null;
  }
};
const writeLock = (cfg) => fs.writeFileSync(LOCK_FILE(), JSON.stringify(cfg));
const waitLeft = (cfg) => (cfg && cfg.until > Date.now() ? Math.ceil((cfg.until - Date.now()) / 1000) : 0);
const attempt = (check) => {
  const cfg = readLock();
  const wait = waitLeft(cfg);
  if (wait) return { result: 'rate-limited', retryAfter: wait };
  if (check(cfg)) {
    if (cfg) writeLock({ ...cfg, wrong: 0, until: 0 });
    return { result: 'ok' };
  }
  const wrong = ((cfg && cfg.wrong) || 0) + 1;
  const until = wrong >= 5 ? Date.now() + 30_000 : 0;
  writeLock({ ...(cfg ?? {}), wrong: wrong >= 5 ? 0 : wrong, until });
  return until ? { result: 'wrong', retryAfter: 30 } : { result: 'wrong' };
};

// QA MR.1: <data-dir>/fake-emit-memberrelay → one memberRelay.changed 1.5 s
// after start (while the app is still locked).
try {
  if (fs.existsSync(path.join(dataDir, 'fake-emit-memberrelay'))) {
    setTimeout(() => out({ type: 'event', event: 'memberRelay.changed', payload: { role: true, setting: 'auto', effective: false, disclosureSeen: false } }), 1500);
  }
} catch {
  // no data dir in some unit tests
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      out({ type: 'response', id: null, error: { code: 'bad-request' } });
      continue;
    }
    record(m);
    switch (m.cmd) {
      case 'getAppInfo': {
        // Required updates (#577): <data-dir>/fake-required.json holds updateRequired.
        let updateRequired = null;
        try {
          updateRequired = JSON.parse(fs.readFileSync(path.join(dataDir, 'fake-required.json'), 'utf8'));
        } catch {
          // not required
        }
        out({ type: 'response', id: m.id, ok: { argv: process.argv.slice(2), env: Object.keys(process.env).sort(), args: m.args, updateRequired } });
        break;
      }
      case 'joinServer':
        out({ type: 'event', event: 'join.status', payload: { link: m.args.link, state: 'searching' } });
        out({ type: 'response', id: m.id, ok: { link: m.args.link, state: 'searching' } });
        break;
      case 'getRecoveryWords':
        out({ type: 'response', id: m.id, ok: WORDS });
        break;
      case 'getStorageUsage':
        break;
      case 'clearCache':
        process.exit(3);
        break;
      case 'exportDiagnostics':
        process.stdout.write(`{"type":"response","id":${m.id},"ok":"${'x'.repeat(17 * 1024 * 1024)}"}\n`);
        break;
      case 'joinCall': {
        const call = { channelId: m.args.channelId, participants: [{ identity: 'a'.repeat(64), muted: false }], full: false };
        out({ type: 'event', event: 'call.state', payload: call });
        out({ type: 'response', id: m.id, ok: call });
        if (m.args.channelId === 'e'.repeat(64)) {
          setTimeout(() => out({ type: 'event', event: 'call.state', payload: { ...call, participants: [] } }), 300);
        }
        break;
      }
      case 'leaveCall':
        out({ type: 'event', event: 'call.state', payload: { channelId: 'c'.repeat(64), participants: [], full: false } });
        out({ type: 'response', id: m.id, ok: null });
        break;
      case 'checkRecoveryWords':
        out({ type: 'response', id: m.id, error: { code: 'invalid-words', positions: [2, 'x', 5], secret: 'dropped' } });
        break;
      case 'getAppLock': {
        const cfg = readLock();
        const answer = () => {
          if (!cfg) return out({ type: 'response', id: m.id, ok: m.args ?? null }); // no lock file: the echo ("off")
          const wait = waitLeft(cfg);
          out({ type: 'response', id: m.id, ok: { enabled: !!cfg.enabled, method: 'passcode', idleMinutes: cfg.idleMinutes ?? 5, lockOnSleep: cfg.lockOnSleep !== false, ...(wait ? { retryAfter: wait } : {}) } });
        };
        // A slow core at start (QA, fresh profile): <data-dir>/fake-applock-delay holds ms.
        let delay = 0;
        try {
          delay = Number(fs.readFileSync(path.join(dataDir, 'fake-applock-delay'), 'utf8')) || 0;
        } catch {
          // no delay
        }
        if (delay > 0) setTimeout(answer, delay);
        else answer();
        break;
      }
      case 'verifyAppLock':
        out({ type: 'response', id: m.id, ok: attempt((cfg) => !cfg || !cfg.enabled || m.args?.passcode === (cfg.passcode ?? '2468')) });
        break;
      case 'setAppLock': {
        const cfg = readLock() ?? { enabled: false };
        if (cfg.enabled) {
          const res = attempt((c) => m.args?.current === (c.passcode ?? '2468'));
          if (res.result !== 'ok') {
            out({ type: 'response', id: m.id, ok: res });
            break;
          }
        }
        writeLock({ ...readLock(), enabled: true, passcode: m.args.passcode, idleMinutes: m.args.idleMinutes, lockOnSleep: m.args.lockOnSleep });
        out({ type: 'response', id: m.id, ok: { result: 'ok' } });
        break;
      }
      case 'clearAppLock': {
        const res = attempt((c) => !c?.enabled || m.args?.current === (c.passcode ?? '2468'));
        if (res.result === 'ok') writeLock({ ...readLock(), enabled: false, passcode: undefined });
        out({ type: 'response', id: m.id, ok: res });
        break;
      }
      case 'clearAppLockWithWords': {
        const res = attempt(() => m.args?.words === WORDS.concat(WORDS, WORDS).join(' '));
        if (res.result === 'ok') writeLock({ ...readLock(), enabled: false, passcode: undefined });
        out({ type: 'response', id: m.id, ok: res });
        break;
      }
      default:
        out({ type: 'response', id: m.id, ok: m.args ?? null });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
