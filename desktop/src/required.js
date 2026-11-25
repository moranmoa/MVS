// Required updates (docs/design/required-update.md, #577): when the core says
// the running version was revoked (`updateRequired`), the app goes local
// read-only plus update. Main is the gate: the page may still read what is on
// this computer and update, but not send, join, call or sign. The core's own
// part (RU1: no automatic signing, no sync networking) is the core's.
//
// Every command in commands.js is classified here, read-only or not; a test
// fails on an unclassified one, so a new command is refused while required
// until someone decides it only reads.
'use strict';

/**
 * Local reads and local-only settings: nothing here signs, publishes or talks
 * to the network.
 */
const READ_ONLY = Object.freeze(
  new Set([
    'getIdentity',
    'getRecoveryChallenge',
    'getRecoveryWords',
    'listServers',
    'listChannels',
    'listMembers',
    'getUpdateNeeded',
    'listInvites',
    'cancelJoin',
    'getMessageCount',
    'getMessages',
    'markRead',
    'discardMessage',
    'blockUser',
    'listBlocked',
    'setBlocked',
    'listRemovedMembers',
    'ackDeviceNotice',
    'getSettings',
    'setTypingIndicator',
    'getServerRestore',
    'locateMessage',
    'listVoiceRooms',
    'getStorageUsage',
    'setStorageLimit',
    'clearCache',
    'exportDiagnostics',
    'setUpdateChannel',
    'setRelayOnly',
    'getMemberRelay',
    'markMemberRelayDisclosureSeen',
    // Leaving a call is always allowed (the gate waits for the call to end anyway).
    'leaveCall',
    // A local wipe, applied before any network (SL): someone stuck on an old
    // version must still be able to remove their data from this computer.
    'signOut',
    // G-48: the reports this computer holds (read only).
    'listReports',
  ]),
);

/**
 * The update itself. The banner's Retry is not here: `checkForUpdate` stays
 * main/core only (B8 A2), and the page asks main through `update:check`,
 * which main rate-limits and runs itself.
 */
const UPDATE = Object.freeze(new Set(['getAppInfo', 'restartToUpdate']));
/** How often main runs a check the page asked for (Retry). */
const CHECK_EVERY_MS = 30_000;

/**
 * While a required update waits for a call to end (TL): only the call's own
 * commands pass, besides reads and the update. No sends, joins or kicks.
 */
const CALL = Object.freeze(new Set(['setMuted', 'setDeafened', 'sendSignal', 'leaveCall']));

/**
 * Everything else: writes, signed actions and the network. Listed so the
 * classification is explicit (a test checks the two lists cover commands.js).
 */
const NOT_READ_ONLY = Object.freeze(
  new Set([
    'createIdentity',
    'checkRecoveryWords',
    'restoreIdentity',
    'updateProfile',
    'createChannel',
    'updateChannel',
    'setChannelTopic',
    'deleteChannel',
    'createServer',
    'joinServer',
    'renameServer',
    'leaveServer',
    'closeServer',
    'createInvite',
    'revokeInvite',
    'sendMessage',
    'editMessage',
    'deleteMessage',
    'react',
    'retryMessage',
    'moveChannel',
    'kickMember',
    'undoKick',
    'startDeviceLink',
    'cancelDeviceLink',
    'confirmDeviceLink',
    'beginDeviceApproval',
    'confirmDeviceApproval',
    'setTyping',
    'createVoiceRoom',
    'editVoiceRoom',
    'joinCall',
    'setMuted',
    'setDeafened',
    'sendSignal',
    'setMemberRelay',
    'setMemberRelayCap',
    // G-48 reports: a report is a signed record; dismissing one and the
    // evidence fetch are kept off until confirmed local-only (SL to check).
    'reportContent',
    'dismissReport',
    'getReportEvidence',
  ]),
);

/** How long a required update waits for a call to end (SL): 30 min. */
const CALL_CAP_MS = 30 * 60 * 1000;

/** The core's updateRequired / update.required payload: { version } or null. */
function cleanRequired(v) {
  if (!v || typeof v !== 'object') return null;
  const version = typeof v.version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/.test(v.version) ? v.version : null;
  return { version };
}

/**
 * The gate. `inCall()` is the call gate; `endCall()` ends the call when the
 * 30 min cap runs out; `onChange(state)` gets every change of
 * { required, version, active, callEndsAt }.
 */
function createRequiredGate({ inCall, endCall, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, capMs = CALL_CAP_MS }) {
  let required = null; // { version } once set; never cleared in this process
  let capped = false;
  let callEndsAt = null;
  let timer = null;

  const active = () => !!required && (capped || !inCall());
  /** 'none' | 'call' (required, waiting for the call to end) | 'gated'. */
  const phase = () => (!required ? 'none' : active() ? 'gated' : 'call');
  const state = () => ({ required: !!required, version: required ? required.version : null, active: active(), phase: phase(), callEndsAt });
  const changed = () => onChange(state());

  const startCap = () => {
    if (timer || capped || !required || !inCall()) return;
    callEndsAt = now() + capMs;
    timer = setTimer(() => {
      timer = null;
      capped = true;
      callEndsAt = null;
      endCall();
      changed();
    }, capMs);
  };

  return {
    get state() {
      return state();
    },
    /** The core said so (getAppInfo.updateRequired or update.required). */
    set(payload) {
      const r = cleanRequired(payload);
      if (!r) return false;
      if (required) {
        if (r.version && r.version !== required.version) {
          required = r;
          changed();
        }
        return true;
      }
      required = r;
      startCap();
      changed();
      return true;
    },
    /** After any change to the call (main's syncCall). */
    callChanged() {
      if (!required) return;
      if (!inCall() && timer) {
        clearTimer(timer);
        timer = null;
        callEndsAt = null;
        changed(); // the gate is active now
      } else if (inCall()) {
        startCap();
      }
    },
    get active() {
      return active();
    },
    /**
     * May the page send this core command now? Not required: anything. While
     * waiting for a call to end: reads, the update and the call's own
     * commands. Gated: reads and the update.
     */
    allows(cmd) {
      const p = phase();
      if (p === 'none') return true;
      if (READ_ONLY.has(cmd) || UPDATE.has(cmd)) return true;
      return p === 'call' && CALL.has(cmd);
    },
  };
}

/**
 * The page's Retry: at most one core check per CHECK_EVERY_MS; in between it
 * answers 'too-soon'. `run()` asks the core (checkForUpdate) and resolves its
 * answer. Only a code goes back to the page: 'ok' or the core's error code.
 */
function createCheckThrottle({ run, now = Date.now, every = CHECK_EVERY_MS }) {
  let last = -Infinity;
  let busy = false;
  return async () => {
    if (busy || now() - last < every) return 'too-soon';
    busy = true;
    last = now();
    try {
      const res = await run();
      if (res && res.error) return typeof res.error.code === 'string' ? res.error.code : 'internal';
      return 'ok';
    } catch {
      return 'internal';
    } finally {
      busy = false;
    }
  };
}

module.exports = { READ_ONLY, UPDATE, CALL, NOT_READ_ONLY, CALL_CAP_MS, CHECK_EVERY_MS, cleanRequired, createRequiredGate, createCheckThrottle };
