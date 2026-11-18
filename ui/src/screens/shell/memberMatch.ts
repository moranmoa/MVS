import { nameSkeleton } from '../../core/sanitize';

/** G-41: the member list gets a search field from this many members. */
export const SEARCH_FROM = 15;
/** G-41: the result count is read out once typing stops this long. */
export const COUNT_DELAY_MS = 300;

/** A short code as typed or shown: lower case, no dash or spaces. */
const codeKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * G-41: a matcher for the member search. A member matches when the query is
 * the start of their name or of any word in it, compared by skeleton (case,
 * niqqud and look-alike letters ignored, so "admin" finds "Αdmin"), or the
 * start of their identity short code (with or without the dash). An empty
 * query matches everyone.
 */
export function memberMatcher(query: string): (m: { displayName: string; shortCode: string }) => boolean {
  const q = query.trim();
  if (!q) return () => true;
  const name = nameSkeleton(q);
  const code = codeKey(q);
  return (m) => {
    if (code && codeKey(m.shortCode).startsWith(code)) return true;
    if (!name) return false;
    if (nameSkeleton(m.displayName).startsWith(name)) return true;
    return m.displayName.split(/[\s\-_.]+/u).some((w) => w && nameSkeleton(w).startsWith(name));
  };
}
