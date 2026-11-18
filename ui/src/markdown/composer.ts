// G-25 composer help (spec docs/ux/specs/markdown.md §3): shortcuts that wrap
// the selection in a marker, Enter inside an open ``` fence, and the
// one-time formatting hint. The composer stays plain text.

/** Ctrl+B / I / E / Shift+X, by physical key so a Hebrew layout works too. */
export function shortcutMarker(e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.shiftKey) return e.code === 'KeyX' ? '~~' : null;
  return e.code === 'KeyB' ? '**' : e.code === 'KeyI' ? '*' : e.code === 'KeyE' ? '`' : null;
}

export interface Edit {
  /** The range to replace... */
  from: number;
  to: number;
  /** ...with this, */
  insert: string;
  /** then select this (in the new text). */
  selStart: number;
  selEnd: number;
}

/**
 * Wrapping [start, end) in `marker`: around the selection (kept selected), or
 * a pair with the caret between when nothing is selected. A selection that
 * is already wrapped in exactly this marker is unwrapped (a toggle).
 */
export function wrapEdit(text: string, start: number, end: number, marker: string): Edit {
  const n = marker.length;
  const sel = text.slice(start, end);
  const before = text.slice(start - n, start);
  const after = text.slice(end, end + n);
  // "*" must not unwrap one side of a "**" pair.
  const exact = n !== 1 || (text[start - 2] !== marker && text[end + 1] !== marker);
  if (start >= n && before === marker && after === marker && sel && exact) {
    return { from: start - n, to: end + n, insert: sel, selStart: start - n, selEnd: end - n };
  }
  return { from: start, to: end, insert: marker + sel + marker, selStart: start + n, selEnd: end + n };
}

/** The text after an Edit, for when the editor can't apply it natively. */
export function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}

const FENCE_LINE = /^\s{0,3}```/;

/** True when the caret is inside a ``` fence that isn't closed before it. */
export function insideOpenFence(text: string, caret: number): boolean {
  let open = false;
  for (const line of text.slice(0, caret).split('\n')) if (FENCE_LINE.test(line)) open = !open;
  return open;
}

const HINT_KEY = 'mvs.md.hint.v1';

/** The hint is due when someone first types * or ` twice, and was never dismissed here. */
export function hintDue(text: string): boolean {
  if (!/\*[^*\n]*\*|`[^`\n]*`/.test(text)) return false;
  try {
    return localStorage.getItem(HINT_KEY) !== 'dismissed';
  } catch {
    return false; // can't remember a dismissal: don't nag
  }
}

export function dismissHint(): void {
  try {
    localStorage.setItem(HINT_KEY, 'dismissed');
  } catch {
    // Not remembered; it hides for now anyway.
  }
}
