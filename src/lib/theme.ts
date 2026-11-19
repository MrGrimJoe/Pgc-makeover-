export type ThemeChoice = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'dialtone_theme';

export function getStoredTheme(): ThemeChoice {
  try {
    const val = localStorage.getItem(THEME_STORAGE_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') return val;
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Ignore storage errors
  }
  if (choice === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', choice);
  }
}
