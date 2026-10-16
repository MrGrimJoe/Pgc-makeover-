import { describe, it, expect } from 'vitest';
import { normalizeUsername, isValidUsername, USERNAME_REGEX } from '../shared/username.ts';

describe('Username normalization and validation', () => {
  it('normalizes username by trimming whitespace and converting to lowercase', () => {
    expect(normalizeUsername('  Alice_123  ')).toBe('alice_123');
    expect(normalizeUsername('BOB_THE_BUILDER')).toBe('bob_the_builder');
    expect(normalizeUsername('User_Name')).toBe('user_name');
  });

  it('validates 3 to 20 character usernames with lowercase letters, numbers, and underscores', () => {
    // Valid cases
    expect(isValidUsername('abc')).toBe(true);
    expect(isValidUsername('user_123')).toBe(true);
    expect(isValidUsername('a1_b2_c3_d4_e5_f6_g7')).toBe(true); // 20 chars
    expect(isValidUsername('john_doe')).toBe(true);

    // Invalid length (< 3 or > 20)
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a')).toBe(false);
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('a1_b2_c3_d4_e5_f6_g7_too_long')).toBe(false);

    // Invalid characters (uppercase, spaces, special symbols)
    expect(isValidUsername('Alice')).toBe(false); // uppercase not valid un-normalized
    expect(isValidUsername('user name')).toBe(false); // space
    expect(isValidUsername('user-name')).toBe(false); // hyphen not allowed
    expect(isValidUsername('user@name')).toBe(false); // @
    expect(isValidUsername('user.name')).toBe(false); // dot
  });

  it('regex accurately matches specification', () => {
    expect(USERNAME_REGEX.test('valid_user99')).toBe(true);
    expect(USERNAME_REGEX.test('no spaces')).toBe(false);
  });
});
