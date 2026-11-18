// G-26 / G-27 (chat-and-voice-extras.md §3): a compact emoji picker. Search on top,
// the most recent (24, this computer only), then a common set with names in he and
// en. The full CLDR set and categories are G-27.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { normalizeEmoji } from '../core/emoji';
import { Dialog } from './common';

/** [emoji, English name, Hebrew name]. */
const COMMON: [string, string, string][] = [
  ['👍', 'thumbs up', 'אגודל למעלה'],
  ['👎', 'thumbs down', 'אגודל למטה'],
  ['❤️', 'red heart', 'לב אדום'],
  ['😂', 'face with tears of joy laugh', 'פרצוף צוחק עם דמעות צחוק'],
  ['🤣', 'rolling on the floor laughing', 'מתגלגל מצחוק'],
  ['😊', 'smiling face with smiling eyes', 'פרצוף מחייך'],
  ['😀', 'grinning face', 'פרצוף מחייך חיוך רחב'],
  ['😅', 'grinning face with sweat', 'חיוך עם זיעה'],
  ['😉', 'winking face', 'קורץ'],
  ['😍', 'smiling face with heart eyes', 'עיני לב'],
  ['😎', 'smiling face with sunglasses cool', 'משקפי שמש'],
  ['🤔', 'thinking face', 'חושב'],
  ['😮', 'face with open mouth wow', 'פה פעור'],
  ['😢', 'crying face sad', 'בוכה עצוב'],
  ['😭', 'loudly crying face', 'בוכה בקול'],
  ['😡', 'enraged face angry', 'כועס'],
  ['🙄', 'face with rolling eyes', 'מגלגל עיניים'],
  ['😴', 'sleeping face', 'ישן'],
  ['🥳', 'partying face', 'חוגג'],
  ['🤯', 'exploding head mind blown', 'ראש מתפוצץ'],
  ['😬', 'grimacing face', 'מעוות פנים'],
  ['🙏', 'folded hands please thanks', 'ידיים מתפללות תודה'],
  ['👏', 'clapping hands', 'מחיאות כפיים'],
  ['🙌', 'raising hands', 'ידיים מורמות'],
  ['👋', 'waving hand hello', 'נפנוף שלום'],
  ['💪', 'flexed biceps strong', 'שריר חזק'],
  ['👀', 'eyes', 'עיניים'],
  ['🔥', 'fire', 'אש'],
  ['✨', 'sparkles', 'נצנצים'],
  ['🎉', 'party popper', 'מסיבה'],
  ['💯', 'hundred points', 'מאה'],
  ['✅', 'check mark button yes', 'וי כן'],
  ['❌', 'cross mark no', 'איקס לא'],
  ['⭐', 'star', 'כוכב'],
  ['💡', 'light bulb idea', 'נורה רעיון'],
  ['🎮', 'video game', 'משחק וידאו'],
  ['🏆', 'trophy', 'גביע'],
  ['🎯', 'direct hit target', 'בול'],
  ['🚀', 'rocket', 'טיל'],
  ['🍕', 'pizza', 'פיצה'],
  ['☕', 'hot beverage coffee', 'קפה'],
  ['🐐', 'goat', 'עז'],
  ['🤝', 'handshake', 'לחיצת יד'],
  ['💀', 'skull', 'גולגולת'],
  ['🫡', 'saluting face', 'מצדיע'],
  ['👌', 'ok hand', 'אוקיי'],
  ['💔', 'broken heart', 'לב שבור'],
  ['🇮🇱', 'flag israel', 'דגל ישראל'],
];

const RECENT_KEY = 'mvs.emoji.recent.v1';
const RECENT_MAX = 24;

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && normalizeEmoji(e) !== null).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecent(emoji: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX)));
  } catch {
    // Not remembered this time.
  }
}

const COLUMNS = 8;

export function EmojiPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (emoji: string) => void }) {
  const intl = useIntl();
  const he = intl.locale.startsWith('he');
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setRecent(loadRecent());
    const t = setTimeout(() => searchRef.current?.focus());
    return () => clearTimeout(t);
  }, [open]);

  const nameOf = useMemo(() => new Map(COMMON.map(([e, en, hb]) => [normalizeEmoji(e) ?? e, he ? hb : en])), [he]);
  const q = query.trim().toLowerCase();
  const results = q ? COMMON.filter(([, en, hb]) => en.includes(q) || hb.includes(q)).map(([e]) => e) : null;

  const pick = (emoji: string) => {
    const e = normalizeEmoji(emoji);
    if (!e) return;
    rememberRecent(e);
    onPick(e);
    onClose();
  };
  /** Arrows move through the grid (mirrored in RTL); Home/End to the ends. */
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const cells = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button.emoji-cell') ?? [])];
    const i = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[e.key];
    let to = step === undefined ? -1 : i + step;
    if (e.key === 'Home') to = 0;
    if (e.key === 'End') to = cells.length - 1;
    if (e.key === 'ArrowUp' && to < 0) return searchRef.current?.focus();
    if (to < 0 || to >= cells.length) return;
    e.preventDefault();
    cells[to].focus();
  };
  const cell = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      className="emoji-cell"
      aria-label={nameOf.get(normalizeEmoji(emoji) ?? emoji) ?? emoji}
      title={nameOf.get(normalizeEmoji(emoji) ?? emoji)}
      onClick={() => pick(emoji)}
    >
      {emoji}
    </button>
  );
  return (
    <Dialog open={open} onClose={onClose} title={intl.formatMessage({ id: 'reactions.add' })} className="emoji-picker">
      <input
        ref={searchRef}
        type="search"
        className="emoji-search"
        aria-label={intl.formatMessage({ id: 'emoji.search' })}
        placeholder={intl.formatMessage({ id: 'emoji.search' })}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            gridRef.current?.querySelector<HTMLButtonElement>('button.emoji-cell')?.focus();
          } else if (e.key === 'Enter' && results?.length) {
            e.preventDefault();
            pick(results[0]);
          }
        }}
      />
      <div ref={gridRef} onKeyDown={move}>
        {results ? (
          results.length ? (
            <div className="emoji-grid">{results.map(cell)}</div>
          ) : (
            <p className="muted small">{intl.formatMessage({ id: 'emoji.none' })}</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <>
                <h3 className="emoji-heading">{intl.formatMessage({ id: 'emoji.recent' })}</h3>
                <div className="emoji-grid">{recent.map(cell)}</div>
              </>
            )}
            <h3 className="emoji-heading">{intl.formatMessage({ id: 'emoji.common' })}</h3>
            <div className="emoji-grid">{COMMON.map(([e]) => cell(e))}</div>
          </>
        )}
      </div>
    </Dialog>
  );
}
