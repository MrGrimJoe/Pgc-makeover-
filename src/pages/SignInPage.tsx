import React, { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';

interface SignInPageProps {
  onSuccessRedirect?: () => void;
  /** Message to show above the buttons, e.g. after a failed log in. */
  notice?: SignInNotice | null;
}

export type SignInNotice = 'no_account' | 'error' | 'suspended' | 'banned';

const NOTICES: Record<SignInNotice, string> = {
  no_account: 'We could not find an account for that Google account. Sign up to create one.',
  error: 'Something went wrong signing you in. Please try again.',
  suspended: 'This account is suspended for now, so you cannot sign in. Contact the people who run the app if you think this is a mistake.',
  banned: 'This account has been banned, so you cannot sign in.',
};

interface MyAppeal { status: 'open' | 'granted' | 'denied'; decision_note: string }

/** Lets a suspended or banned student ask for a review. Works only right after they tried to sign in (a short-lived ticket). */
export const AppealForm: React.FC = () => {
  const [state, setState] = useState<'loading' | 'unavailable' | 'ready'>('loading');
  const [appeal, setAppeal] = useState<MyAppeal | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/appeals/mine')
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setState('unavailable');
        const body = (await res.json()) as { appeal: MyAppeal | null };
        setAppeal(body.appeal);
        setState('ready');
      })
      .catch(() => !cancelled && setState('unavailable'));
    return () => { cancelled = true; };
  }, []);

  if (state === 'loading') return null;
  if (state === 'unavailable') {
    return <p className="text-[12px] text-left text-[var(--muted,#5B6577)]">To ask for a review, tap Log in with Google again and the request form will appear here.</p>;
  }
  if (appeal?.status === 'open') return <p role="status" className="text-[13px] text-left text-[var(--text,#17233A)]">Your request is waiting for an administrator.</p>;
  if (appeal?.status === 'denied') return <p role="status" className="text-[13px] text-left text-[var(--text,#17233A)]">Your request was reviewed and the account stays blocked.{appeal.decision_note ? ` Note: ${appeal.decision_note}` : ''}</p>;
  if (appeal?.status === 'granted') return <p role="status" className="text-[13px] text-left text-[var(--text,#17233A)]">Your request was approved. Log in with Google again.</p>;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/appeals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: message.trim() }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'Could not send your request');
      setAppeal({ status: 'open', decision_note: '' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className="space-y-2 text-left">
      <label htmlFor="appeal-message" className="block text-[13px] font-medium text-[var(--muted,#5B6577)]">Ask for a review (what happened?)</label>
      <textarea id="appeal-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={4}
        className="w-full bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 py-2 text-[15px] text-[var(--text,#17233A)]" />
      {error && <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">{error}</p>}
      <button type="submit" disabled={busy || !message.trim()} className="w-full min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[14px] font-semibold cursor-pointer disabled:opacity-50">
        {busy ? 'Sending...' : 'Send request'}
      </button>
    </form>
  );
};

export const SignInPage: React.FC<SignInPageProps> = ({ notice = null }) => {
  const [loading, setLoading] = useState<string | null>(null);

  const start = (intent: 'login' | 'signup', mock = false) => {
    setLoading(`${intent}${mock ? '-mock' : ''}`);
    const params = new URLSearchParams({ intent });
    if (mock) params.set('mock', 'true');
    window.location.href = `/api/auth/google?${params.toString()}`;
  };

  return (
    <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-20 tablet:py-10 px-4">
      <div className="space-y-6 text-center">
        {/* Minimal branding */}
        <div className="space-y-1">
          <h1 className="text-[20px] font-semibold text-[var(--text,#17233A)] tracking-tight">Dialtone</h1>
          <p className="text-[14px] text-[var(--muted,#5B6577)]">Log in or create your student account.</p>
        </div>

        {notice && (
          <p role="alert" className="text-[13px] text-left rounded-[8px] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] p-3">
            {NOTICES[notice]}
          </p>
        )}
        {(notice === 'suspended' || notice === 'banned') && <AppealForm />}

        {/* Actions */}
        <div className="space-y-2.5 pt-1">
          <button
            type="button"
            onClick={() => start('login')}
            disabled={loading !== null}
            className="w-full min-h-[44px] px-4 rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] font-semibold border-0 text-[14px] flex items-center justify-center space-x-2 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span>{loading === 'login' ? 'Connecting...' : 'Log in with Google'}</span>
            <ArrowRight className="w-4 h-4 ml-1" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => start('signup')}
            disabled={loading !== null}
            className="w-full min-h-[44px] px-4 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] font-semibold text-[14px] flex items-center justify-center transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span>{loading === 'signup' ? 'Connecting...' : 'Sign up with Google'}</span>
          </button>

          {/* DEV-ONLY: remove before launch */}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => start('signup', true)}
              disabled={loading !== null}
              className="w-full min-h-[44px] px-4 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--muted,#5B6577)] text-[13px] font-medium flex items-center justify-center transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span>{loading === 'signup-mock' ? 'Signing up...' : 'Sign up as test user'}</span>
            </button>
          )}
        </div>

        <p className="text-[12px] text-[var(--muted,#5B6577)]">
          New here? Choose Sign up. You will pick a username, your campus and class.
        </p>
      </div>
    </div>
  );
};
