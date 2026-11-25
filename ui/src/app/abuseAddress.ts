/**
 * G-48 / B24: the build's abuse-report address from getAppInfo (the shell reads
 * it from mvs-config.json, #552), or '' unless it is a plain e-mail address or
 * an https URL: short, no spaces or controls, no credentials. Shown as text
 * only; never opened (no mailto: per the security lead on #552).
 */
export function cleanAbuseAddress(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 254 || /[\s\p{C}]/u.test(raw)) return '';
  if (/^[^@/]+@[^@/]+\.[a-z]{2,}$/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}
