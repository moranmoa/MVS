import { describe, expect, it } from 'vitest';
import { normalizeEmoji } from '../core/emoji';
import { MockCore } from '../core/mock';
import { cleanMessage } from '../core/sanitize';
import type { Message } from '../core';

// The same cases as core/api/src/reaction.rs: the two checks must agree.
describe('G-26 emoji check', () => {
  it('accepts common emoji', () => {
    for (const ok of ['👍', '❤', '😂', '🎉', '👍🏽', '👩‍💻', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🇮🇱', '🇺🇸', '1️⃣', '#⃣', '*️⃣', '✅', '©', '☺️', '🫶']) {
      expect(normalizeEmoji(ok), ok).not.toBeNull();
    }
  });

  it('drops one trailing VS16', () => {
    expect(normalizeEmoji('❤️')).toBe('❤');
    expect(normalizeEmoji('👍️')).toBe('👍');
    expect(normalizeEmoji('👍🏻️')).toBe('👍🏻');
    expect(normalizeEmoji('👍️️')).toBeNull();
  });

  it('refuses controls, bidi, whitespace, tags and ZWJ edge cases', () => {
    const bad = [
      '', ' ', 'a', '1', '#', '*', '12', '👍 ', ' 👍', '👍\n', '‍👍', '👍‍', '👍‍‍👍', '️',
      '️👍', '👍\u{1F3FB}\u{1F3FB}', '\u{1F3FB}', '👍️\u{1F3FB}', '⃣', '1️', '🇮', '🇮🇱🇺',
      '‮👍', '👍‮', '⁦👍', '👍‏', '👍\u0000', '\u0007', '👍 ', '👍　',
      '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', '👍\u{E0041}', '\u{E0020}', '', '👍👍', '👍a',
      'a‍👍', '​👍', '👍﻿',
    ];
    for (const b of bad) expect(normalizeEmoji(b), JSON.stringify(b)).toBeNull();
    const suspects: number[] = [];
    for (let c = 0; c < 0x20; c++) suspects.push(c);
    for (let c = 0x7f; c < 0xa0; c++) suspects.push(c);
    suspects.push(0x200b, 0x200c, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060, 0xfeff, 0x3000, 0xa0, 0x20, 0x09);
    for (let c = 0x202a; c <= 0x202e; c++) suspects.push(c);
    for (let c = 0x2066; c <= 0x2069; c++) suspects.push(c);
    for (let c = 0x2000; c <= 0x200a; c++) suspects.push(c);
    for (let c = 0xe0000; c <= 0xe007f; c++) suspects.push(c);
    for (const code of suspects) {
      const c = String.fromCodePoint(code);
      for (const s of [c, `👍${c}`, `${c}👍`, `👍‍${c}`]) expect(normalizeEmoji(s), code.toString(16)).toBeNull();
    }
    const long = Array(5).fill('🫶').join('‍');
    expect(new TextEncoder().encode(long).length).toBe(32);
    expect(normalizeEmoji(long)).not.toBeNull();
    expect(normalizeEmoji(`${long}\u{1F3FB}`)).toBeNull();
    expect(normalizeEmoji(Array(6).fill('👍').join('‍'))).toBeNull();
  });
});

describe('G-26 in the mock and the sanitizer', () => {
  it('toggles my chip and caps me at 10', async () => {
    const core = new MockCore({ demo: true, speed: 0 });
    const [m] = (await core.getMessages('c-general', 0, 1)).messages;
    const updates: Message[] = [];
    core.on('message.updated', (x) => updates.push(x));
    await core.react(m.id, '👍️', true);
    expect(updates.at(-1)!.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    await core.react(m.id, '👍', true);
    expect(updates).toHaveLength(1);
    await expect(core.react(m.id, 'x', true)).rejects.toMatchObject({ code: 'bad-request' });
    for (const e of ['😀', '😁', '😂', '😃', '😄', '😅', '😆', '😉', '😊']) await core.react(m.id, e, true);
    await expect(core.react(m.id, '😋', true)).rejects.toMatchObject({ code: 'bad-request' });
    await core.react(m.id, '👍', false);
    expect(updates.at(-1)!.reactions!.some((c) => c.emoji === '👍')).toBe(false);
    await expect(core.getUpdateNeeded('nope', 'reactions-v1')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('cleans reactions from the core', () => {
    const base: Message = { id: 'a'.repeat(64), channelId: 'c', index: 0, authorId: 'b'.repeat(64), body: 'x', createdAt: 1 };
    const raw = [
      { emoji: '👍', count: 2, mine: true },
      { emoji: '👍', count: 9, mine: false },
      { emoji: '‮👍', count: 1, mine: false },
      { emoji: '❤️', count: 1, mine: false },
      { emoji: '🎉', count: 0, mine: false },
      { emoji: '🎉', count: 1.5, mine: false },
      { emoji: '😀', count: 1, mine: 'yes' },
      null,
    ];
    const cleaned = cleanMessage({ ...base, reactions: raw as Message['reactions'] });
    expect(cleaned.reactions).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '😀', count: 1, mine: false },
    ]);
    expect(cleanMessage({ ...base, reactions: 'x' as unknown as Message['reactions'] }).reactions).toBeUndefined();
    const many = Array.from({ length: 30 }, (_, i) => ({ emoji: String.fromCodePoint(0x1f600 + i), count: 1, mine: false }));
    expect(cleanMessage({ ...base, reactions: many }).reactions).toHaveLength(20);
  });
});
