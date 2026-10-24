import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { MeResponse } from '../../shared/schema.ts';

interface AdminPageProps {
  currentUser: MeResponse;
  onBack: () => void;
  /** Called after a hand-over, when the signed-in admin has just stopped being one. */
  onLostAdmin: () => void;
}

interface Stats { users: number; posts: number; open_reports: number; media_bytes: number }
interface ReportItem { id: string; reporter_username: string; target_type: string; target_id: string; reason: string; status: string; created_at: string }
interface Preview { exists: boolean; text: string | null; author_id: string | null; author_username: string | null; status: string | null }
interface Person { id: string; username: string; display_name: string; role: string; status: string }
interface Action { id: string; action: string; detail: string | null; created_at: string; actor_username: string | null; target_username: string | null }

type Tab = 'reports' | 'people' | 'activity';
type Confirm =
  | { kind: 'status'; person: { id: string; username: string }; status: 'suspended' | 'banned' | 'active' }
  | { kind: 'appoint'; person: { id: string; username: string } };

const card = 'border border-[var(--line,#E8EBF0)] rounded-[12px] bg-[var(--bg,#fff)] p-4 space-y-3';
const ghost = 'min-h-[44px] px-3.5 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer hover:bg-[var(--bg2,#F8F9FC)] disabled:opacity-40';
const danger = 'min-h-[44px] px-3.5 rounded-[8px] border-0 bg-[var(--danger,#B23A40)] text-[var(--bg,#fff)] text-[13px] font-semibold cursor-pointer disabled:opacity-40';
const muted = 'text-[var(--muted,#5B6577)]';

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || 'Something went wrong');
  return body;
};
const post = (path: string, body: unknown) => api<{ your_role?: string }>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const ACTION_TEXT: Record<string, string> = {
  'status:suspended': 'suspended',
  'status:banned': 'banned',
  'status:active': 'reinstated',
  appoint: 'made an admin',
  'appoint:handover': 'handed the admin role to',
};

export const AdminPage: React.FC<AdminPageProps> = ({ currentUser, onBack, onLostAdmin }) => {
  const isMaster = currentUser.role === 'master';
  const me = currentUser.user.id;
  const [tab, setTab] = useState<Tab>('reports');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);
  const [reports, setReports] = useState<ReportItem[] | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [people, setPeople] = useState<Person[] | null>(null);
  const [query, setQuery] = useState('');
  const [actions, setActions] = useState<Action[] | null>(null);

  const fail = (e: unknown) => setNotice({ type: 'error', text: (e as Error).message });

  const loadStats = useCallback(() => { api<Stats>('/api/admin/stats').then(setStats).catch(() => {}); }, []);
  const loadReports = useCallback(() => {
    api<{ reports: ReportItem[] }>(`/api/admin/reports${onlyPending ? '?status=pending' : ''}`).then((b) => setReports(b.reports)).catch(fail);
  }, [onlyPending]);
  const loadPeople = useCallback((q: string) => {
    api<{ users: Person[] }>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((b) => setPeople(b.users)).catch(fail);
  }, []);
  const loadActions = useCallback(() => { api<{ actions: Action[] }>('/api/admin/actions').then((b) => setActions(b.actions)).catch(fail); }, []);

  // Opened from the bottom of Settings, so start at the top
  useEffect(() => { window.scrollTo(0, 0); }, []);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { if (tab === 'reports') loadReports(); }, [tab, loadReports]);
  // The search box reloads the list on submit, so this runs only when the tab opens
  useEffect(() => { if (tab === 'people') loadPeople(''); }, [tab, loadPeople]);
  useEffect(() => { if (tab === 'activity') loadActions(); }, [tab, loadActions]);

  const look = async (id: string) => {
    try { const p = await api<Preview>(`/api/admin/reports/${encodeURIComponent(id)}/preview`); setPreviews((m) => ({ ...m, [id]: p })); } catch (e) { fail(e); }
  };
  const setReportStatus = async (id: string, status: 'reviewed' | 'dismissed') => {
    try { await api(`/api/admin/reports/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); loadReports(); loadStats(); } catch (e) { fail(e); }
  };

  const openConfirm = (c: Confirm) => { setConfirm(c); setReason(''); setNotice(null); };
  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'status') {
        await post(`/api/admin/users/${encodeURIComponent(confirm.person.id)}/status`, { status: confirm.status, ...(reason.trim() ? { reason: reason.trim() } : {}) });
        setNotice({ type: 'success', text: `@${confirm.person.username} is now ${confirm.status === 'active' ? 'reinstated' : confirm.status}.` });
      } else {
        const res = await post('/api/admin/appoint', { user_id: confirm.person.id });
        setNotice({ type: 'success', text: `@${confirm.person.username} is now an admin.` });
        if (res.your_role === 'user') { setConfirm(null); onLostAdmin(); return; }
      }
      setConfirm(null);
      loadPeople(query); loadActions(); loadStats(); if (tab === 'reports') loadReports();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (id: Tab, label: string) => (
    <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setTab(id); setConfirm(null); }}
      className={`flex-1 min-h-[44px] rounded-[8px] border-0 text-[14px] cursor-pointer ${tab === id ? 'bg-[var(--tint,#EEF3FB)] text-[var(--text,#17233A)] font-semibold' : `bg-transparent ${muted} hover:bg-[var(--bg2,#F8F9FC)]`}`}>
      {label}
    </button>
  );

  const confirmPanel = confirm && (
    <div role="group" aria-label="Confirm" className={`${card} border-[var(--danger,#B23A40)]`}>
      <p className="m-0 text-[14px] text-[var(--text,#17233A)]">
        {confirm.kind === 'appoint'
          ? (isMaster
              ? <>Make <strong>@{confirm.person.username}</strong> an admin? You stay the master admin.</>
              : <>Make <strong>@{confirm.person.username}</strong> an admin? <strong>You stop being an admin the moment they become one.</strong></>)
          : confirm.status === 'banned'
            ? <>Ban <strong>@{confirm.person.username}</strong>? They are signed out, cannot sign in, and their posts are taken down. Only the master admin can undo a ban.</>
            : confirm.status === 'suspended'
              ? <>Suspend <strong>@{confirm.person.username}</strong>? They are signed out and cannot sign in until an admin reinstates them.</>
              : <>Reinstate <strong>@{confirm.person.username}</strong>?</>}
      </p>
      {confirm.kind === 'status' && confirm.status !== 'active' && (
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Reason (optional, kept in the activity log)" aria-label="Reason"
          className="w-full min-h-[44px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 text-[14px] text-[var(--text,#17233A)]" />
      )}
      <div className="flex gap-2">
        <button type="button" className={`${ghost} flex-1`} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className={`${confirm.kind === 'status' && confirm.status === 'active' ? ghost : danger} flex-1`} disabled={busy} onClick={() => void runConfirm()}>
          {busy ? 'Working...' : confirm.kind === 'appoint' ? 'Make admin' : confirm.status === 'banned' ? 'Ban' : confirm.status === 'suspended' ? 'Suspend' : 'Reinstate'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-content mx-auto min-h-screen bg-[var(--bg2,#F8F9FC)] pb-24 tablet:pb-8">
      <header className="sticky top-0 z-40 bg-[var(--bg,#fff)] h-[48px] border-b border-[var(--line,#E8EBF0)] flex items-center px-4">
        <button type="button" onClick={onBack} title="Back" aria-label="Back" className="w-[44px] h-[44px] -ml-3 flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent border-0">
          <ArrowLeft className="w-5 h-5 stroke-[1.7]" />
        </button>
        <h1 className="font-semibold text-[20px] text-[var(--text,#17233A)] tracking-[-0.3px] m-0">Admin</h1>
        <span className={`ml-auto text-[12px] ${muted}`}>{isMaster ? 'Master admin' : 'Admin'}</span>
      </header>

      <div className="p-3 space-y-3">
        {notice && <div role={notice.type === 'error' ? 'alert' : 'status'} className={`text-[13px] ${notice.type === 'error' ? 'text-[var(--danger,#B23A40)]' : 'text-[var(--text,#17233A)]'}`}>{notice.text}</div>}

        {stats && (
          <dl className="grid grid-cols-3 gap-2 m-0">
            {([['People', stats.users], ['Posts', stats.posts], ['Open reports', stats.open_reports]] as const).map(([label, n]) => (
              <div key={label} className={`${card} !p-3 text-center`}>
                <dd className="m-0 text-[20px] font-semibold text-[var(--text,#17233A)]">{n}</dd>
                <dt className={`text-[12px] ${muted}`}>{label}</dt>
              </div>
            ))}
          </dl>
        )}

        <div role="group" aria-label="Admin sections" className="flex gap-1">{tabBtn('reports', 'Reports')}{tabBtn('people', 'People')}{tabBtn('activity', 'Activity')}</div>

        {confirmPanel}

        {tab === 'reports' && (
          <section aria-label="Reports" className="space-y-3">
            <label className={`flex items-center gap-2 text-[13px] ${muted}`}>
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Only reports that still need a look
            </label>
            {reports === null && <p className={`m-0 text-[14px] ${muted}`}>Loading...</p>}
            {reports?.length === 0 && <p className={`m-0 text-[14px] ${muted}`}>No reports{onlyPending ? ' waiting' : ''}.</p>}
            {reports?.map((r) => {
              const p = previews[r.id];
              return (
                <article key={r.id} className={card} aria-label={`Report about a ${r.target_type}`}>
                  <p className="m-0 text-[14px] text-[var(--text,#17233A)]"><strong>{r.target_type}</strong> reported by @{r.reporter_username}: {r.reason}</p>
                  <p className={`m-0 text-[12px] ${muted}`}>{new Date(r.created_at).toLocaleString()} · {r.status}</p>
                  {p && (
                    <blockquote className="m-0 p-3 rounded-[8px] bg-[var(--bg2,#F8F9FC)] text-[14px] text-[var(--text,#17233A)] whitespace-pre-wrap break-words">
                      {!p.exists ? 'This is gone (deleted or expired).' : p.text || '(no text)'}
                      {p.author_username && <span className={`block mt-1 text-[12px] ${muted}`}>by @{p.author_username}</span>}
                    </blockquote>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {!p && <button type="button" className={ghost} onClick={() => void look(r.id)}>Look</button>}
                    <button type="button" className={ghost} onClick={() => void setReportStatus(r.id, 'reviewed')}>Reviewed</button>
                    <button type="button" className={ghost} onClick={() => void setReportStatus(r.id, 'dismissed')}>Dismiss</button>
                    {p?.author_id && p.author_id !== me && (
                      <>
                        <button type="button" className={ghost} onClick={() => openConfirm({ kind: 'status', person: { id: p.author_id!, username: p.author_username || 'user' }, status: 'suspended' })}>Suspend author</button>
                        <button type="button" className={ghost} onClick={() => openConfirm({ kind: 'status', person: { id: p.author_id!, username: p.author_username || 'user' }, status: 'banned' })}>Ban author</button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {tab === 'people' && (
          <section aria-label="People" className="space-y-3">
            <form role="search" onSubmit={(e) => { e.preventDefault(); loadPeople(query); }} className="flex gap-2">
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Username starts with..." aria-label="Search people by username"
                className="flex-1 min-w-0 min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 text-[14px] text-[var(--text,#17233A)]" />
              <button type="submit" className={ghost}>Search</button>
            </form>
            {people === null && <p className={`m-0 text-[14px] ${muted}`}>Loading...</p>}
            {people?.length === 0 && <p className={`m-0 text-[14px] ${muted}`}>Nobody found.</p>}
            <ul className="list-none m-0 p-0 space-y-2">
              {people?.map((p) => {
                const self = p.id === me;
                const isAdmin = p.role === 'admin';
                const canAct = !self && (!isAdmin || isMaster);
                const person = { id: p.id, username: p.username };
                return (
                  <li key={p.id} className={card}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-[var(--text,#17233A)]">@{p.username}</span>
                      <span className={`text-[13px] ${muted}`}>{p.display_name}</span>
                      {isAdmin && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[var(--tint,#EEF3FB)] text-[var(--text,#17233A)]">admin</span>}
                      {p.status !== 'active' && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[var(--danger-tint,#FBEAEA)] text-[var(--danger,#B23A40)]">{p.status}</span>}
                      {self && <span className={`text-[12px] ${muted}`}>(you)</span>}
                    </div>
                    {canAct && (
                      <div className="flex flex-wrap gap-2">
                        {p.status === 'active' && <button type="button" className={ghost} onClick={() => openConfirm({ kind: 'status', person, status: 'suspended' })}>Suspend</button>}
                        {p.status !== 'banned' && <button type="button" className={ghost} onClick={() => openConfirm({ kind: 'status', person, status: 'banned' })}>Ban</button>}
                        {(p.status === 'suspended' || (p.status === 'banned' && isMaster)) && <button type="button" className={ghost} onClick={() => openConfirm({ kind: 'status', person, status: 'active' })}>Reinstate</button>}
                        {p.status === 'active' && !isAdmin && <button type="button" className={ghost} onClick={() => openConfirm({ kind: 'appoint', person })}>Make admin</button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {tab === 'activity' && (
          <section aria-label="Activity" className="space-y-2">
            {actions === null && <p className={`m-0 text-[14px] ${muted}`}>Loading...</p>}
            {actions?.length === 0 && <p className={`m-0 text-[14px] ${muted}`}>Nothing yet.</p>}
            <ul className="list-none m-0 p-0 space-y-2">
              {actions?.map((a) => (
                <li key={a.id} className={`${card} !p-3`}>
                  <p className="m-0 text-[14px] text-[var(--text,#17233A)]">
                    <strong>{a.actor_username === 'master admin' ? 'The master admin' : a.actor_username ? `@${a.actor_username}` : 'Someone'}</strong> {ACTION_TEXT[a.action] ?? a.action} {a.target_username ? `@${a.target_username}` : ''}
                  </p>
                  {a.detail && <p className={`m-0 text-[13px] ${muted}`}>{a.detail}</p>}
                  <p className={`m-0 text-[12px] ${muted}`}>{new Date(a.created_at).toLocaleString()}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
};
