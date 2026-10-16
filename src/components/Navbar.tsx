import React from 'react';
import { MessageSquare } from 'lucide-react';

interface NavbarProps {
  onTitleClick?: () => void;
  onOpenMessages?: () => void;
  appName?: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  onTitleClick,
  onOpenMessages,
  appName = 'Dialtone',
}) => {
  return (
    <header className="sticky top-0 z-40 bg-[var(--bg,#fff)] h-[48px] border-b border-[var(--line,#E8EBF0)] flex items-center justify-between px-4">
      <button
        type="button"
        onClick={onTitleClick}
        className="font-semibold text-[20px] text-[var(--text,#17233A)] tracking-[-0.3px] hover:opacity-85 transition-opacity cursor-pointer bg-transparent border-0 p-0"
      >
        {appName}
      </button>

      <button
        type="button"
        onClick={onOpenMessages}
        title="Messages"
        aria-label="Messages"
        className="w-[44px] h-[44px] min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text,#17233A)] hover:text-[var(--blue,#244C8A)] transition-colors cursor-pointer bg-transparent border-0 -mr-2"
      >
        <MessageSquare className="w-6 h-6 stroke-[1.7]" />
      </button>
    </header>
  );
};
