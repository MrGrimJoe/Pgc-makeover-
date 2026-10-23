import React from 'react';
import { Home, Search, PlusSquare, MessageSquare, User, Settings, type LucideIcon } from 'lucide-react';
import type { AppTab } from './BottomTabBar.tsx';

interface SideNavProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  onOpenMessages: () => void;
  onTitleClick: () => void;
  /** Desktop: icons with labels. Tablet: a slim icon rail. */
  expanded: boolean;
  appName?: string;
}

const ITEMS: Array<{ tab: AppTab; label: string; Icon: LucideIcon }> = [
  { tab: 'feed', label: 'Feed', Icon: Home },
  { tab: 'search', label: 'Search', Icon: Search },
  { tab: 'post', label: 'New post', Icon: PlusSquare },
  { tab: 'messages', label: 'Messages', Icon: MessageSquare },
  { tab: 'profile', label: 'Profile', Icon: User },
];

/** Navigation for tablet and desktop. Replaces the bottom tab bar (only one of the two is ever in the page). */
export const SideNav: React.FC<SideNavProps> = ({ activeTab, setActiveTab, onOpenMessages, onTitleClick, expanded, appName = 'Dialtone' }) => {
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
        <Icon className="w-6 h-6 stroke-[1.7] shrink-0" fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
        {expanded && <span>{label}</span>}
      </button>
    );
  };

  return (
    <nav
      aria-label="Navigation"
      data-nav={expanded ? 'sidebar' : 'rail'}
      className={`sticky top-0 self-start h-screen shrink-0 flex flex-col py-3 gap-1 bg-[var(--bg,#fff)] border-r border-[var(--line,#E8EBF0)] ${expanded ? 'w-[240px] px-3' : 'w-[72px] px-2'}`}
    >
      <button
        type="button"
        onClick={onTitleClick}
        aria-label={`${appName} home`}
        className={`bg-transparent border-0 cursor-pointer text-[var(--text,#17233A)] font-semibold tracking-[-0.3px] mb-2 min-h-[48px] ${expanded ? 'text-[22px] text-left px-3' : 'text-[22px] mx-auto'}`}
      >
        {expanded ? appName : appName.charAt(0)}
      </button>
      {ITEMS.map(item)}
      <div className="mt-auto">{item({ tab: 'settings', label: 'Settings', Icon: Settings })}</div>
    </nav>
  );
};
