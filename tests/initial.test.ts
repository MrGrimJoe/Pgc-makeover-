import { describe, it, expect } from 'vitest';
import { avatarInitial } from '../src/lib/initial.ts';

describe('avatarInitial', () => {
  it('returns exactly one uppercase character', () => {
    expect(avatarInitial('Ali Khan')).toBe('A');
    expect(avatarInitial('bob')).toBe('B');
    expect(avatarInitial('zainab.r')).toBe('Z');
  });

  it('uses the first non-empty name', () => {
    expect(avatarInitial('', 'sana')).toBe('S');
    expect(avatarInitial(null, undefined, '  omar ')).toBe('O');
  });

  it('skips leading punctuation and whitespace', () => {
    expect(avatarInitial('  @sam')).toBe('S');
    expect(avatarInitial('_x')).toBe('X');
  });

  it('falls back to U when there is no name', () => {
    expect(avatarInitial()).toBe('U');
    expect(avatarInitial('', '   ', null)).toBe('U');
  });

  it('never splits emoji or returns more than one character', () => {
    const names = ['😀 smile', '😀', 'Ålesund', 'ßeta', '日本', '123', 'ab', 'A', '👩‍💻 dev'];
    for (const n of names) {
      expect(Array.from(avatarInitial(n)).length, `name: ${n}`).toBe(1);
    }
    expect(avatarInitial('😀 smile')).toBe('S');
  });
});
