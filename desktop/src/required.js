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
    'countAgeAffected',
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
    // G-48: the reports this computer holds; dismissing one is a local flag,
    // and the evidence is a stored box opened with a key held here (SL).
    'listReports',
    'dismissReport',
    'getReportEvidence',
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
    'setAgeRestriction',
    'setServerIcon',
    'setServerDescription',
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
    'setCallWebrtcPeers',
    'setMemberRelay',
    'setMemberRelayCap',
    // G-48: a report is a signed record.
    'reportContent',
  ]),
);

/** The core's updateRequired / update.required payload: { version } or null. */
function cleanRequired(v) {
  if (!v || typeof v !== 'object') return null;
  const version = typeof v.version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/.test(v.version) ? v.version : null;
  return { version };
}

/**
 * The gate. A required update applies at once (TL, confirmed by the PO): the
 * core's RU1 already stops voice and sync, so a call in progress is ended
 * cleanly right away (`endCall()`: a normal leave), with no grace period.
 * `onChange(state)` gets every change of { required, version, active, phase,
 * endedCall }; `endedCall` is true when this gate ended a call (the banner
 * says so: update.required.callEnded).
 */
function createRequiredGate({ inCall, endCall, onChange = () => {} }) {
  let required = null; // { version } once set; never cleared in this process
  let endedCall = false;

  const active = () => !!required;
  /** 'none' | 'gated'. */
  const phase = () => (required ? 'gated' : 'none');
  const state = () => ({ required: !!required, version: required ? required.version : null, active: active(), phase: phase(), endedCall });
  const changed = () => onChange(state());

  /** A call still running under a required update ends now. True if it ended one. */
  const endRunningCall = () => {
    if (!required || !inCall()) return false;
    endedCall = true;
    endCall();
    return true;
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
      endRunningCall();
      changed();
      return true;
    },
    /** After any change to the call (main's syncCall): no call may run while required. */
    callChanged() {
      // A racing call ended: the page hears it (the banner's "call ended", TL).
      if (endRunningCall()) changed();
    },
    get active() {
      return active();
    },
    /** May the page send this core command now? Not required: anything. Required: reads and the update. */
    allows(cmd) {
      if (!required) return true;
      return READ_ONLY.has(cmd) || UPDATE.has(cmd);
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
      // Only a plain code goes back to the page (TL): anything else is 'internal'.
      if (res && res.error) return typeof res.error.code === 'string' && /^[a-z-]{1,40}$/.test(res.error.code) ? res.error.code : 'internal';
      return 'ok';
    } catch {
      return 'internal';
    } finally {
      busy = false;
    }
  };
}

module.exports = { READ_ONLY, UPDATE, NOT_READ_ONLY, CHECK_EVERY_MS, cleanRequired, createRequiredGate, createCheckThrottle };
