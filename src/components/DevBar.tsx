// DEV-ONLY: remove before launch
import React from 'react';
import type { MeResponse } from '../../shared/schema.ts';
import { useLayout } from '../lib/layout.ts';

interface DevBarProps {
  currentUser: MeResponse | null;
  onLogout: () => Promise<void>;
}

// DEV-ONLY: remove before launch
const SEEDED_DEV_USERS = [
  'alice', 'bob', 'charlie', 'dave', 'emma', 'fiona',
  'george', 'hannah', 'ian', 'julia', 'kevin', 'laura',
];

export const DevBar: React.FC<DevBarProps> = ({ currentUser, onLogout }) => {
  const layout = useLayout();
  // DEV-ONLY: remove before launch
  // Completely omitted in production builds via Vite dead-code elimination
  if (!import.meta.env.DEV) {
    return null;
  }

  const handleDevSignIn = () => {
    window.location.href = '/api/auth/google?mock=true';
  };

  const handleSwitchUser = (username: string) => {
    if (!username) return;
    window.location.href = `/api/auth/google?mock=true&as=${encodeURIComponent(username)}`;
  };

  return (
    // DEV-ONLY: remove before launch
    <div
      role="region"
      aria-label="Development Toolbar"
      className={`fixed ${currentUser && layout === 'phone' ? 'bottom-12' : 'bottom-0'} left-0 right-0 z-50 bg-[#F2C94C] text-[#17233A] border-t border-[#17233A]/20 px-3 py-1 text-[12px] font-sans flex flex-wrap items-center justify-between gap-2`}
    >
      <div className="flex items-center space-x-2">
        <span className="font-semibold px-1.5 py-0.5 bg-[#17233A] text-[#F2C94C] rounded text-[11px] uppercase tracking-wider">
          DEV
        </span>
        <span className="font-medium hidden sm:inline text-[11px]">
          Development mode
        </span>
      </div>

      <div className="flex items-center space-x-2">
        {/* DEV-ONLY: seeded user switcher dropdown */}
        <div className="flex items-center space-x-1">
          <label htmlFor="dev-user-select" className="sr-only">Switch User</label>
          <select
            id="dev-user-select"
            aria-label="Switch Dev User"
            value={currentUser?.profile.username || ''}
            onChange={(e) => handleSwitchUser(e.target.value)}
            className="px-1.5 py-0.5 rounded bg-white text-[#17233A] border border-[#17233A]/30 text-[11px] font-medium cursor-pointer"
          >
            <option value="" disabled>Switch user...</option>
            {SEEDED_DEV_USERS.map((u) => (
              <option key={u} value={u}>
                @{u} {currentUser?.profile.username === u ? '(current)' : ''}
              </option>
            ))}
          </select>
        </div>

        {currentUser ? (
          <>
            <span className="text-[11px]">
              @{currentUser.profile.username}
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="px-2 py-0.5 rounded bg-[#17233A] text-white hover:bg-[#17233A]/80 font-semibold transition-colors cursor-pointer text-[11px]"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleDevSignIn}
            className="px-2 py-0.5 rounded bg-[#17233A] text-white hover:bg-[#17233A]/80 font-semibold transition-colors cursor-pointer text-[11px]"
          >
            Sign in as test user
          </button>
        )}
      </div>
    </div>
  );
};
