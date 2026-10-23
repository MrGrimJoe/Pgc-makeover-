import React from 'react';
import { Home, Search, PlusSquare, User } from 'lucide-react';

export type AppTab = 'feed' | 'search' | 'post' | 'profile' | 'signin' | 'signup' | 'messages' | 'settings';

interface BottomTabBarProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  isAuthenticated: boolean;
}

const TABS: Array<{ tab: AppTab; label: string; Icon: typeof Home }> = [
  { tab: 'feed', label: 'Feed', Icon: Home },
  { tab: 'search', label: 'Search', Icon: Search },
  { tab: 'post', label: 'New post', Icon: PlusSquare },
  { tab: 'profile', label: 'Profile', Icon: User },
];

export const BottomTabBar: React.FC<BottomTabBarProps> = ({ activeTab, setActiveTab, isAuthenticated }) => {
  if (!isAuthenticated) return null;

  return (
    <nav
      aria-label="Navigation"
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] h-[56px] flex bg-[var(--bg,#fff)] border-t border-[var(--line,#E8EBF0)] pb-[env(safe-area-inset-bottom)] z-40"
    >
      {TABS.map(({ tab, label, Icon }) => {
        const active = activeTab === tab;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            title={label}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={`relative flex-1 h-full min-h-[44px] flex items-center justify-center cursor-pointer bg-transparent border-0 ${
              active ? 'text-[var(--text,#17233A)]' : 'text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)]'
            }`}
          >
            {/* Indicator bar: grows in from the middle when the tab becomes active */}
            <span
              aria-hidden="true"
              className={`absolute top-0 h-[2px] rounded-full bg-[var(--blue,#244C8A)] transition-all duration-200 ease-out ${active ? 'w-8 opacity-100' : 'w-0 opacity-0'}`}
            />
            {/* The key restarts the little pop each time the tab is selected */}
            <Icon
              key={active ? 'on' : 'off'}
              className={`w-6 h-6 stroke-[1.7] ${active ? 'tab-pop' : ''}`}
              fill={active ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </nav>
  );
};
