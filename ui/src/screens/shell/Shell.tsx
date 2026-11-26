import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { useUnreadBadge } from '../../app/unreadBadge';
import { phoneQuery, useMediaQuery } from '../../app/media';
import { sortByOrder } from '../../app/serverOrder';
import { useSettings } from '../../app/settings';
import { paragraphs, useUiDir } from '../../app/textDir';
import { isCoreError, useCore, useCoreEvent, type Id, type JoinStatus } from '../../core';
import { Dialog } from '../../components/common';
import { AlertIcon, CloseIcon, RefreshIcon, ShieldIcon } from '../../components/icons';
import { RecoveryCheck, RecoveryWordsPanel } from '../onboarding/RecoveryWords';
import { SettingsScreen } from '../settings/SettingsScreen';
import { MemberRelayFirstRun } from '../settings/MemberRelay';
import { DeviceNotices } from './DeviceNotice';
import { ChannelDialog, type ChannelDialogMode } from './ChannelDialog';
import { ChannelSidebar } from './ChannelSidebar';
import { ChatView } from './ChatView';
import { CreateServerDialog, Home, JoinDialog } from './Home';
import { MemberList } from './MemberList';
import { OPEN_REPORTS, useReportNotifications } from './reportsState';
import { ReportsDialog } from './Reports';
import { MEMBER_SEARCH_ID } from './MemberSearch';
import { ServerRail } from './ServerRail';
import { ServerSettings } from './ServerSettings';
import { LeaveServerDialog } from './ServerLifecycle';
import { useDesktopNotifications } from './useNotifications';
import { useWindowTitle } from '../../app/TitleBar';

const MEMBERS_KEY = 'mvp.ui.membersOpen';

export type ShellDialog = 'create' | 'join' | 'check' | null;

export function Shell() {
  const store = useAppStore();
  // G-62: the unread count on the app icon.
  useUnreadBadge(store);
  const core = useCore();
  const identity = useStore(store, (s) => s.identity)!;
  const servers = useStore(store, (s) => s.servers);
  const notice = useStore(store, (s) => s.notice);
  const updateNote = useStore(store, (s) => s.updateNote);
  const callEndedForUpdate = useStore(store, (s) => s.callEndedForUpdate);
  const staged = useStore(store, (s) => s.update);
  const flash = useStore(store, (s) => s.flash);
  const settingsRequest = useStore(store, (s) => s.settingsRequest);
  const serverGone = useStore(store, (s) => s.serverGone);
  const uiDir = useUiDir();
  const intl = useIntl();
  const { uiScale, serverOrder = [] } = useSettings().settings;

  const [serverId, setServerId] = useState<Id | 'home'>(() => servers[0]?.id ?? 'home');
  const [channelByServer, setChannelByServer] = useState<Record<Id, Id>>({});
  const [membersOpen, setMembersOpen] = useState(() => {
    const stored = localStorage.getItem(MEMBERS_KEY);
    // Open by default only when there is room for it at the current UI scale.
    return stored === null ? window.innerWidth / uiScale >= 1000 : stored === '1';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<ShellDialog>(null);
  // An mvs:// link from the OS (desktop app) opens the join dialog pre-filled.
  // It never joins by itself: that waits for the Join button.
  const [invite, setInvite] = useState<string | undefined>();
  // G-92: a link pasted on Home whose join already started there.
  const [inviteStatus, setInviteStatus] = useState<JoinStatus | null>(null);
  // The open dialog as of now, not as of the last render: the subscription
  // below is made once, and a second link can arrive before React re-renders.
  const dialogNow = useRef(dialog);
  dialogNow.current = dialog;
  useCoreEvent('link.open', ({ link }) => {
    if (!link) return; // guardCore blanks anything that isn't an exact invite link
    // While the join dialog is open, a new link must not replace the one the
    // person is looking at just before they press Join (security review of #80).
    if (dialogNow.current === 'join') return;
    dialogNow.current = 'join';
    setInvite(link);
    setInviteStatus(null);
    setDialog('join');
  });
  // The reminder can show the words again (the panel loads them on demand).
  const [showWords, setShowWords] = useState(false);
  const closeCheck = () => {
    setShowWords(false);
    setDialog(null);
  };
  // On a phone the channel list and the chat are two pages; this is the one shown.
  const phone = useMediaQuery(phoneQuery(uiScale));
  const [phoneView, setPhoneView] = useState<'nav' | 'chat'>('nav');
  // The phone member sheet has its own state: it is never saved, and every
  // page switch closes it, so a channel tap always lands on the chat.
  const [phoneMembers, setPhoneMembers] = useState(false);
  // Where focus goes after a phone page switch or after the sheet closes.
  const focusNext = useRef<'chat' | 'channel' | 'members-button' | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const channels = useStore(store, (s) => (serverId === 'home' ? undefined : s.channels[serverId]));
  // A channel that was deleted (or never chosen) falls back to the server's default one.
  const chosen = serverId === 'home' ? undefined : channelByServer[serverId];
  const channelId =
    serverId === 'home'
      ? undefined
      : channels?.some((c) => c.id === chosen)
        ? chosen
        : (channels?.find((c) => c.isDefault) ?? channels?.[0])?.id;
  // B11c: the owner's channel dialog, and a notice when the open channel is deleted.
  const [channelDialog, setChannelDialog] = useState<ChannelDialogMode | null>(null);
  // B11: the owner's server settings screen, for the open server.
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  // #261: the server whose leave confirmation is open.
  const [leaving, setLeaving] = useState<Id | null>(null);
  const [channelGone, setChannelGone] = useState<string | null>(null);
  const openChannel = useRef(channelId);
  openChannel.current = channelId;
  useCoreEvent('channel.removed', ({ channelId: gone, name }) => {
    if (gone === openChannel.current) setChannelGone(name);
  });
  useEffect(() => {
    if (!channelGone) return;
    const t = setTimeout(() => setChannelGone(null), 6000);
    return () => clearTimeout(t);
  }, [channelGone]);
  const server = servers.find((s) => s.id === serverId);
  // The title bar shows the open server's name (desktop app).
  useWindowTitle(server?.name);

  useEffect(() => {
    if (serverId !== 'home' && !servers.some((s) => s.id === serverId)) setServerId(servers[0]?.id ?? 'home');
  }, [servers, serverId]);

  useEffect(() => {
    if (!serverGone) return;
    const t = setTimeout(() => store.clearServerGone(), 6000);
    return () => clearTimeout(t);
  }, [serverGone, store]);

  useEffect(() => {
    if (settingsRequest) setSettingsOpen(true);
  }, [settingsRequest]);

  // B18: joins left to the background. A final answer comes as a toast, so a
  // removed account (or a closed server) is told why instead of nothing happening.
  const backgroundJoins = useRef(new Set<string>());
  useCoreEvent('join.status', (s) => {
    if (!backgroundJoins.current.has(s.link) || s.phase === 'searching' || s.phase === 'nobody-online') return;
    backgroundJoins.current.delete(s.link);
    if (s.phase === 'removed') store.showFlash('join.removed');
    else if (s.phase === 'closed') store.showFlash('join.closed');
    else if (s.phase === 'age-blocked') store.showFlash('join.ageBlocked', { age: s.required.slice(0, 2) });
    else if (s.phase === 'invalid') store.showFlash('join.invalid');
    // joined: the server appears in the rail (server.added).
  });

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => store.clearFlash(), 3000);
    return () => clearTimeout(t);
  }, [flash, store]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => store.clearNotice(), 6000);
    return () => clearTimeout(t);
  }, [notice, store]);

  // #622: "your call ended for the update" shows for 8 s.
  useEffect(() => {
    if (!callEndedForUpdate) return;
    const t = setTimeout(() => store.clearCallEndedForUpdate(), 8000);
    return () => clearTimeout(t);
  }, [callEndedForUpdate, store]);

  // Update notes stay until closed when there are release notes to read.
  useEffect(() => {
    if (!updateNote || (updateNote.kind === 'installed' && updateNote.notes)) return;
    const t = setTimeout(() => store.clearUpdateNote(), 6000);
    return () => clearTimeout(t);
  }, [updateNote, store]);

  // Alt+Up / Alt+Down move between channels, Ctrl+Alt+Up / Down between servers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+Shift+arrows move a server in the rail (G-01), handled there.
      if (!e.altKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      e.preventDefault();
      if (e.ctrlKey) {
        const ids: (Id | 'home')[] = ['home', ...sortByOrder(servers, serverOrder).map((s) => s.id)];
        const next = ids[(ids.indexOf(serverId) + dir + ids.length) % ids.length];
        setServerId(next);
      } else if (server && channels?.length && channelId) {
        const i = channels.findIndex((c) => c.id === channelId);
        const next = channels[(i + dir + channels.length) % channels.length];
        setChannelByServer((m) => ({ ...m, [server.id]: next.id }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [servers, serverOrder, serverId, server, channels, channelId]);

  const toggleMembers = () => {
    if (phone) {
      if (phoneMembers) focusNext.current = 'members-button';
      setPhoneMembers((o) => !o);
      return;
    }
    setMembersOpen((o) => {
      localStorage.setItem(MEMBERS_KEY, o ? '0' : '1');
      return !o;
    });
  };

  const goPhone = (view: 'nav' | 'chat') => {
    setPhoneMembers(false);
    setPhoneView(view);
    if (phone) focusNext.current = view === 'chat' ? 'chat' : 'channel';
  };
  const selectServer = (id: Id | 'home') => {
    setServerId(id);
    setPhoneMembers(false);
    setPhoneView('nav');
  };
  // G-30: an mvs://m/… link (main parsed it strictly). It only navigates: the
  // right server and channel, then the message list scrolls and highlights.
  const [linkNotMember, setLinkNotMember] = useState(false);
  const linkSeq = useRef(0);
  useCoreEvent('link.message', ({ serverId: sid, channelId: cid, messageId }) => {
    // Never over the join dialog (the same rule as invites, #80).
    if (dialogNow.current === 'join') return;
    const seq = ++linkSeq.current;
    // Not in my server list: the one case the UI tells apart, from its own data.
    if (!store.getState().servers.some((s) => s.id === sid)) return setLinkNotMember(true);
    /** The index is a snapshot (a sync can shift it): check the id there, and locate once more if it moved. */
    const locate = async (): Promise<number | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { index } = await core.locateMessage(sid, cid, messageId);
        const range = await core.getMessages(cid, index, index + 1);
        if (range.messages[0]?.id === messageId) return index;
      }
      return null;
    };
    const open = (index: number | null) => {
      if (seq !== linkSeq.current) return; // a newer link won
      setSettingsOpen(false);
      setServerId(sid);
      // Not found looks the same whether the channel is hidden from me or doesn't
      // exist (SL R1): only a channel in my list opens.
      const known = (store.getState().channels[sid] ?? []).some((c) => c.id === cid);
      if (index !== null || known) {
        setChannelByServer((m) => ({ ...m, [sid]: cid }));
        goPhone('chat');
      }
      if (index !== null) store.goToMessage(cid, index);
      else store.showFlash('msglink.notFound');
    };
    // Every error is "not found": the core answers the same for all I can't see.
    locate().then(open, () => open(null));
  });
  // G-61: a click on a desktop notification opens its channel.
  // G-48: a report that reaches me as staff (no reason or content in it).
  useReportNotifications();
  // G-48 (TL on #531): Reports for staff, admins included (they have no settings gear).
  const [reportsFor, setReportsFor] = useState<Id | null>(null);
  useEffect(() => {
    const open = (e: Event) => setReportsFor((e as CustomEvent<Id>).detail);
    window.addEventListener(OPEN_REPORTS, open);
    return () => window.removeEventListener(OPEN_REPORTS, open);
  }, []);
  const reportsServer = reportsFor ? servers.find((s) => s.id === reportsFor) : undefined;
  useDesktopNotifications(settingsOpen || (phone && phoneView === 'nav') ? null : (channelId ?? null), (sid, cid) => {
    setSettingsOpen(false);
    setServerId(sid);
    setChannelByServer((m) => ({ ...m, [sid]: cid }));
    goPhone('chat');
  });
  const sheetOpen = phone && phoneMembers && phoneView === 'chat';
  const showMembers = !!server && (phone ? sheetOpen : membersOpen);

  // G-41: Ctrl+Shift+M opens the member list if it is hidden and focuses its search
  // (servers of 15+ members have one). By key position, so any keyboard layout works.
  const searchAfterOpen = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== 'KeyM' || !server) return;
      e.preventDefault();
      const field = document.getElementById(MEMBER_SEARCH_ID);
      if (showMembers && field) field.focus();
      else if (!showMembers) {
        searchAfterOpen.current = true;
        if (phone) goPhone('chat');
        toggleMembers();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!showMembers || !searchAfterOpen.current) return;
    searchAfterOpen.current = false;
    document.getElementById(MEMBER_SEARCH_ID)?.focus();
  }, [showMembers]);

  // Keyboard and screen-reader users keep their place when the phone pages switch:
  // the chat heading after opening a channel, the open channel after going back,
  // and the members button after the sheet closes.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const root = shellRef.current;
    const el =
      target === 'chat'
        ? root?.querySelector<HTMLElement>('.chat-title')
        : target === 'channel'
          ? root?.querySelector<HTMLElement>('.channel[aria-current="page"]')
          : root?.querySelector<HTMLElement>('.members-button');
    el?.focus();
  });

  // While the sheet covers the screen, everything under it is inert.
  useEffect(() => {
    const root = shellRef.current;
    if (!root || !sheetOpen) return;
    const under = [...root.children].filter((el) => !el.classList.contains('members')) as HTMLElement[];
    under.forEach((el) => (el.inert = true));
    return () => under.forEach((el) => (el.inert = false));
  }, [sheetOpen]);
  const layout = [
    'shell',
    showMembers ? 'with-members' : '',
    server ? '' : 'no-sidebar',
    phone && server ? `phone phone-${phoneView}` : '',
  ];

  return (
    <div ref={shellRef} className={layout.filter(Boolean).join(' ')}>
      {!(phone && server && phoneView === 'nav') && (
        <a className="skip-link" href="#chat-main">
          <FormattedMessage id="a11y.skipToChat" />
        </a>
      )}
      {!identity.recoveryChecked && (
        <div className="banner" role="status">
          <ShieldIcon />
          <span>
            <FormattedMessage id="banner.recovery" />
          </span>
          <button type="button" className="secondary small" onClick={() => setDialog('check')}>
            <FormattedMessage id="banner.recovery.action" />
          </button>
        </div>
      )}
      <ServerRail
        selected={serverId}
        onSelect={selectServer}
        onAdd={() => selectServer('home')}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenServerSettings={(id) => {
          selectServer(id);
          setServerSettingsOpen(true);
        }}
        onLeaveServer={setLeaving}
      />
      <LeaveServerDialog server={servers.find((s) => s.id === leaving) ?? null} onClose={() => setLeaving(null)} />
      {server && channelId && (
        <ChannelSidebar
          server={server}
          channelId={channelId}
          onSelectChannel={(id) => {
            setChannelByServer((m) => ({ ...m, [server.id]: id }));
            goPhone('chat');
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateChannel={() => setChannelDialog({ kind: 'create', serverId: server.id })}
          onEditChannel={(channel) => setChannelDialog({ kind: 'edit', channel })}
          onDeleteChannel={(channel) => setChannelDialog({ kind: 'edit', channel, startDelete: true })}
          onOpenServerSettings={() => setServerSettingsOpen(true)}
        />
      )}
      {server && server.ownerId === identity.id && !server.closed && (
        <ServerSettings
          server={server}
          open={serverSettingsOpen}
          onClose={() => setServerSettingsOpen(false)}
          onCreateChannel={() => setChannelDialog({ kind: 'create', serverId: server.id })}
          onEditChannel={(channel) => setChannelDialog({ kind: 'edit', channel })}
        />
      )}
      <ChannelDialog
        mode={channelDialog}
        onClose={() => setChannelDialog(null)}
        onCreated={(c) => setChannelByServer((m) => ({ ...m, [c.serverId]: c.id }))}
      />
      <main id="chat-main" className="main" tabIndex={-1}>
        {server && channelId ? (
          <ChatView
            key={channelId}
            server={server}
            channelId={channelId}
            membersOpen={phone ? phoneMembers : membersOpen}
            onToggleMembers={toggleMembers}
            onBack={phone ? () => goPhone('nav') : undefined}
          />
        ) : (
          <Home
            hasServers={servers.length > 0}
            onCreate={() => setDialog('create')}
            onJoin={() => setDialog('join')}
            onJoinLink={(link, status) => {
              dialogNow.current = 'join';
              setInvite(link);
              setInviteStatus(status);
              setDialog('join');
            }}
          />
        )}
      </main>
      {showMembers && <MemberList server={server} onClose={phone ? toggleMembers : undefined} />}

      <Dialog open={linkNotMember} onClose={() => setLinkNotMember(false)} title={<FormattedMessage id="msglink.notMember.title" />} className="msglink-dialog">
        <p>
          <FormattedMessage id="msglink.notMember.body" />
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => setLinkNotMember(false)} autoFocus>
            <FormattedMessage id="msglink.ok" />
          </button>
        </div>
      </Dialog>
      <CreateServerDialog
        open={dialog === 'create'}
        onClose={() => setDialog(null)}
        onNeedCheck={() => setDialog('check')}
        onOpenServer={(id) => {
          setDialog(null);
          setServerId(id);
        }}
      />
      <ReportsDialog server={reportsServer ?? null} onClose={() => setReportsFor(null)} />
      <JoinDialog
        open={dialog === 'join'}
        initialLink={invite}
        initialStatus={inviteStatus}
        onBackground={(link) => backgroundJoins.current.add(link)}
        onClose={() => {
          setDialog(null);
          setInvite(undefined);
          setInviteStatus(null);
        }}
        onJoined={(id) => {
          setDialog(null);
          setInvite(undefined);
          setInviteStatus(null);
          setServerId(id);
        }}
      />
      <Dialog
        open={dialog === 'check'}
        onClose={closeCheck}
        title={intl.formatMessage({ id: showWords ? 'onb.words.title' : 'onb.check.title' })}
      >
        {showWords ? (
          <RecoveryWordsPanel load={() => core.getRecoveryWords()} onDone={() => setShowWords(false)} />
        ) : (
          // The words can be shown again here, so a reload during onboarding never
          // leaves an account that can't pass the check (QA-01).
          <RecoveryCheck onChecked={closeCheck} onShowAgain={() => setShowWords(true)} />
        )}
      </Dialog>
      {/* Member relays (#368): the one-time disclosure, the first time relaying is on. */}
      <MemberRelayFirstRun />
      <SettingsScreen
        open={settingsOpen}
        request={settingsRequest}
        onClose={() => setSettingsOpen(false)}
        onCheckWords={() => setDialog('check')}
      />

      {/* Toasts stack in one column, so two at once never overlap. */}
      <DeviceNotices />
      <div className="toasts">
        {callEndedForUpdate && (
          <div className="toast call-ended-update" role="alert" key={callEndedForUpdate}>
            <AlertIcon />
            <span>
              <FormattedMessage id="update.required.callEnded" />
            </span>
            {/* Already staged: the same restart as the rail pill and #604's banner button. */}
            {staged && (
              <button
                type="button"
                className="secondary small"
                onClick={() => core.restartToUpdate().catch((e) => isCoreError(e) && store.updateRefused(e.code))}
              >
                <FormattedMessage id="server.syncUpdateNeeded.restart" />
              </button>
            )}
          </div>
        )}
        {serverGone && (
          <div className="toast" role="status" key={serverGone.at}>
            <FormattedMessage id={`server.gone.${serverGone.reason}`} values={{ name: serverGone.name }} />
          </div>
        )}
        {flash && (
          <div className="toast" role="status" key={flash.at}>
            <FormattedMessage id={flash.id} values={flash.values} />
          </div>
        )}
        {channelGone && (
          <div className="toast" role="status">
            <FormattedMessage id="channel.deletedNotice" values={{ channel: channelGone }} />
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <ShieldIcon />
            <FormattedMessage id="notice.encryptionRenewed" />
          </div>
        )}

        {updateNote && (
          <div className="toast update-note" role="status">
            {updateNote.kind === 'installed' ? <RefreshIcon /> : <AlertIcon />}
            <div className="update-note-body">
              {updateNote.kind === 'installed' ? (
                <FormattedMessage id="update.installed" values={{ version: updateNote.version }} />
              ) : (
                <FormattedMessage id="update.rolledBack" values={{ failed: updateNote.failed, running: updateNote.running }} />
              )}
              {updateNote.kind === 'installed' && updateNote.notes && (
                // Plain text from the release manifest: rendered as text only.
                <details>
                  <summary>
                    <FormattedMessage id="update.whatsNew" />
                  </summary>
                  <p className="update-notes">
                    {paragraphs(updateNote.notes, uiDir).map((l, i) => (
                      <span key={i} className="msg-line user-text" dir={l.dir}>
                        {l.text}
                      </span>
                    ))}
                  </p>
                </details>
              )}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label={intl.formatMessage({ id: 'common.close' })}
              onClick={() => store.clearUpdateNote()}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
