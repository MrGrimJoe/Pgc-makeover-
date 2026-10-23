import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';

interface SignInPageProps {
  onSuccessRedirect?: () => void;
  /** Message to show above the buttons, e.g. after a failed log in. */
  notice?: 'no_account' | 'error' | null;
}

const NOTICES: Record<'no_account' | 'error', string> = {
  no_account: 'We could not find an account for that Google account. Sign up to create one.',
  error: 'Something went wrong signing you in. Please try again.',
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
