import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';

interface SignInPageProps {
  onSuccessRedirect?: () => void;
}

export const SignInPage: React.FC<SignInPageProps> = () => {
  const [loading, setLoading] = useState<string | null>(null);

  const handleGoogleSignIn = (mock = false) => {
    setLoading(mock ? 'mock' : 'real');
    const url = mock ? '/api/auth/google?mock=true' : '/api/auth/google';
    window.location.href = url;
  };

  return (
    <div className="w-full max-w-[360px] mx-auto py-20 px-4">
      <div className="space-y-6 text-center">
        {/* Minimal branding */}
        <div className="space-y-1">
          <span className="text-[20px] font-semibold text-text tracking-tight block">
            Dialtone
          </span>
          <p className="text-[14px] text-text-muted">
            Sign in with your student account.
          </p>
        </div>

        {/* Actions */}
        <div className="space-y-2.5 pt-1">
          <button
            type="button"
            onClick={() => handleGoogleSignIn(false)}
            disabled={loading !== null}
            className="w-full min-h-[44px] px-4 rounded-sm bg-primary hover:bg-primary-hover text-on-primary font-semibold text-[14px] flex items-center justify-center space-x-2 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span>{loading === 'real' ? 'Connecting...' : 'Continue with Google'}</span>
            <ArrowRight className="w-4 h-4 ml-1" />
          </button>

          {/* DEV-ONLY: remove before launch */}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => handleGoogleSignIn(true)}
              disabled={loading !== null}
              className="w-full min-h-[44px] px-4 rounded-sm border border-border bg-surface hover:bg-bg text-text-muted hover:text-text text-[13px] font-medium flex items-center justify-center transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span>{loading === 'mock' ? 'Signing in...' : 'Sign in as test user'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
