// G-27 (docs/ux/specs/emoji-picker.md): the emoji picker. One component, two
// modes: "composer" (inserts at the cursor; Shift keeps it open) and "reaction"
// (adds or removes my reaction). A popover anchored to its trigger, a bottom
// sheet below 40rem. Search on top, one scrolling list of sections (recent,
// then the 9 Unicode groups; only the visible rows are rendered), a preview
// strip and the category tabs.

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { useIntl } from 'react-intl';
import { normalizeEmoji } from '../core/emoji';
import { GROUPS, loadEmoji, search, type EmojiData, type EmojiEntry, type Group } from '../emoji';

const RECENT_KEY = 'mvs.emoji.recent.v1';
const RECENT_MAX = 24;
export const COLUMNS = 8;
const CELL = 40;
const HEAD = 28;
const WIDTH = 352;
const HEIGHT = 420;
const MARGIN = 8;
/** 40rem: below it the picker is a bottom sheet. */
const SHEET_BELOW = 640;

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && normalizeEmoji(e) === e).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecent(key: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...loadRecent().filter((e) => e !== key)].slice(0, RECENT_MAX)));
  } catch {
    // Not remembered this time.
  }
}

/** The direction the element is laid out in (its closest `dir`, else the page's). */
const isRtl = (el: Element) => (el.closest('[dir]')?.getAttribute('dir') ?? document.documentElement.dir) === 'rtl';

type Section = 'recent' | Group;
const TAB_GLYPH: Record<Section, string> = {
  recent: '🕘',
  smileys: '😀',
  people: '👋',
  nature: '🐶',
  food: '🍔',
  travel: '✈️',
  activities: '⚽',
  objects: '💡',
  symbols: '🔣',
  flags: '🏳️',
};

type Row = { kind: 'head'; section: Section } | { kind: 'cells'; section: Section; first: number; cells: EmojiEntry[] };

/** Rows for the list (heads and rows of 8) and the flat cell order for the keyboard. */
function layout(sections: [Section | null, EmojiEntry[]][]) {
  const rows: Row[] = [];
  const cells: { entry: EmojiEntry; row: number; col: number }[] = [];
  const sectionRow = new Map<Section, number>();
  for (const [section, entries] of sections) {
    if (!entries.length) continue;
    if (section) {
      sectionRow.set(section, rows.length);
      rows.push({ kind: 'head', section });
    }
    for (let i = 0; i < entries.length; i += COLUMNS) {
      const chunk = entries.slice(i, i + COLUMNS);
      chunk.forEach((entry, col) => cells.push({ entry, row: rows.length, col }));
      rows.push({ kind: 'cells', section: section ?? 'smileys', first: cells.length - chunk.length, cells: chunk });
    }
  }
  return { rows, cells, sectionRow };
}

export interface EmojiPickerProps {
  open: boolean;
  onClose: () => void;
  /** `keep`: Shift+click or Shift+Enter in composer mode: insert and stay open. */
  onPick: (emoji: string, keep: boolean) => void;
  mode: 'composer' | 'reaction';
  /** What opened it: placement, and focus goes back there on close. */
  anchor?: RefObject<HTMLElement | null>;
  /** Reaction mode: the emoji I already reacted with (normalized). */
  selected?: ReadonlySet<string>;
}

export function EmojiPicker({ open, onClose, onPick, mode, anchor, selected }: EmojiPickerProps) {
  const intl = useIntl();
  const he = intl.locale.startsWith('he');
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState<EmojiEntry | null>(null);
  const [place, setPlace] = useState<{ sheet: boolean; style: CSSProperties }>({ sheet: false, style: {} });
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef(false);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && !data) void loadEmoji().then(setData);
  }, [open, data]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      anchorRef.current = anchor?.current ?? (document.activeElement as HTMLElement | null);
      setQuery('');
      setActive(0);
      setHover(null);
      setRecent(loadRecent());
      d.showModal();
      searchRef.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, anchor]);

  // Placement: above (composer) or under (reaction) the trigger, on its start
  // side, flipped and clamped to stay inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const a = anchorRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < SHEET_BELOW) return setPlace({ sheet: true, style: {} });
    if (!a?.isConnected) return setPlace({ sheet: false, style: { top: Math.max(MARGIN, (vh - HEIGHT) / 2), left: Math.max(MARGIN, (vw - WIDTH) / 2) } });
    const r = a.getBoundingClientRect();
    const rtl = isRtl(a);
    const above = r.top - HEIGHT - MARGIN;
    const below = r.bottom + MARGIN;
    const fitsAbove = above >= MARGIN;
    const fitsBelow = below + HEIGHT <= vh - MARGIN;
    let top = mode === 'composer' ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - HEIGHT - MARGIN));
    let left = rtl ? r.right - WIDTH : r.left;
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - WIDTH - MARGIN));
    setPlace({ sheet: false, style: { top, left } });
  }, [open, mode]);

  const close = () => {
    onClose();
    const a = anchorRef.current;
    if (a?.isConnected) requestAnimationFrame(() => a.focus());
  };

  const nameOf = (e: EmojiEntry) => (he ? e.he : e.en);
  const q = query.trim();
  const results = useMemo(() => {
    if (!data || !q) return null;
    const found = search(data, q);
    const recentKeys = new Set(recent);
    return [...found.filter((e) => recentKeys.has(e.key)), ...found.filter((e) => !recentKeys.has(e.key))];
  }, [data, q, recent]);

  const { rows, cells, sectionRow } = useMemo(() => {
    if (!data) return layout([]);
    if (results) return layout([[null, results]]);
    const recentEntries = recent.map((k) => data.byKey.get(k)).filter((e): e is EmojiEntry => !!e);
    return layout([['recent', recentEntries], ...GROUPS.map((g) => [g, data.list.filter((e) => e.group === g)] as [Section, EmojiEntry[]])]);
  }, [data, results, recent]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'head' ? HEAD : CELL),
    overscan: 4,
  });

  // Keep the roving cell in range when the list changes (search, data).
  useEffect(() => setActive((a) => (a < cells.length ? a : 0)), [cells.length]);
  // Focus follows the roving cell once its row is rendered (it may be
  // scrolled in first).
  const [, rerender] = useState(0);
  useLayoutEffect(() => {
    if (!focusAfter.current) return;
    const el = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-i="${active}"]`);
    if (!el) return;
    focusAfter.current = false;
    el.focus();
  });

  const focusCell = (i: number) => {
    const c = cells[i];
    if (!c) return;
    setActive(i);
    focusAfter.current = true;
    virtualizer.scrollToIndex(c.row, { align: 'auto' });
    rerender((n) => n + 1);
  };

  // The section at the top of the list marks its tab.
  const offset = virtualizer.scrollOffset ?? 0;
  const topItem = virtualizer.getVirtualItems().find((v) => v.end > offset + 1);
  const current: Section | null = results ? null : (rows[topItem?.index ?? 0]?.section ?? null);
  const sections: Section[] = [...sectionRow.keys()];

  const pick = (entry: EmojiEntry, keep: boolean) => {
    rememberRecent(entry.key);
    if (mode === 'composer') {
      // The composer puts focus back in the text box itself.
      onPick(entry.glyph, keep);
      if (keep) return setRecent(loadRecent());
      return onClose();
    }
    onPick(entry.key, false);
    close();
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = active;
    const c = cells[i];
    if (!c) return;
    const rtl = isRtl(e.currentTarget);
    const rowCells = (row: number) => {
      const r = rows[row];
      return r?.kind === 'cells' ? r : null;
    };
    const vertical = (dir: 1 | -1) => {
      for (let row = c.row + dir; row >= 0 && row < rows.length; row += dir) {
        const r = rowCells(row);
        if (r) return r.first + Math.min(c.col, r.cells.length - 1);
      }
      return -1;
    };
    /** PageUp / PageDown: the first cell of the previous / next section. */
    const page = (dir: 1 | -1) => {
      const starts = [...sectionRow.values()].sort((a, b) => a - b);
      const here = starts.filter((s) => s < c.row).length - 1;
      const target = starts[Math.max(0, here + dir)];
      const r = target === undefined ? null : rowCells(target + 1);
      return r ? r.first : dir > 0 ? cells.length - 1 : 0;
    };
    let to = -1;
    switch (e.key) {
      case 'ArrowRight':
        to = i + (rtl ? -1 : 1);
        break;
      case 'ArrowLeft':
        to = i + (rtl ? 1 : -1);
        break;
      case 'ArrowDown':
        to = vertical(1);
        break;
      case 'ArrowUp':
        to = vertical(-1);
        if (to < 0) {
          e.preventDefault();
          return searchRef.current?.focus();
        }
        break;
      case 'Home':
        to = i - c.col;
        break;
      case 'End':
        to = rowCells(c.row)!.first + rowCells(c.row)!.cells.length - 1;
        break;
      case 'PageDown':
        to = page(1);
        break;
      case 'PageUp':
        to = page(-1);
        break;
      case 'Enter':
        e.preventDefault();
        return pick(c.entry, e.shiftKey);
      default:
        return;
    }
    e.preventDefault();
    if (to >= 0 && to < cells.length) focusCell(to);
  };

  const goSection = (s: Section) => {
    const row = sectionRow.get(s);
    if (row === undefined) return;
    virtualizer.scrollToIndex(row, { align: 'start' });
    const r = rows[row + 1];
    if (r?.kind === 'cells') setActive(r.first);
  };
  const onTabsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (results) return;
    const rtl = isRtl(e.currentTarget);
    const d = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = tabs[(at + d + tabs.length) % tabs.length];
    next?.focus();
    next?.click();
  };

  const preview = hover ?? cells[active]?.entry ?? null;
  const title = intl.formatMessage({ id: mode === 'reaction' ? 'reactions.add' : 'emoji.insert' });
  const items = virtualizer.getVirtualItems();
  const gridId = 'emoji-grid';

  return (
    <dialog
      ref={ref}
      className={`emoji-picker ${place.sheet ? 'sheet' : 'popover'}`}
      style={place.style}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      {open && (
        <>
          <input
            ref={searchRef}
            type="search"
            className="emoji-search"
            aria-label={intl.formatMessage({ id: 'emoji.search' })}
            placeholder={intl.formatMessage({ id: 'emoji.search' })}
            aria-controls={gridId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              scrollRef.current?.scrollTo?.({ top: 0 });
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && cells.length) {
                e.preventDefault();
                focusCell(active < cells.length ? active : 0);
              } else if (e.key === 'Enter' && results?.length) {
                e.preventDefault();
                pick(results[0], e.shiftKey);
              }
            }}
          />
          <div className="emoji-scroll" ref={scrollRef}>
            {!data ? (
              <p className="muted small emoji-empty" role="status">
                {intl.formatMessage({ id: 'common.loading' })}
              </p>
            ) : results && !results.length ? (
              <p className="muted small emoji-empty" role="status">
                {intl.formatMessage({ id: 'emoji.none' })}
              </p>
            ) : (
              <div
                id={gridId}
                role="grid"
                aria-label={title}
                aria-rowcount={rows.filter((r) => r.kind === 'cells').length}
                aria-colcount={COLUMNS}
                className="emoji-rows"
                style={{ height: virtualizer.getTotalSize() }}
                onKeyDown={onGridKey}
                onMouseLeave={() => setHover(null)}
              >
                {items.map((v) => {
                  const r = rows[v.index];
                  const style: CSSProperties = { transform: `translateY(${v.start}px)`, height: v.size };
                  if (r.kind === 'head') {
                    return (
                      <div key={v.key} className="emoji-heading" role="heading" aria-level={3} style={style}>
                        {intl.formatMessage({ id: `emoji.cat.${r.section}` })}
                      </div>
                    );
                  }
                  return (
                    <div key={v.key} role="row" className="emoji-row" style={style}>
                      {r.cells.map((entry, col) => {
                        const i = r.first + col;
                        const mine = mode === 'reaction' && !!selected?.has(entry.key);
                        return (
                          <button
                            key={entry.key}
                            type="button"
                            role="gridcell"
                            data-i={i}
                            tabIndex={i === active ? 0 : -1}
                            className={`emoji-cell${mine ? ' mine' : ''}`}
                            aria-label={nameOf(entry)}
                            aria-selected={mode === 'reaction' ? mine : undefined}
                            onFocus={() => setActive(i)}
                            onMouseEnter={() => setHover(entry)}
                            onClick={(e: MouseEvent) => pick(entry, e.shiftKey)}
                          >
                            {entry.glyph}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="emoji-preview" aria-hidden="true">
            {preview && (
              <>
                <span className="emoji-preview-glyph">{preview.glyph}</span>
                <span className="emoji-preview-name">{nameOf(preview)}</span>
              </>
            )}
          </div>
          <div
            className={`emoji-tabs${results ? ' dim' : ''}`}
            role="tablist"
            aria-label={intl.formatMessage({ id: 'emoji.categories' })}
            aria-disabled={results ? true : undefined}
            onKeyDown={onTabsKey}
          >
            {(results ? sectionsFor(data, recent) : sections).map((s) => {
                const label = intl.formatMessage({ id: `emoji.cat.${s}` });
                const on = s === (current ?? sections[0]);
                return (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-label={label}
                    title={label}
                    aria-selected={!results && on}
                    aria-controls={gridId}
                    tabIndex={results ? -1 : on ? 0 : -1}
                    disabled={!!results}
                    className="emoji-tab"
                    onClick={() => goSection(s)}
                  >
                    {TAB_GLYPH[s]}
                  </button>
                );
              })}
          </div>
        </>
      )}
    </dialog>
  );
}

/** While searching, the tabs stay where they were, dimmed. */
function sectionsFor(data: EmojiData | null, recent: string[]): Section[] {
  if (!data) return [];
  return [...(recent.some((k) => data.byKey.has(k)) ? (['recent'] as Section[]) : []), ...GROUPS];
}
