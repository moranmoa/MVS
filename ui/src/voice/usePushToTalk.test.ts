// G-74: push-to-talk from the shell's ptt.down / ptt.up to the mic.

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { onPushToTalk, setPushToTalk, type DesktopBridge, type PushToTalkSettings } from '../core/ipc';
import { nextTalking, pttMicMuted, usePushToTalk, type PushToTalkOptions } from './usePushToTalk';

function fakeShell(answer: 'ok' | 'invalid' | 'shortcut-taken' = 'ok') {
  const listeners = new Set<(e: string, p: unknown) => void>();
  const sent: PushToTalkSettings[] = [];
  const bridge: DesktopBridge = {
    invoke: async () => ({ ok: null }),
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setPushToTalk: vi.fn(async (s: PushToTalkSettings) => {
      sent.push(s);
      return answer;
    }),
  };
  const emit = (e: string) => act(() => listeners.forEach((cb) => cb(e, {})));
  return { bridge, sent, emit, listeners };
}

describe('pttMicMuted / nextTalking', () => {
  it('decides only in push-to-talk mode with a key', () => {
    expect(pttMicMuted({ mode: 'open', pttKey: 'KeyV', talking: true, hardMuted: false })).toBeNull();
    expect(pttMicMuted({ mode: 'ptt', pttKey: null, talking: true, hardMuted: false })).toBeNull();
    expect(pttMicMuted({ mode: 'ptt', pttKey: 'KeyV', talking: false, hardMuted: false })).toBe(true);
    expect(pttMicMuted({ mode: 'ptt', pttKey: 'KeyV', talking: true, hardMuted: false })).toBe(false);
    // The mute button is a hard mute, even while the key is held.
    expect(pttMicMuted({ mode: 'ptt', pttKey: 'KeyV', talking: true, hardMuted: true })).toBe(true);
  });
  it('follows down and up; toggleMute leaves talking alone', () => {
    expect(nextTalking(false, 'down')).toBe(true);
    expect(nextTalking(true, 'up')).toBe(false);
    expect(nextTalking(true, 'toggleMute')).toBe(true);
  });
});

describe('ipc wrappers', () => {
  it('report unsupported / do nothing without the desktop bridge', async () => {
    await expect(setPushToTalk({ key: 'KeyV', globalMute: null }, undefined)).resolves.toBe('unsupported');
    expect(typeof onPushToTalk(() => {}, undefined)).toBe('function');
  });
  it('pass only ptt signals through', () => {
    const { bridge, listeners } = fakeShell();
    const got: string[] = [];
    const off = onPushToTalk((s) => got.push(s), bridge);
    for (const e of ['core.status', 'ptt.down', 'ptt.up', 'ptt.toggleMute', 'ptt.other']) listeners.forEach((cb) => cb(e, {}));
    expect(got).toEqual(['down', 'up', 'toggleMute']);
    off();
    expect(listeners.size).toBe(0);
  });
  it('map unknown shell answers to invalid', async () => {
    const bridge: DesktopBridge = { invoke: async () => ({}), onEvent: () => () => {}, setPushToTalk: async () => 'weird' as never };
    await expect(setPushToTalk({ key: null, globalMute: null }, bridge)).resolves.toBe('invalid');
  });
});

describe('usePushToTalk', () => {
  const base = (bridge: DesktopBridge, over: Partial<PushToTalkOptions> = {}): PushToTalkOptions => ({
    mode: 'ptt',
    pttKey: 'KeyV',
    globalMute: null,
    inCall: true,
    hardMuted: false,
    setMicMuted: vi.fn(),
    bridge,
    ...over,
  });

  it('opens the mic only while the key is held', async () => {
    const shell = fakeShell();
    const opts = base(shell.bridge);
    const { result } = renderHook(() => usePushToTalk(opts));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(shell.sent.at(-1)).toEqual({ key: 'KeyV', globalMute: null });
    expect(opts.setMicMuted).toHaveBeenLastCalledWith(true);
    shell.emit('ptt.down');
    expect(result.current.talking).toBe(true);
    expect(opts.setMicMuted).toHaveBeenLastCalledWith(false);
    shell.emit('ptt.up');
    expect(result.current.talking).toBe(false);
    expect(opts.setMicMuted).toHaveBeenLastCalledWith(true);
  });

  it('open mode sends no key and leaves the mic to the mute button', async () => {
    const shell = fakeShell();
    const opts = base(shell.bridge, { mode: 'open' });
    renderHook(() => usePushToTalk(opts));
    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(0));
    expect(shell.sent.at(-1)).toEqual({ key: null, globalMute: null });
    shell.emit('ptt.down');
    expect(opts.setMicMuted).not.toHaveBeenCalled();
  });

  it('switching back to open mode hands the mic back; unmount clears the shell', async () => {
    const shell = fakeShell();
    const setMicMuted = vi.fn();
    const { rerender, unmount } = renderHook((p: PushToTalkOptions) => usePushToTalk(p), {
      initialProps: base(shell.bridge, { setMicMuted }),
    });
    expect(setMicMuted).toHaveBeenLastCalledWith(true);
    rerender(base(shell.bridge, { setMicMuted, mode: 'open' }));
    expect(setMicMuted).toHaveBeenLastCalledWith(false);
    unmount();
    await waitFor(() => expect(shell.sent.at(-1)).toEqual({ key: null, globalMute: null }));
  });

  it('the global shortcut calls onToggleMute; a taken shortcut is reported', async () => {
    const shell = fakeShell('shortcut-taken');
    const onToggleMute = vi.fn();
    const { result } = renderHook(() => usePushToTalk(base(shell.bridge, { globalMute: 'CommandOrControl+Shift+M', onToggleMute })));
    await waitFor(() => expect(result.current.status).toBe('shortcut-taken'));
    shell.emit('ptt.toggleMute');
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(result.current.talking).toBe(false);
  });

  it('leaving the call stops talking', () => {
    const shell = fakeShell();
    const { result, rerender } = renderHook((p: PushToTalkOptions) => usePushToTalk(p), { initialProps: base(shell.bridge) });
    shell.emit('ptt.down');
    expect(result.current.talking).toBe(true);
    rerender(base(shell.bridge, { inCall: false }));
    expect(result.current.talking).toBe(false);
  });
});
