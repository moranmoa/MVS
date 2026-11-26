import { describe, expect, it, vi } from 'vitest';
import { createIpcCore, hasDesktopBridge, setUnreadCount, type DesktopBridge } from './ipc';

function fakeBridge(answer: (cmd: string, args: unknown[]) => { ok?: unknown; error?: { code: string } }) {
  let emit: (event: string, payload: unknown) => void = () => {};
  const bridge: DesktopBridge = {
    invoke: vi.fn(async (cmd: string, args: unknown[]) => answer(cmd, args)),
    onEvent: (cb) => {
      emit = cb;
      return () => {};
    },
  };
  return { bridge, emit: (e: string, p: unknown) => emit(e, p) };
}

describe('ipc core', () => {
  it('sends the command name and positional args', async () => {
    const { bridge } = fakeBridge(() => ({ ok: { total: 3 } }));
    const core = createIpcCore(bridge);
    await expect(core.getMessages('c1', 0, 10)).resolves.toEqual({ total: 3 });
    expect(bridge.invoke).toHaveBeenCalledWith('getMessages', ['c1', 0, 10]);
  });

  it('rejects with the core error object', async () => {
    const { bridge } = fakeBridge(() => ({ error: { code: 'invalid-words', positions: [2] } as never }));
    await expect(createIpcCore(bridge).restoreIdentity(['a'])).rejects.toEqual({ code: 'invalid-words', positions: [2] });
  });

  it('delivers events to the matching handlers until unsubscribed', () => {
    const { bridge, emit } = fakeBridge(() => ({ ok: null }));
    const core = createIpcCore(bridge);
    const seen: unknown[] = [];
    const off = core.on('server.removed', (p) => seen.push(p));
    emit('server.removed', { serverId: 's1' });
    emit('message.added', { id: 'm' });
    off();
    emit('server.removed', { serverId: 's2' });
    expect(seen).toEqual([{ serverId: 's1' }]);
  });

  it('keeps a link.open that arrives before anyone listens, for the first listener only', async () => {
    const { bridge, emit } = fakeBridge(() => ({ ok: null }));
    const core = createIpcCore(bridge);
    emit('link.open', { link: 'mvs://join/a' });
    emit('link.open', { link: 'mvs://join/b' });
    const first: unknown[] = [];
    const second: unknown[] = [];
    core.on('link.open' as never, (p: unknown) => first.push(p));
    core.on('link.open' as never, (p: unknown) => second.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(first).toEqual([{ link: 'mvs://join/b' }]);
    expect(second).toEqual([]);
    emit('link.open', { link: 'mvs://join/c' });
    expect(first).toEqual([{ link: 'mvs://join/b' }, { link: 'mvs://join/c' }]);
    expect(second).toEqual([{ link: 'mvs://join/c' }]);
  });

  it('G-30: keeps a link.message too, separately from link.open, for its first listener', async () => {
    const { bridge, emit } = fakeBridge(() => ({ ok: null }));
    const core = createIpcCore(bridge);
    const ids = (n: string) => ({ serverId: n.repeat(64), channelId: 'c'.repeat(64), messageId: 'd'.repeat(64) });
    emit('link.message', ids('a'));
    emit('link.message', ids('b'));
    emit('link.open', { link: 'mvs://join/x' });
    const msgs: unknown[] = [];
    const invites: unknown[] = [];
    core.on('link.message' as never, (p: unknown) => msgs.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(msgs).toEqual([ids('b')]);
    core.on('link.open' as never, (p: unknown) => invites.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(invites).toEqual([{ link: 'mvs://join/x' }]);
  });

  it('QA MR.1: gives the latest memberRelay.changed to a listener that comes late', async () => {
    const { bridge, emit } = fakeBridge(() => ({ ok: null }));
    const core = createIpcCore(bridge);
    emit('memberRelay.changed', { effective: false });
    emit('memberRelay.changed', { effective: true });
    const seen: unknown[] = [];
    core.on('memberRelay.changed' as never, (p: unknown) => seen.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ effective: true }]);
    // Content events are not replayed.
    emit('message.new', { id: 'm1' });
    const late: unknown[] = [];
    core.on('message.new' as never, (p: unknown) => late.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toEqual([]);
  });

  it('gives the latest core.status to every listener, also ones that come late (T8-01)', async () => {
    const { bridge, emit } = fakeBridge(() => ({ ok: null }));
    const core = createIpcCore(bridge);
    emit('core.status', { state: 'starting' });
    emit('core.status', { state: 'down', detail: 'crashed' });
    const a: unknown[] = [];
    const b: unknown[] = [];
    core.on('core.status' as never, (p: unknown) => a.push(p));
    core.on('core.status' as never, (p: unknown) => b.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(a).toEqual([{ state: 'down', detail: 'crashed' }]);
    expect(b).toEqual([{ state: 'down', detail: 'crashed' }]);
    emit('core.status', { state: 'up' });
    expect(a.at(-1)).toEqual({ state: 'up' });
    expect(b.at(-1)).toEqual({ state: 'up' });
    // A listener added later still learns the current state.
    const c: unknown[] = [];
    core.on('core.status' as never, (p: unknown) => c.push(p));
    await new Promise((r) => setTimeout(r, 0));
    expect(c).toEqual([{ state: 'up' }]);
  });

  it('does not replay a stale core.status after a newer one arrived', async () => {
    const { bridge, emit } = fakeBridge(() => ({ ok: null }));
    const core = createIpcCore(bridge);
    emit('core.status', { state: 'down', detail: 'crashed' });
    const seen: unknown[] = [];
    core.on('core.status' as never, (p: unknown) => seen.push(p));
    emit('core.status', { state: 'up' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ state: 'up' }]);
  });

  it('is not a thenable', () => {
    const { bridge } = fakeBridge(() => ({ ok: null }));
    expect((createIpcCore(bridge) as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('detects the bridge', () => {
    expect(hasDesktopBridge()).toBe(false);
  });
});

describe('setUnreadCount (G-62)', () => {
  const bridge = (impl?: (n: number) => Promise<boolean>): DesktopBridge => ({
    invoke: async () => ({ ok: null }),
    onEvent: () => () => {},
    ...(impl ? { setUnreadCount: impl } : {}),
  });

  it('passes the count to the shell and returns its answer', async () => {
    const impl = vi.fn(async (n: number) => n === 3);
    await expect(setUnreadCount(3, bridge(impl))).resolves.toBe(true);
    await expect(setUnreadCount(-1, bridge(impl))).resolves.toBe(false);
    expect(impl).toHaveBeenCalledWith(3);
  });

  it('resolves false without the bridge or when the shell throws', async () => {
    await expect(setUnreadCount(1, undefined)).resolves.toBe(false);
    await expect(setUnreadCount(1, bridge())).resolves.toBe(false);
    await expect(setUnreadCount(1, bridge(async () => { throw new Error('x'); }))).resolves.toBe(false);
  });
});
