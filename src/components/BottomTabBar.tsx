import React from 'react';
import { Home, Search, PlusSquare, User } from 'lucide-react';

export type AppTab = 'feed' | 'search' | 'post' | 'profile' | 'signin' | 'signup' | 'messages';

interface BottomTabBarProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  isAuthenticated: boolean;
}

export const BottomTabBar: React.FC<BottomTabBarProps> = ({
  activeTab,
  setActiveTab,
  isAuthenticated,
}) => {
  if (!isAuthenticated) return null;

  return (
    <nav
      aria-label="Navigation"
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] h-[56px] flex bg-[var(--bg,#fff)] border-t border-[var(--line,#E8EBF0)] pb-[env(safe-area-inset-bottom,0px)] z-40"
    >
      {/* Feed Tab */}
      <button
        type="button"
        onClick={() => setActiveTab('feed')}
        title="Feed"
        aria-label="Feed"
        aria-current={activeTab === 'feed' ? 'page' : undefined}
        className={`flex-1 h-full min-h-[44px] flex items-center justify-center cursor-pointer transition-colors bg-transparent border-0 ${
          activeTab === 'feed'
            ? 'text-[var(--text,#17233A)]'
            : 'text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)]'
        }`}
      >
        <Home
          className="w-6 h-6 stroke-[1.7]"
          fill={activeTab === 'feed' ? 'currentColor' : 'none'}
        />
      </button>

      {/* Search Tab */}
      <button
        type="button"
        onClick={() => setActiveTab('search')}
        title="Search"
        aria-label="Search"
        aria-current={activeTab === 'search' ? 'page' : undefined}
        className={`flex-1 h-full min-h-[44px] flex items-center justify-center cursor-pointer transition-colors bg-transparent border-0 ${
          activeTab === 'search'
            ? 'text-[var(--text,#17233A)]'
            : 'text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)]'
        }`}
      >
        <Search
          className="w-6 h-6 stroke-[1.7]"
          fill={activeTab === 'search' ? 'currentColor' : 'none'}
        />
      </button>

      {/* New Post Tab */}
      <button
        type="button"
        onClick={() => setActiveTab('post')}
        title="New post"
        aria-label="New post"
        aria-current={activeTab === 'post' ? 'page' : undefined}
        className={`flex-1 h-full min-h-[44px] flex items-center justify-center cursor-pointer transition-colors bg-transparent border-0 ${
          activeTab === 'post'
            ? 'text-[var(--text,#17233A)]'
            : 'text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)]'
        }`}
      >
        <PlusSquare
          className="w-6 h-6 stroke-[1.7]"
          fill={activeTab === 'post' ? 'currentColor' : 'none'}
        />
      </button>

      {/* Profile Tab */}
      <button
        type="button"
        onClick={() => setActiveTab('profile')}
        title="Profile"
        aria-label="Profile"
        aria-current={activeTab === 'profile' ? 'page' : undefined}
        className={`flex-1 h-full min-h-[44px] flex items-center justify-center cursor-pointer transition-colors bg-transparent border-0 ${
          activeTab === 'profile'
            ? 'text-[var(--text,#17233A)]'
            : 'text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)]'
        }`}
      >
        <User
          className="w-6 h-6 stroke-[1.7]"
          fill={activeTab === 'profile' ? 'currentColor' : 'none'}
        />
      </button>
    </nav>
  );
};
