import React, { useEffect, useState } from 'react';
import { PROGRAMS, isValidSession, cleanSection } from '../../shared/academic.ts';

export interface AcademicInfo {
  program: string | null;
  program_name: string | null;
  session: string | null;
  section: string | null;
  class_id: string | null;
  class_name: string | null;
  status: 'current' | 'graduated';
  confirm_due: boolean;
}

const field = 'w-full min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 py-2 text-[15px] text-[var(--text,#17233A)]';
const label = 'block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1';
const primary = 'min-h-[44px] px-4 rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[14px] font-semibold disabled:opacity-50 cursor-pointer border-0';
const ghost = 'min-h-[44px] px-3.5 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer disabled:opacity-40';

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

/** Program, session, class/year and section: update them as you move up, confirm them, or mark yourself as graduated. */
export const AcademicCard: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [info, setInfo] = useState<AcademicInfo | null>(null);
  const [classes, setClasses] = useState<Array<{ id: string; name: string }>>([]);
  const [program, setProgram] = useState('');
  const [session, setSession] = useState('');
  const [classId, setClassId] = useState('');
  const [section, setSection] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [askGraduate, setAskGraduate] = useState(false);

  const apply = (a: AcademicInfo) => {
    setInfo(a);
    setProgram(a.program ?? '');
    setSession(a.session ?? '');
    setClassId(a.class_id ?? '');
    setSection(a.section ?? '');
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch('/api/me/academic').then((r) => (r.ok ? r.json() : null)), fetch('/api/classes').then((r) => (r.ok ? r.json() : { classes: [] }))])
      .then(([a, c]) => {
        if (cancelled) return;
        if (a) apply(a as AcademicInfo);
        setClasses((c as { classes?: Array<{ id: string; name: string }> }).classes ?? []);
      })
      .catch(() => !cancelled && setNote({ type: 'error', text: 'Could not load your academic details.' }));
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;
  const graduated = info.status === 'graduated';
  const valid = !!program && isValidSession(session.trim()) && !!classId && cleanSection(section) !== null;

  const run = async (fn: () => Promise<AcademicInfo>, ok: string) => {
    setBusy(true);
    setNote(null);
    try {
      apply(await fn());
      setNote({ type: 'ok', text: ok });
      onChanged?.();
    } catch (e) {
      setNote({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
      setAskGraduate(false);
    }
  };

  return (
    <section aria-labelledby="set-academic" className="border border-[var(--line,#E8EBF0)] rounded-[12px] bg-[var(--bg,#fff)] p-4 space-y-3">
      <h2 id="set-academic" className="m-0 text-[15px] font-semibold text-[var(--text,#17233A)]">Academic details</h2>
      {graduated ? (
        <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]">You are marked as graduated. Your posts and messages are kept.</p>
      ) : (
        <>
          {info.confirm_due && (
            <p role="status" className="m-0 text-[13px] text-[var(--text,#17233A)]">Please check these are still right, then confirm or save changes.</p>
          )}
          <div>
            <label htmlFor="acad-program" className={label}>Program</label>
            <select id="acad-program" value={program} onChange={(e) => setProgram(e.target.value)} className={`${field} cursor-pointer`}>
              <option value="">Choose your program</option>
              {PROGRAMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="acad-class" className={label}>Class</label>
            <select id="acad-class" value={classId} onChange={(e) => setClassId(e.target.value)} className={`${field} cursor-pointer`}>
              <option value="">Choose your class</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="acad-session" className={label}>Session</label>
            <input id="acad-session" type="text" inputMode="numeric" maxLength={9} placeholder="2024-2026" value={session} onChange={(e) => setSession(e.target.value.replace(/[^0-9-]/g, ''))} className={field} />
          </div>
          <div>
            <label htmlFor="acad-section" className={label}>Section (optional)</label>
            <input id="acad-section" type="text" maxLength={10} value={section} onChange={(e) => setSection(e.target.value.replace(/[^A-Za-z0-9 -]/g, ''))} className={field} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !valid} className={primary}
              onClick={() => void run(() => send<AcademicInfo>('PUT', '/api/me/academic', { program, session: session.trim(), class_id: classId, ...(section.trim() ? { section: section.trim() } : {}) }), 'Saved.')}>
              Save changes
            </button>
            {info.program && (
              <button type="button" disabled={busy} className={ghost} onClick={() => void run(() => send<AcademicInfo>('POST', '/api/me/academic/confirm'), 'Confirmed.')}>
                Nothing has changed
              </button>
            )}
            {!askGraduate && <button type="button" disabled={busy} className={ghost} onClick={() => setAskGraduate(true)}>I have graduated</button>}
          </div>
          {askGraduate && (
            <div role="group" aria-label="Confirm graduation" className="space-y-2">
              <p className="m-0 text-[13px] text-[var(--text,#17233A)]">Your account moves to Alumni. Nothing you posted or sent is deleted. You cannot undo this yourself.</p>
              <div className="flex gap-2">
                <button type="button" disabled={busy} className={primary} onClick={() => void run(() => send<AcademicInfo>('POST', '/api/me/academic/graduate'), 'Your account is now marked as graduated.')}>Yes, I have graduated</button>
                <button type="button" className={ghost} onClick={() => setAskGraduate(false)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {note && <p role={note.type === 'error' ? 'alert' : 'status'} className={`m-0 text-[13px] ${note.type === 'error' ? 'text-[var(--danger,#B23A40)]' : 'text-[var(--text,#17233A)]'}`}>{note.text}</p>}
    </section>
  );
};
