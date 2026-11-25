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
  ]),
);

/** The update itself. */
const UPDATE = Object.freeze(new Set(['getAppInfo', 'restartToUpdate']));

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
    'signOut',
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
  const state = () => ({ required: !!required, version: required ? required.version : null, active: active(), callEndsAt });
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
    /** May the page send this core command now? */
    allows(cmd) {
      if (!active()) return true;
      return READ_ONLY.has(cmd) || UPDATE.has(cmd);
    },
  };
}

module.exports = { READ_ONLY, UPDATE, NOT_READ_ONLY, CALL_CAP_MS, cleanRequired, createRequiredGate };
