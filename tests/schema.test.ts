import { describe, it, expect } from 'vitest';
import { updateProfileSchema } from '../shared/schema.ts';

describe('Shared Schema Validation (updateProfileSchema)', () => {
  it('accepts valid profile update inputs', () => {
    const validData = {
      username: 'valid_user_1',
      display_name: 'Alice Wonderland',
      bio: 'Software engineer building on Cloudflare Workers.',
      dm_policy: 'everyone',
    };

    const result = updateProfileSchema.safeParse(validData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe('valid_user_1');
    }
  });

  it('rejects usernames that do not meet requirements', () => {
    // Too short
    expect(updateProfileSchema.safeParse({ username: 'ab' }).success).toBe(false);

    // Too long (>20 chars)
    expect(
      updateProfileSchema.safeParse({ username: 'this_username_is_way_too_long_to_be_valid' }).success
    ).toBe(false);

    // Contains uppercase
    expect(updateProfileSchema.safeParse({ username: 'ValidUser' }).success).toBe(false);

    // Contains hyphens or spaces
    expect(updateProfileSchema.safeParse({ username: 'user-name' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ username: 'user name' }).success).toBe(false);
  });

  it('validates display_name length', () => {
    // Empty display name after trim should fail
    expect(updateProfileSchema.safeParse({ display_name: '   ' }).success).toBe(false);

    // Greater than 50 chars should fail
    expect(
      updateProfileSchema.safeParse({ display_name: 'A'.repeat(51) }).success
    ).toBe(false);

    // Exactly 50 chars succeeds
    expect(
      updateProfileSchema.safeParse({ display_name: 'A'.repeat(50) }).success
    ).toBe(true);
  });

  it('validates bio length', () => {
    // Over 500 chars fails
    expect(updateProfileSchema.safeParse({ bio: 'x'.repeat(501) }).success).toBe(false);

    // Up to 500 chars succeeds
    expect(updateProfileSchema.safeParse({ bio: 'x'.repeat(500) }).success).toBe(true);
  });

  it('validates dm_policy enum', () => {
    expect(updateProfileSchema.safeParse({ dm_policy: 'everyone' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ dm_policy: 'following' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ dm_policy: 'none' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ dm_policy: 'unknown_option' as any }).success).toBe(false);
  });

  it('rejects unknown fields because schema is strict', () => {
    const invalidExtra = {
      username: 'good_user',
      unauthorized_field: 'malicious_data',
    };
    expect(updateProfileSchema.safeParse(invalidExtra).success).toBe(false);
  });
});
