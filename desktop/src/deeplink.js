// mvs:// links that reach the app from the OS (a click in a browser or chat).
// Anything the OS hands us on the command line is untrusted: only a link of
// one exact format passes. Links and argv are never logged.
// - an invite: used for one thing only, as the argument of joinServer (core/api
//   model.rs `parse_invite_link`);
// - G-30, a message link: the three IDs go to the page as `link.message`
//   (docs/design/g30-message-links.md §3); the page never re-parses the URL.

'use strict';

const SCHEME = 'mvs';
/**
 * mvs://join/<server id>/<invite record id>/<server secret>, each 32 bytes hex
 * (GAP-4). The secret is a bearer credential: links are never logged, and a
 * link without it is not an invite.
 */
const INVITE = /^mvs:\/\/join\/([0-9a-f]{64})\/([0-9a-f]{64})\/([0-9a-f]{64})\/?$/;
/** G-30: mvs://m/<server id>/<channel id>/<message id>, the core's 64-hex IDs, nothing else. */
const MESSAGE = /^mvs:\/\/m\/([0-9a-f]{64})\/([0-9a-f]{64})\/([0-9a-f]{64})\/?$/;
const MAX_LEN = 256;
/** G-30 (SL): the window comes forward for a deep link at most this often. */
const FOCUS_EVERY_MS = 2000;

const shape = (raw) => (typeof raw === 'string' && raw.length <= MAX_LEN ? raw.trim().toLowerCase() : null);

/** The canonical invite link, or null. */
function parseInviteLink(raw) {
  const s = shape(raw);
  const m = s && INVITE.exec(s);
  return m ? `mvs://join/${m[1]}/${m[2]}/${m[3]}` : null;
}

/** G-30: { serverId, channelId, messageId } from a message link, or null. */
function parseMessageLink(raw) {
  const s = shape(raw);
  const m = s && MESSAGE.exec(s);
  return m ? { serverId: m[1], channelId: m[2], messageId: m[3] } : null;
}

/**
 * Either kind: { kind: 'invite', link } | { kind: 'message', serverId,
 * channelId, messageId } | null.
 */
function parseLink(raw) {
  const link = parseInviteLink(raw);
  if (link) return { kind: 'invite', link };
  const ids = parseMessageLink(raw);
  return ids ? { kind: 'message', ...ids } : null;
}

/**
 * The link in a command line (first launch or a second instance on Windows
 * and Linux), or null. The first argument that starts with mvs:// decides;
 * if it is neither kind, there is no link.
 */
function linkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}://`)) return parseLink(a);
  }
  return null;
}

/**
 * Does a command line try to open any mvs:// link, well-formed or not? Such a
 * launch is throttled like a link (SL), not treated as a plain relaunch.
 */
function hasLinkArg(argv) {
  return Array.isArray(argv) && argv.some((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}://`));
}

/** The invite link in a command line, or null (an older name, kept for callers). */
function inviteFromArgv(argv) {
  const l = linkFromArgv(argv);
  return l && l.kind === 'invite' ? l.link : null;
}

/** G-30 (SL): `allow()` is true at most once every `ms` (the latest link still wins; only focus waits). */
function createFocusThrottle({ ms = FOCUS_EVERY_MS, now = Date.now } = {}) {
  let last = -Infinity;
  return {
    allow() {
      const t = now();
      if (t - last < ms) return false;
      last = t;
      return true;
    },
  };
}

module.exports = { SCHEME, FOCUS_EVERY_MS, parseInviteLink, parseMessageLink, parseLink, linkFromArgv, hasLinkArg, inviteFromArgv, createFocusThrottle };
