// G-30 (docs/design/g30-message-links.md §2): a link to a message,
// mvs://m/<server id>/<channel id>/<message id>. Never an https form: that
// would hand the ids, and the fact someone opened them, to a web server.

import type { Id } from '../core';

const LINK = /^mvs:\/\/m\/([0-9a-f]{64})\/([0-9a-f]{64})\/([0-9a-f]{64})\/?$/;
const MAX_LEN = 256;

/**
 * The link to a message. The core's ids are 64 hex; the demo's aren't, and its
 * links don't parse back (only real links are ever opened).
 */
export function messageLink(serverId: Id, channelId: Id, messageId: Id): string {
  return `mvs://m/${serverId}/${channelId}/${messageId}`;
}

/** The three ids of an exact message link (case-insensitive, one optional "/"), or null. */
export function parseMessageLink(raw: unknown): { serverId: Id; channelId: Id; messageId: Id } | null {
  if (typeof raw !== 'string' || raw.length > MAX_LEN) return null;
  const m = LINK.exec(raw.trim().toLowerCase());
  return m ? { serverId: m[1], channelId: m[2], messageId: m[3] } : null;
}
