import React, { useEffect, useState } from 'react';

/** Shown once the renewal time has come: confirm in one tap, or open Settings to change something. */
export const AcademicBanner: React.FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => {
  const [due, setDue] = useState<{ program_name: string | null; class_name: string | null; session: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me/academic')
      .then((r) => (r.ok ? (r.json() as Promise<{ confirm_due?: boolean; program_name: string | null; class_name: string | null; session: string | null }>) : null))
      .then((a) => { if (!cancelled && a?.confirm_due) setDue(a); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!due) return null;
  // Only offer one-tap confirmation when there is a program on record to confirm
  const known = due.program_name ? [due.program_name, due.class_name, due.session].filter(Boolean).join(', ') : '';
  const confirm = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/me/academic/confirm', { method: 'POST' });
      if (res.ok) setDue(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="region" aria-label="Confirm your academic details" className="m-3 p-3 rounded-[12px] border border-[var(--line,#E8EBF0)] bg-[var(--bg2,#F8F9FC)] space-y-2">
      <p className="m-0 text-[14px] text-[var(--text,#17233A)]">
        {known ? `Are you still in ${known}?` : 'Please add your program, class and session.'}
      </p>
      <div className="flex gap-2">
        {known && <button type="button" disabled={busy} onClick={() => void confirm()} className="min-h-[44px] px-4 rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[14px] font-semibold cursor-pointer border-0 disabled:opacity-50">Yes, nothing changed</button>}
        <button type="button" onClick={onOpenSettings} className="min-h-[44px] px-3.5 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer">{known ? 'Update' : 'Open Settings'}</button>
      </div>
    </div>
  );
};
