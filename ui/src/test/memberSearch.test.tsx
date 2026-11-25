// G-41: member search (docs/ux/specs/blocked-and-member-search.md §2).

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { memberMatcher, SEARCH_FROM } from '../screens/shell/memberMatch';

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };
const m = (displayName: string, shortCode = 'ZZZZ-ZZZZ') => ({ displayName, shortCode });

describe('G-41: the matcher', () => {
  it('matches the start of the name or of any word in it', () => {
    const match = memberMatcher('ta');
    expect(match(m('Tal'))).toBe(true);
    expect(match(m('Tamar'))).toBe(true);
    expect(match(m('Ben Tal'))).toBe(true);
    expect(match(m('Itamar'))).toBe(false);
    expect(match(m('Dana'))).toBe(false);
  });

  it('ignores case, niqqud and look-alike letters', () => {
    expect(memberMatcher('admin')(m('Αdmin'))).toBe(true); // Greek Alpha
    expect(memberMatcher('TAL')(m('tal'))).toBe(true);
    expect(memberMatcher('שק')(m('שָׁקֵד'))).toBe(true);
  });

  it('matches the start of the short code, with or without the dash', () => {
    const who = m('Someone', 'Q2FJ-TWQ9');
    expect(memberMatcher('q2f')(who)).toBe(true);
    expect(memberMatcher('Q2FJ-TW')(who)).toBe(true);
    expect(memberMatcher('q2fjtw')(who)).toBe(true);
    expect(memberMatcher('TWQ9')(who)).toBe(false);
  });

  it('an empty query matches everyone', () => {
    expect(memberMatcher('  ')(m('Anyone'))).toBe(true);
  });
});

const list = () => screen.getByRole('complementary', { name: 'Server members' });
const field = () => within(list()).getByRole('searchbox', { name: 'Search members' }) as HTMLInputElement;
const shownIds = () => within(list()).queryAllByRole('button', { name: /'s profile/ }).length;

/**
 * Start the app and wait until it has settled (TL on #559/#560): the member
 * list shows every member of the open server, the field is there and enabled,
 * and React's pending work is flushed. Tests then type once; they never retype.
 */
async function setup() {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  const server = (await core.listServers())[0]!;
  const members = await core.listMembers(server.id);
  await waitFor(() => {
    expect(shownIds()).toBe(members.length);
    expect(field().disabled).toBe(false);
  });
  await act(async () => {});
  return { core, server, members };
}
const type = (value: string) =>
  act(async () => {
    fireEvent.change(field(), { target: { value } });
  });

describe('G-41: the member list search', () => {
  it(`is there from ${SEARCH_FROM} members; filters live, keeps the groups with filtered counts`, async () => {
    const { members } = await setup();
    expect(members.length).toBeGreaterThanOrEqual(SEARCH_FROM);
    // UX on #492: the query's own direction.
    expect(field().getAttribute('dir')).toBe('auto');
    const target = members.find((x) => x.displayName && x.presence === 'offline')!;
    const q = target.displayName.slice(0, 2);
    const expected = members.filter(memberMatcher(q));
    await type(q);
    expect(field().value).toBe(q);
    expect(shownIds()).toBe(expected.length);
    const offline = expected.filter((x) => x.presence === 'offline').length;
    expect(within(list()).getByRole('heading', { name: `Offline – ${offline}` })).toBeTruthy();
    if (!expected.some((x) => x.presence === 'online')) expect(within(list()).queryByRole('heading', { name: /^Online/ })).toBeNull();
    // The count is read out once typing stops.
    await waitFor(() =>
      expect(within(list()).getByRole('status').textContent).toBe(expected.length === 1 ? '1 result' : `${expected.length} results`),
    );
  });

  it('no match: says so, with "Clear search"; the ✕ clears too', async () => {
    const { members } = await setup();
    await type('qqqqqq');
    expect(field().value).toBe('qqqqqq');
    expect(shownIds()).toBe(0);
    expect(within(list()).getByText(/No members match\./)).toBeTruthy();
    const clears = within(list()).getAllByRole('button', { name: 'Clear search' });
    expect(clears).toHaveLength(2); // the ✕ and the link
    await act(async () => {
      fireEvent.click(clears[1]!);
    });
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(shownIds()).toBe(members.length);
  });

  it('Esc clears first, then leaves the field', async () => {
    await setup();
    field().focus();
    await type('ta');
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Escape' });
    });
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Escape' });
    });
    expect(document.activeElement).not.toBe(field());
  });

  it('switching server clears it; a server under 15 members has no field', async () => {
    const { core } = await setup();
    await type('ta');
    const servers = await core.listServers();
    const small = [];
    for (const s of servers) if ((await core.listMembers(s.id)).length < SEARCH_FROM) small.push(s);
    const other = servers[1]!;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${other.name}`) }));
    });
    await waitFor(() => expect(within(list()).queryByText('No members match.')).toBeNull());
    const now = within(list()).queryByRole('searchbox');
    if (small.some((s) => s.id === other.id)) expect(now).toBeNull();
    else expect((now as HTMLInputElement).value).toBe('');
  });

  it('Ctrl+Shift+M focuses the search, opening the list if hidden', async () => {
    await setup();
    // Hide the list, then the shortcut brings it back with focus in the field.
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('.members-button')!);
    });
    expect(screen.queryByRole('complementary', { name: 'Server members' })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(document.activeElement).toBe(field()));
    // Open already: it just focuses.
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'מ', code: 'KeyM', ctrlKey: true, shiftKey: true });
    });
    expect(document.activeElement).toBe(field());
  });
});
