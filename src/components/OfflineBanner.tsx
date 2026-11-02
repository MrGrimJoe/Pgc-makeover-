import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/** A quiet strip shown while the device has no connection. Reading saved posts keeps working; sending waits. */
export const OfflineBanner: React.FC = () => {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2 px-4 py-2 text-[0.8rem] bg-[var(--bg2,#F8F9FC)] text-[var(--text,#17233A)] border-b border-[var(--line,#E8EBF0)]">
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>You're offline. Saved posts are still here; posting, messages and refreshing wait for a connection.</span>
    </div>
  );
};
