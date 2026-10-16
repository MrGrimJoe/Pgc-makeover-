/**
 * Username validation and normalization rules for Dialtone:
 * - 3 to 20 characters
 * - Lowercase alphanumeric and underscores only [a-z0-9_]
 * - Case-insensitive normalization (converts to lowercase, trims whitespace)
 */

export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

/**
 * Normalizes a username by trimming whitespace and converting to lowercase.
 */
export function normalizeUsername(username: string): string {
  if (typeof username !== 'string') return '';
  return username.trim().toLowerCase();
}

/**
 * Checks if a string satisfies the username rules.
 */
export function isValidUsername(username: string): boolean {
  if (typeof username !== 'string') return false;
  return USERNAME_REGEX.test(username);
}
