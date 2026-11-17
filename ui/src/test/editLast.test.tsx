// G-32: ↑ in an empty composer edits my last message; with Alt (channel and
// server switching) it does not.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';

vi.mock('../voice', () => ({
  useVoiceEngine: () => ({ ready: true, speaking: {}, peerFailed: {}, setMicMuted: () => {}, inputs: [], outputs: [], setInput: () => {}, setOutput: () => {} }),
}));

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

async function sendOne() {
  render(<App core={new MockCore({ demo: true, speed: 0, simulateActivity: false })} initialSettings={en} />);
  const box = (await screen.findByRole('textbox', { name: /^Message / })) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'hello from me' } });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' });
  });
  return box;
}

describe('↑ edits the last message (G-32)', () => {
  it('a plain ↑ in an empty composer opens my last message for editing', async () => {
    const box = await sendOne();
    expect(box.value).toBe('');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'ArrowUp' });
    });
    expect(screen.getByText('Editing message')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /^Message / }) as HTMLTextAreaElement).value).toBe('hello from me');
  });

  it.each([{ altKey: true }, { altKey: true, ctrlKey: true }, { shiftKey: true }, { ctrlKey: true }])('not with modifiers (%o)', async (mods) => {
    const box = await sendOne();
    await act(async () => {
      fireEvent.keyDown(box, { key: 'ArrowUp', ...mods });
    });
    expect(screen.queryByText('Editing message')).toBeNull();
  });

  it('not when the composer has text', async () => {
    const box = await sendOne();
    fireEvent.change(box, { target: { value: 'draft' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'ArrowUp' });
    });
    expect(screen.queryByText('Editing message')).toBeNull();
  });
});
