import type { AppTab } from '../components/BottomTabBar.tsx';

/** Where the person is in the app. The URL does not change; the browser history carries this instead. */
export interface NavState {
  tab: AppTab;
  sub: 'view' | 'edit';
  user: string;
}

/** What the app stores in each history entry. `idx` counts how deep the in-app history is (0 = first screen). */
export interface HistoryEntry {
  nav: NavState;
  idx: number;
}

const TABS: AppTab[] = ['feed', 'search', 'post', 'profile', 'signin', 'signup', 'messages', 'settings', 'admin'];

export const sameNav = (a: NavState, b: NavState): boolean => a.tab === b.tab && a.sub === b.sub && a.user === b.user;

/** Reads our entry from history.state, ignoring anything else that may be there. */
export function readEntry(state: unknown): HistoryEntry | null {
  if (!state || typeof state !== 'object') return null;
  const e = state as { nav?: Partial<NavState>; idx?: unknown };
  if (!e.nav || typeof e.idx !== 'number' || !Number.isInteger(e.idx) || e.idx < 0) return null;
  const { tab, sub, user } = e.nav;
  if (!TABS.includes(tab as AppTab) || (sub !== 'view' && sub !== 'edit') || typeof user !== 'string') return null;
  return { nav: { tab: tab as AppTab, sub, user }, idx: e.idx };
}

/** Pages that open "on top of" another one and slide in from the side. */
export const isDeepPage = (n: NavState): boolean => n.tab === 'settings' || n.tab === 'messages' || (n.tab === 'profile' && n.sub === 'edit');
