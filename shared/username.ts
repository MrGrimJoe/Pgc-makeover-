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

/**
 * Usernames nobody can register, to stop impersonation of staff or the app itself.
 * Checked on sign-up, on username changes and by the availability check.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin',
  'administrator',
  'moderator',
  'mod',
  'staff',
  'support',
  'help',
  'official',
  'system',
  'root',
  'dialtone',
  'classsync',
];

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.includes(normalizeUsername(username));
}
