// B11 server settings (spec docs/ux/specs/B11-server-settings.md): one screen
// for the owner, opened from the gear by the server name, the server's menu in
// the rail, or the channel list. Only what the core API supports today is here:
// the name (rename, #261), channels, the invite link, members and the danger
// zone (close the server, #261). Changing the age limit and removed accounts
// wait for their core commands.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useCore, useCoreEvent, type Channel, type Invite, type Member, type ServerSummary } from '../../core';
import { Avatar, Dialog, InviteBox, Name } from '../../components/common';
import { GearIcon, HashIcon, PlusIcon } from '../../components/icons';
import { displayName, ProfileCard } from './MemberList';
import { ClosePanel, RenameForm } from './ServerLifecycle';
import { AgeLimitSetting } from './AgeLimit';
import { ServerMetaForm } from './ServerMeta';
import type { SectionHandle, SectionState } from './generalDraft';
import { RemovedAccounts } from './RemovedAccounts';
import { ReportsPage } from './Reports';
import { useOpenReports } from './reportsState';
import { useReadOnlyProps } from './UpdateRequired';

export type ServerSettingsPage = 'general' | 'channels' | 'invite' | 'members' | 'removed' | 'reports' | 'danger';
const PAGES: ServerSettingsPage[] = ['general', 'channels', 'invite', 'members', 'removed', 'reports', 'danger'];

const NO_CHANNELS: Channel[] = [];
const NO_MEMBERS: Member[] = [];

export function ServerSettings({
  server,
  open,
  onClose,
  onCreateChannel,
  onEditChannel,
}: {
  server: ServerSummary;
  open: boolean;
  onClose: () => void;
  onCreateChannel: () => void;
  onEditChannel: (channel: Channel) => void;
}) {
  const intl = useIntl();
  const [page, setPage] = useState<ServerSettingsPage>('general');
  // G-48: open reports here, for the Reports tab.
  const openReports = useOpenReports()[server.id] ?? 0;
  const navRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Every opening starts on "General", with focus on the chosen tab.
  useEffect(() => {
    if (!open) return;
    setPage('general');
    moved.current = false;
    navRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [open]);

  // After a page switch, focus goes to the page's heading.
  useEffect(() => {
    if (moved.current) headingRef.current?.focus();
  }, [page]);

  const choose = (p: ServerSettingsPage) => {
    moved.current = true;
    setPage(p);
  };

  // G-51n: a draft on General is asked about before leaving it (as profile save, B11e).
  const general = useRef<GeneralHandle>(null);
  const [generalDirty, setGeneralDirty] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const guard = (action: () => void) => (generalDirty && page === 'general' ? setLeaving(() => action) : action());
  const leave = () => {
    const go = leaving;
    setLeaving(null);
    setGeneralDirty(false);
    go?.();
  };

  const onNavKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const tabs = [...(navRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    tabs[(i + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length]?.focus();
  };

  return (
    <Dialog
      open={open}
      onClose={() => guard(onClose)}
      className="settings-dialog server-settings"
      title={
        <span className="server-settings-title" title={server.name}>
          <span className="server-settings-icon" style={{ background: server.color }} aria-hidden="true">
            {server.iconDataUrl ? <img src={server.iconDataUrl} alt="" /> : <bdi>{server.initials}</bdi>}
          </span>
          <Name>{server.name}</Name>
        </span>
      }
    >
      <div className="settings">
        <div
          ref={navRef}
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={intl.formatMessage({ id: 'server.settings.open' })}
          onKeyDown={onNavKey}
        >
          <ul role="presentation">
            {PAGES.map((p) => (
              <li key={p} role="presentation">
                <button
                  type="button"
                  role="tab"
                  id={`server-tab-${p}`}
                  aria-selected={page === p}
                  aria-controls="server-settings-panel"
                  tabIndex={page === p ? 0 : -1}
                  className={[page === p ? 'active' : '', p === 'danger' ? 'danger-tab' : ''].filter(Boolean).join(' ')}
                  onClick={() => p !== page && guard(() => choose(p))}
                >
                  <FormattedMessage id={`server.settings.nav.${p}`} />
                  {p === 'general' && generalDirty && (
                    <span className="nav-dirty" role="img" aria-label={intl.formatMessage({ id: 'profile.edit.unsaved' })} />
                  )}
                  {p === 'reports' && openReports > 0 && (
                    // The tab keeps its name; the rail button's label says the count in words.
                    <span className="badge settings-count" aria-hidden="true">
                      {openReports}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <section id="server-settings-panel" className="settings-panel" role="tabpanel" aria-labelledby={`server-tab-${page}`}>
          <h3 ref={headingRef} tabIndex={-1}>
            <FormattedMessage id={`server.settings.nav.${page}`} />
          </h3>
          {page === 'general' && <GeneralPage ref={general} server={server} onDirtyChange={setGeneralDirty} />}
          {page === 'channels' && <ChannelsPage server={server} onCreate={onCreateChannel} onEdit={onEditChannel} />}
          {page === 'invite' && <InvitePage server={server} onOpenRemoved={() => choose('removed')} />}
          {page === 'members' && <MembersPage server={server} />}
          {page === 'removed' && <RemovedAccounts server={server} />}
          {page === 'reports' && <ReportsPage server={server} />}
          {page === 'danger' && <ClosePanel server={server} />}
        </section>
      </div>
      <Dialog open={!!leaving} onClose={() => setLeaving(null)} title={intl.formatMessage({ id: 'server.settings.unsavedTitle' })}>
        <div className="actions">
          <button
            type="button"
            className="primary"
            autoFocus
            onClick={async () => {
              if (await general.current?.save()) leave();
              else setLeaving(null); // the reason shows on the page
            }}
          >
            <FormattedMessage id="server.settings.save" />
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              general.current?.discard();
              leave();
            }}
          >
            <FormattedMessage id="profile.edit.unsavedDiscard" />
          </button>
          <button type="button" className="link" onClick={() => setLeaving(null)}>
            <FormattedMessage id="profile.edit.unsavedBack" />
          </button>
        </div>
      </Dialog>
    </Dialog>
  );
}

type GeneralHandle = { save(): Promise<boolean>; discard(): void };
type Section = 'name' | 'meta' | 'age';
const CLEAN: SectionState = { dirty: false, invalid: false };

/**
 * G-51n (server-icon-description.md §1): one "Save" for General. Every change
 * is a draft until then; the save bar is sticky while there's one. The age
 * limit's confirmation comes first, and cancelling it saves nothing.
 */
const GeneralPage = forwardRef<GeneralHandle, { server: ServerSummary; onDirtyChange: (dirty: boolean) => void }>(function GeneralPage(
  { server, onDirtyChange },
  ref,
) {
  const ro = useReadOnlyProps();
  const name = useRef<SectionHandle>(null);
  const meta = useRef<SectionHandle>(null);
  const age = useRef<SectionHandle>(null);
  const [states, setStates] = useState<Record<Section, SectionState>>({ name: CLEAN, meta: CLEAN, age: CLEAN });
  const track = (k: Section) => (st: SectionState) =>
    setStates((prev) => (prev[k].dirty === st.dirty && prev[k].invalid === st.invalid ? prev : { ...prev, [k]: st }));
  const onName = useCallback(track('name'), []);
  const onMeta = useCallback(track('meta'), []);
  const onAge = useCallback(track('age'), []);
  const dirty = states.name.dirty || states.meta.dirty || states.age.dirty;
  const invalid = states.name.invalid || states.meta.invalid;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (dirty) setSaved(false);
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    if (busy || invalid) return false;
    if (!(await (age.current?.confirm?.() ?? Promise.resolve(true)))) return false;
    setBusy(true);
    // Each section saves and shows its own error; one failing doesn't stop the others.
    const results = [];
    for (const s of [name, meta, age]) results.push(await (s.current?.save() ?? Promise.resolve(true)));
    setBusy(false);
    const ok = results.every(Boolean);
    if (ok) setSaved(true);
    return ok;
  };
  const discard = () => [name, meta, age].forEach((s) => s.current?.discard());
  useImperativeHandle(ref, () => ({ save, discard }));

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) void save();
      }}
    >
      <RenameForm ref={name} server={server} onState={onName} />
      <ServerMetaForm ref={meta} server={server} onState={onMeta} />
      <AgeLimitSetting ref={age} server={server} onState={onAge} />
      <div className={`profile-actions general-actions ${dirty ? 'dirty' : ''}`}>
        <div className="actions">
          {saved && !dirty && (
            <span className="success small" role="status">
              <FormattedMessage id="server.settings.saved" />
            </span>
          )}
          <span className="spacer" />
          {dirty && (
            <button type="button" className="secondary" disabled={busy} onClick={discard}>
              <FormattedMessage id="server.settings.discard" />
            </button>
          )}
          <button type="submit" className="primary" disabled={!dirty || busy || invalid} {...ro}>
            <FormattedMessage id={busy ? 'server.settings.saving' : 'server.settings.save'} />
          </button>
        </div>
      </div>
    </form>
  );
});

function ChannelsPage({ server, onCreate, onEdit }: { server: ServerSummary; onCreate: () => void; onEdit: (c: Channel) => void }) {
  const store = useAppStore();
  const channels = useStore(store, (s) => s.channels[server.id] ?? NO_CHANNELS);
  const intl = useIntl();
  const ro = useReadOnlyProps();
  return (
    <div className="stack">
      <div>
        <button type="button" className="secondary small" onClick={onCreate} {...ro}>
          <PlusIcon /> <FormattedMessage id="channel.create" />
        </button>
      </div>
      <ul className="settings-list">
        {channels.map((c) => (
          <li key={c.id}>
            <HashIcon />
            <bdi className="grow">{c.name}</bdi>
            {c.adult && (
              <span className="adult-tag">
                18+
              </span>
            )}
            <button
              type="button"
              className="icon-button small"
              onClick={() => onEdit(c)}
              aria-label={`${intl.formatMessage({ id: 'channel.edit' })}: ${c.name}`}
              title={intl.formatMessage({ id: 'channel.edit' })}
            >
              <GearIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MembersPage({ server }: { server: ServerSummary }) {
  const store = useAppStore();
  const members = useStore(store, (s) => s.members[server.id] ?? NO_MEMBERS);
  const myId = useStore(store, (s) => s.identity?.id);
  const [kick, setKick] = useState<Member | null>(null);
  const ro = useReadOnlyProps();
  return (
    <>
      <ul className="settings-list">
        {members.map((m) => (
          <li key={m.id}>
            <Avatar name={displayName(m)} color={m.color ?? m.avatarColor} src={m.avatarDataUrl} size={32} presence={m.presence} />
            <Name className="name grow">{displayName(m)}</Name>
            {m.isOwner && (
              <span className="owner-tag">
                <FormattedMessage id="members.owner" />
              </span>
            )}
            {m.id !== myId && !m.isOwner && (
              <button type="button" className="danger small" onClick={() => setKick(m)} {...ro}>
                <FormattedMessage id="profile.kick" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {kick && <ProfileCard member={kick} server={server} isMe={false} startKick onClose={() => setKick(null)} />}
    </>
  );
}

const HOUR = 3_600_000;
const EXPIRY = { never: 0, hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR } as const;
type Expiry = keyof typeof EXPIRY;
const MAX_USES = [0, 1, 5, 10, 25, 100];

// Invites (#214): the current link, making a new one with an expiry and a use
// limit, and the list of links with Revoke. The core sends server.updated after
// a create or a revoke, and the list is read again then.
function InvitePage({ server, onOpenRemoved }: { server: ServerSummary; onOpenRemoved: () => void }) {
  const core = useCore();
  const intl = useIntl();
  const ro = useReadOnlyProps();
  const members = useStore(useAppStore(), (s) => s.members[server.id] ?? NO_MEMBERS);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [expiry, setExpiry] = useState<Expiry>('never');
  const [maxUses, setMaxUses] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = () =>
    core.listInvites(server.id).then(setInvites, () => {
      setInvites([]);
      setFailed(true);
    });
  useEffect(() => {
    void load();
  }, [server.id]);
  useCoreEvent('server.updated', (s) => {
    if (s.id === server.id) void load();
  }, [server.id]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
    await load();
  };

  const create = () =>
    run(() =>
      core.createInvite(server.id, {
        ...(expiry !== 'never' ? { expiresMs: Date.now() + EXPIRY[expiry] } : {}),
        ...(maxUses ? { maxUses } : {}),
      }),
    );

  const now = Date.now();
  const status = (i: Invite) =>
    i.revoked ? 'revoked' : i.expiresAt !== undefined && i.expiresAt <= now ? 'expired' : i.maxUses && i.uses >= i.maxUses ? 'usedUp' : null;
  const author = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? displayName(m) : '…';
  };

  return (
    <div className="stack">
      <h4>
        <FormattedMessage id="invite.current" />
      </h4>
      {server.inviteLink ? (
        <InviteBox link={server.inviteLink} />
      ) : (
        <p className="muted small">
          <FormattedMessage id="invite.none" />
        </p>
      )}
      {/* G-53: a removed account can't come back with the link. */}
      <p className="muted small">
        <FormattedMessage id="invite.removedHint" />{' '}
        <button type="button" className="link" onClick={onOpenRemoved}>
          <FormattedMessage id="invite.removedHintLink" />
        </button>
      </p>

      <h4>
        <FormattedMessage id="invite.create" />
      </h4>
      <div className="invite-form">
        <label className="field">
          <span>
            <FormattedMessage id="invite.expires" />
          </span>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
            {(Object.keys(EXPIRY) as Expiry[]).map((k) => (
              <option key={k} value={k}>
                {intl.formatMessage({ id: `invite.expires.${k}` })}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            <FormattedMessage id="invite.maxUses" />
          </span>
          <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {MAX_USES.map((n) => (
              <option key={n} value={n}>
                {n ? intl.formatNumber(n) : intl.formatMessage({ id: 'invite.maxUses.unlimited' })}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void create()} {...ro}>
          <FormattedMessage id="invite.createButton" />
        </button>
      </div>
      {failed && (
        <p className="error small" role="alert">
          <FormattedMessage id="invite.failed" />
        </p>
      )}

      <h4>
        <FormattedMessage id="invite.list" />
      </h4>
      {invites === null ? (
        <p className="muted small">
          <FormattedMessage id="common.loading" />
        </p>
      ) : (
        <ul className="settings-list invite-list">
          {[...invites].reverse().map((i) => {
            const st = status(i);
            return (
              <li key={i.id} className={st ? 'inactive' : undefined}>
                <div className="grow">
                  <div>
                    <FormattedMessage id="invite.by" values={{ name: author(i.createdBy) }} />
                  </div>
                  <div className="muted small">
                    {i.maxUses ? (
                      <FormattedMessage id="invite.usesOf" values={{ count: i.uses, max: i.maxUses }} />
                    ) : (
                      <FormattedMessage id="invite.uses" values={{ count: i.uses }} />
                    )}
                    {' · '}
                    {i.expiresAt === undefined ? (
                      <FormattedMessage id="invite.neverExpires" />
                    ) : (
                      <>
                        <FormattedMessage id="invite.expiresOn" />{' '}
                        {intl.formatDate(i.expiresAt, { dateStyle: 'medium', timeStyle: 'short' })}
                      </>
                    )}
                  </div>
                </div>
                {st ? (
                  <span className="muted small">
                    <FormattedMessage id={`invite.status.${st}`} />
                  </span>
                ) : confirm === i.id ? (
                  <span className="invite-confirm" role="group" aria-label={intl.formatMessage({ id: 'invite.revokeConfirm' })}>
                    <button type="button" className="danger small" autoFocus disabled={busy} onClick={() => void run(() => core.revokeInvite(server.id, i.id)).then(() => setConfirm(null))}>
                      <FormattedMessage id="invite.revoke" />
                    </button>
                    <button type="button" className="secondary small" onClick={() => setConfirm(null)}>
                      <FormattedMessage id="common.cancel" />
                    </button>
                  </span>
                ) : (
                  <button type="button" className="secondary small" onClick={() => setConfirm(i.id)} {...ro}>
                    <FormattedMessage id="invite.revoke" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
