// DEV-ONLY: remove before launch
import React from 'react';
import type { MeResponse } from '../../shared/schema.ts';

interface DevBarProps {
  currentUser: MeResponse | null;
  onLogout: () => Promise<void>;
}

export const DevBar: React.FC<DevBarProps> = ({ currentUser, onLogout }) => {
  // DEV-ONLY: remove before launch
  // Completely omitted in production builds via Vite dead-code elimination
  if (!import.meta.env.DEV) {
    return null;
  }

  const handleDevSignIn = () => {
    window.location.href = '/api/auth/google?mock=true';
  };

  return (
    // DEV-ONLY: remove before launch
    <div
      role="region"
      aria-label="Development Toolbar"
      className={`fixed ${currentUser ? 'bottom-12' : 'bottom-0'} left-0 right-0 z-50 bg-[#F2C94C] text-[#17233A] border-t border-[#17233A]/20 px-3 py-1 text-[12px] font-sans flex flex-wrap items-center justify-between gap-2`}
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
