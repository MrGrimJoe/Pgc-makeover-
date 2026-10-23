import React, { useEffect, useRef, useState } from 'react';
import type { ClassRow, MeResponse, SignupSessionResponse } from '../../shared/schema.ts';
import { CampusPicker, type CampusChoice } from '../components/CampusPicker.tsx';
import { Avatar } from '../components/Avatar.tsx';

interface OnboardingPageProps {
  /** Called once the account exists (and the optional photo step is finished or skipped). */
  onComplete: () => void;
  /** Called when the sign-up session has expired and the person must start again. */
  onRestart: () => void;
}

type UsernameState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available' }
  | { status: 'unavailable'; message: string };

const fieldClass =
  'w-full min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 py-2 text-[15px] text-[var(--text,#17233A)]';
const labelClass = 'block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1';
const primaryButton =
  'w-full min-h-[44px] rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[14px] font-semibold disabled:opacity-50 cursor-pointer border-0';
const secondaryButton =
  'w-full min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[14px] font-semibold disabled:opacity-50 cursor-pointer';

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|_(?=[a-z0-9])){1,18}[a-z0-9]$/;

export const OnboardingPage: React.FC<OnboardingPageProps> = ({ onComplete, onRestart }) => {
  const [session, setSession] = useState<'loading' | 'ready' | 'expired'>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);

  const [realName, setRealName] = useState('');
  const [username, setUsername] = useState('');
  const [campus, setCampus] = useState<CampusChoice | null>(null);
  const [classId, setClassId] = useState('');
  const [roll, setRoll] = useState('');
  const [usernameState, setUsernameState] = useState<UsernameState>({ status: 'idle' });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 2 (after the account exists): optional profile photo
  const [created, setCreated] = useState<MeResponse | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/signup/session');
        if (!res.ok) throw new Error('expired');
        const data = (await res.json()) as SignupSessionResponse;
        if (cancelled) return;
        setRealName(data.suggested_name || '');
        setEmail(data.email);
        setSession('ready');
        const cls = await fetch('/api/classes');
        if (cls.ok && !cancelled) {
          const body = (await cls.json()) as { classes?: ClassRow[] };
          setClasses(body.classes || []);
        }
      } catch {
        if (!cancelled) setSession('expired');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live "is this username free?" check
  useEffect(() => {
    if (!username) {
      setUsernameState({ status: 'idle' });
      return;
    }
    if (!USERNAME_PATTERN.test(username)) {
      setUsernameState({
        status: 'unavailable',
        message: '3 to 20 lowercase letters, numbers or single underscores',
      });
      return;
    }
    setUsernameState({ status: 'checking' });
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/username-available?u=${encodeURIComponent(username)}`, { signal: controller.signal });
        if (res.status === 429) {
          setUsernameState({ status: 'idle' });
          return;
        }
        const data = (await res.json()) as { available?: boolean; message?: string };
        setUsernameState(
          data.available ? { status: 'available' } : { status: 'unavailable', message: data.message || 'Username is not available' }
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setUsernameState({ status: 'idle' });
      }
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [username]);

  const formValid =
    realName.trim().length >= 2 &&
    USERNAME_PATTERN.test(username) &&
    usernameState.status !== 'unavailable' &&
    !!campus &&
    !!classId &&
    /^[0-9]{3}$/.test(roll);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid || !campus || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/signup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          real_name: realName.trim(),
          username,
          ...(campus.campus ? { campus_id: campus.campus.id } : { campus_other: campus.other }),
          class_id: classId,
          roll_last3: roll,
        }),
      });
      const data = (await res.json()) as {
        me?: MeResponse;
        error?: string;
        issues?: Array<{ message?: string }>;
      };
      if (res.status === 401) {
        setSession('expired');
        return;
      }
      if (!res.ok || !data.me) {
        throw new Error(data.issues?.[0]?.message || data.error || 'Could not create your account');
      }
      setCreated(data.me);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const up = await fetch('/api/media/uploads', { method: 'POST', body: form });
      const upData = (await up.json()) as { id?: string; media?: { id?: string }; error?: string };
      const mediaId = upData.id ?? upData.media?.id;
      if (!up.ok || !mediaId) throw new Error(upData.error || 'Could not upload that photo');
      const patch = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_media_id: mediaId }),
      });
      if (!patch.ok) {
        const body = (await patch.json()) as { error?: string };
        throw new Error(body.error || 'Could not save your photo');
      }
      setPhotoId(mediaId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  if (session === 'loading') {
    return (
      <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-20 px-4" aria-busy="true">
        <div className="w-40 h-5 skeleton-box rounded mx-auto" />
      </div>
    );
  }

  if (session === 'expired') {
    return (
      <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-20 px-4 text-center space-y-4">
        <h1 className="text-[18px] font-semibold text-[var(--text,#17233A)]">Your sign-up session ended</h1>
        <p className="text-[14px] text-[var(--muted,#5B6577)]">For your safety it only lasts 15 minutes. Start again to continue.</p>
        <button type="button" onClick={onRestart} className={primaryButton}>
          Start again
        </button>
      </div>
    );
  }

  if (created) {
    return (
      <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-12 px-4 space-y-5 text-center">
        <h1 className="text-[18px] font-semibold text-[var(--text,#17233A)]">Add a profile photo</h1>
        <p className="text-[14px] text-[var(--muted,#5B6577)]">
          Other students see it next to your name. You can change it any time.
        </p>
        <div className="flex justify-center">
          <Avatar mediaId={photoId} displayName={created.profile.display_name} username={created.profile.username} size={96} />
        </div>
        <input
          ref={fileRef}
          id="onboarding-photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Choose a profile photo"
          className="sr-only"
          onChange={(e) => handlePhoto(e.target.files?.[0])}
        />
        {error && (
          <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">
            {error}
          </p>
        )}
        <div className="space-y-2.5">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className={photoId ? secondaryButton : primaryButton}>
            {uploading ? 'Uploading...' : photoId ? 'Choose a different photo' : 'Choose a photo'}
          </button>
          <button type="button" onClick={onComplete} className={photoId ? primaryButton : secondaryButton}>
            {photoId ? 'Done' : 'Skip for now'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-8 px-4">
      <h1 className="text-[20px] font-semibold text-[var(--text,#17233A)]">Create your account</h1>
      <p className="mt-1 mb-5 text-[14px] text-[var(--muted,#5B6577)]">
        {email ? `Signing up as ${email}.` : 'Tell us a little about you.'}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="signup-real-name" className={labelClass}>
            Your real name
          </label>
          <input
            id="signup-real-name"
            type="text"
            autoComplete="name"
            maxLength={60}
            value={realName}
            onChange={(e) => setRealName(e.target.value)}
            aria-describedby="signup-real-name-help"
            className={fieldClass}
          />
          <p id="signup-real-name-help" className="mt-1 text-[12px] text-[var(--muted,#5B6577)]">
            Shown on your profile page only. Posts and messages use your username.
          </p>
        </div>

        <div>
          <label htmlFor="signup-username" className={labelClass}>
            Username
          </label>
          <input
            id="signup-username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={20}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
            aria-describedby="signup-username-status"
            aria-invalid={usernameState.status === 'unavailable'}
            className={`${fieldClass} font-mono`}
          />
          <p
            id="signup-username-status"
            role="status"
            aria-live="polite"
            className={`mt-1 text-[12px] min-h-[16px] ${
              usernameState.status === 'unavailable' ? 'text-[var(--danger,#B23A40)]' : 'text-[var(--muted,#5B6577)]'
            }`}
          >
            {usernameState.status === 'checking' && 'Checking...'}
            {usernameState.status === 'available' && `@${username} is available`}
            {usernameState.status === 'unavailable' && usernameState.message}
          </p>
        </div>

        <CampusPicker id="signup-campus" label="Campus" value={campus} onChange={setCampus} />

        <div>
          <label htmlFor="signup-class" className={labelClass}>
            Class
          </label>
          <select
            id="signup-class"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className={`${fieldClass} cursor-pointer`}
          >
            <option value="">Choose your class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="signup-roll" className={labelClass}>
            Last three digits of your roll number
          </label>
          <input
            id="signup-roll"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]{3}"
            maxLength={3}
            value={roll}
            onChange={(e) => setRoll(e.target.value.replace(/\D/g, '').slice(0, 3))}
            aria-describedby="signup-roll-help"
            className={`${fieldClass} font-mono tracking-widest`}
          />
          <p id="signup-roll-help" className="mt-1 text-[12px] text-[var(--muted,#5B6577)]">
            Used to place you in your class. Never shown to anyone.
          </p>
        </div>

        {error && (
          <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">
            {error}
          </p>
        )}

        <button type="submit" disabled={!formValid || submitting} className={primaryButton}>
          {submitting ? 'Creating account...' : 'Create account'}
        </button>
      </form>
    </div>
  );
};
