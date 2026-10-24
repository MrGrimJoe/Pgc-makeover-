import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Home, Search, PlusSquare, MessageSquare, User, Settings, PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import type { AppTab } from './BottomTabBar.tsx';
import type { Layout } from '../lib/layout.ts';

interface SideNavProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  onOpenMessages: () => void;
  onTitleClick: () => void;
  /** Desktop: icons with labels. Tablet: a slim icon rail. */
  expanded: boolean;
  /** Desktop only: collapse the sidebar to the icon rail, or open it again. Omitted on tablet (it is already a rail). */
  onToggleCollapsed?: () => void;
  appName?: string;
}

const ITEMS: Array<{ tab: AppTab; label: string; Icon: LucideIcon }> = [
  { tab: 'feed', label: 'Feed', Icon: Home },
  { tab: 'search', label: 'Search', Icon: Search },
  { tab: 'post', label: 'New post', Icon: PlusSquare },
  { tab: 'messages', label: 'Messages', Icon: MessageSquare },
  { tab: 'profile', label: 'Profile', Icon: User },
];

const STORAGE_KEY = 'nav-collapsed';

/**
 * Whether the person has collapsed the desktop sidebar to the rail. Remembered in this browser only (a light
 * convenience, so a blocked or empty store just means the sidebar starts open). Writes data-nav-collapsed on <html>
 * so --nav-w follows and overlays keep sitting over the column.
 */
export function useSideNavCollapsed(layout: Layout): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* storage unavailable: keep it for this visit only */ }
      return next;
    });
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (layout === 'desktop' && collapsed) root.dataset.navCollapsed = 'true';
    else delete root.dataset.navCollapsed;
    return () => { delete root.dataset.navCollapsed; };
  }, [layout, collapsed]);
  return [collapsed, toggle];
}

/** Navigation for tablet and desktop. Replaces the bottom tab bar (only one of the two is ever in the page). */
export const SideNav: React.FC<SideNavProps> = ({ activeTab, setActiveTab, onOpenMessages, onTitleClick, expanded, onToggleCollapsed, appName = 'Dialtone' }) => {
  const item = ({ tab, label, Icon }: { tab: AppTab; label: string; Icon: LucideIcon }) => {
    const active = activeTab === tab;
    return (
      <button
        key={tab}
        type="button"
        onClick={() => (tab === 'messages' ? onOpenMessages() : setActiveTab(tab))}
        title={label}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-3 min-h-[48px] rounded-[12px] border-0 cursor-pointer text-[15px] ${
          expanded ? 'px-3 w-full justify-start' : 'w-12 justify-center mx-auto'
        } ${active ? 'bg-[var(--tint,#EEF3FB)] text-[var(--text,#17233A)] font-semibold' : 'bg-transparent text-[var(--muted,#5B6577)] hover:bg-[var(--bg2,#F8F9FC)] hover:text-[var(--text,#17233A)]'}`}
      >
        {/* The active icon is drawn heavier, not filled: a filled "New post" square swallows its plus and a filled gear loses its centre */}
        <Icon className={`w-6 h-6 shrink-0 ${active ? 'stroke-[2.2]' : 'stroke-[1.7]'}`} aria-hidden="true" />
        {expanded && <span>{label}</span>}
      </button>
    );
  };

  const ToggleIcon = expanded ? PanelLeftClose : PanelLeftOpen;
  const toggleLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar';
  const toggle = onToggleCollapsed && (
    <button
      type="button"
      onClick={onToggleCollapsed}
      title={toggleLabel}
      aria-label={toggleLabel}
      aria-expanded={expanded}
      className={`flex items-center justify-center w-10 h-10 rounded-[10px] border-0 cursor-pointer bg-transparent text-[var(--muted,#5B6577)] hover:bg-[var(--bg2,#F8F9FC)] hover:text-[var(--text,#17233A)] shrink-0 ${expanded ? '' : 'mx-auto'}`}
    >
      <ToggleIcon className="w-5 h-5 stroke-[1.7]" aria-hidden="true" />
    </button>
  );

  return (
    <nav
      aria-label="Navigation"
      data-nav={expanded ? 'sidebar' : 'rail'}
      className={`sticky top-0 self-start h-screen shrink-0 flex flex-col py-3 ${expanded ? 'gap-1 px-3' : 'gap-2 px-2'} bg-[var(--bg,#fff)] border-r border-[var(--line,#E8EBF0)] w-[var(--nav-w)] overflow-y-auto overflow-x-hidden`}
    >
      <div className={`flex items-center mb-4 ${expanded ? 'justify-between' : 'flex-col gap-1'}`}>
        <button
          type="button"
          onClick={onTitleClick}
          aria-label={`${appName} home`}
          className={`bg-transparent border-0 cursor-pointer text-[var(--text,#17233A)] font-semibold tracking-[-0.3px] min-h-[48px] text-[22px] ${expanded ? 'text-left px-3' : 'mx-auto'}`}
        >
          {expanded ? appName : appName.charAt(0)}
        </button>
        {toggle}
      </div>
      {ITEMS.map(item)}
      <div className="mt-auto">{item({ tab: 'settings', label: 'Settings', Icon: Settings })}</div>
    </nav>
  );
};
