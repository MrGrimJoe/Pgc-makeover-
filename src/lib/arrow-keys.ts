import type React from 'react';

/**
 * Up/Down/Home/End move focus between the buttons of a list (conversation list, Settings sections),
 * so a keyboard user does not have to Tab through every row. Put it on the list's container as onKeyDown.
 */
export function arrowKeyNav(e: React.KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return; // focus is not on one of the buttons (for example inside a text field)
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
  items[next]?.focus();
}
