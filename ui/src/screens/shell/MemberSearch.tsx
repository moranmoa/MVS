import { useEffect, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { CloseIcon } from '../../components/icons';
import { COUNT_DELAY_MS } from './memberMatch';
import './memberSearch.css';

/** G-41: the element id Ctrl+Shift+M focuses. */
export const MEMBER_SEARCH_ID = 'member-search';

/**
 * G-41: the member list's search field (servers of 15+ members). Filters as
 * you type; the result count is read out politely once typing stops. Esc
 * clears first, then leaves the field.
 */
export function MemberSearchField({
  query,
  onQuery,
  results,
  listId,
}: {
  query: string;
  onQuery: (q: string) => void;
  results: number;
  listId: string;
}) {
  const intl = useIntl();
  // The count is announced after typing stops, not on every key.
  const [said, setSaid] = useState<number | null>(null);
  useEffect(() => {
    if (!query.trim()) {
      setSaid(null);
      return;
    }
    const t = setTimeout(() => setSaid(results), COUNT_DELAY_MS);
    return () => clearTimeout(t);
  }, [query, results]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    // Kept here: on a phone, Esc would otherwise close the whole list.
    e.preventDefault();
    e.stopPropagation();
    if (query) onQuery('');
    else e.currentTarget.blur();
  };

  return (
    <div className="member-search">
      <div className="member-search-box">
        <input
          id={MEMBER_SEARCH_ID}
          type="search"
          className="member-search-input"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={intl.formatMessage({ id: 'members.search.placeholder' })}
          aria-label={intl.formatMessage({ id: 'members.search' })}
          aria-controls={listId}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
        />
        {query && (
          <button
            type="button"
            className="icon-button member-search-clear"
            aria-label={intl.formatMessage({ id: 'members.search.clear' })}
            title={intl.formatMessage({ id: 'members.search.clear' })}
            onClick={() => {
              onQuery('');
              document.getElementById(MEMBER_SEARCH_ID)?.focus();
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      {/* Only while searching (an empty region from the first key, the count 300 ms after typing stops). */}
      {query.trim() && (
        <p role="status" className="visually-hidden">
          {said !== null && <FormattedMessage id="members.search.count" values={{ count: said }} />}
        </p>
      )}
      {query.trim() && results === 0 && (
        <p className="muted small member-search-none">
          <FormattedMessage id="members.search.none" />{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              onQuery('');
              document.getElementById(MEMBER_SEARCH_ID)?.focus();
            }}
          >
            <FormattedMessage id="members.search.clear" />
          </button>
        </p>
      )}
    </div>
  );
}
