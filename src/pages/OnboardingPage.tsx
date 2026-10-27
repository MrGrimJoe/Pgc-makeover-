import React, { useEffect, useRef, useState } from 'react';
import type { ClassRow, MeResponse, SignupSessionResponse } from '../../shared/schema.ts';
import { CampusPicker, type CampusChoice } from '../components/CampusPicker.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { compareCard, describeCheck, hasMismatch, type PrintedCheck } from '../../shared/card-match.ts';
import { readCardText } from '../lib/cardOcr.ts';
import { CardScanner } from '../components/CardScanner.tsx';
import { ACCEPTED_TYPES, prefersPhotoUpload, readCardPhoto } from '../lib/cardPhoto.ts';
import { TurnstileWidget } from '../components/TurnstileWidget.tsx';
import { PROGRAMS, cleanSection, isValidSession } from '../../shared/academic.ts';
import { ROLL_INPUT_PATTERN, barcodeMatchesRoll, isUsableRoll, normalizeRoll } from '../../shared/roll.ts';

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

const PrintedSummary: React.FC<{ check: PrintedCheck; confirmed: boolean; onConfirm: (v: boolean) => void }> = ({ check, confirmed, onConfirm }) => {
  const d = describeCheck(check);
  const bad = hasMismatch(check);
  return (
    <div className="mt-1 space-y-1 text-[13px] text-[var(--text,#17233A)]">
      {d.ok.length > 0 && <p role="status" className="m-0">The printed {d.ok.join(', ')} on your card look right.</p>}
      {d.check.length > 0 && (
        <p role={bad ? 'alert' : 'status'} className={`m-0 ${bad ? 'text-[var(--danger,#B23A40)]' : ''}`}>
          {bad ? 'The printed ' : 'Could not be sure about the printed '}{d.check.join(', ')}{bad ? ' on your card do not seem to match what you typed.' : '.'} Reading a card can go wrong, so check what you typed, or scan again with better light.
        </p>
      )}
      {d.unread.length > 0 && <p className="m-0 text-[var(--muted,#5B6577)]">Could not read the printed {d.unread.join(', ')}.</p>}
      {bad && (
        <label className="flex items-start gap-2 min-h-[44px] cursor-pointer">
          <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} className="mt-1" />
          <span>I checked, and what I typed is correct.</span>
        </label>
      )}
    </div>
  );
};

export const OnboardingPage: React.FC<OnboardingPageProps> = ({ onComplete, onRestart }) => {
  const [session, setSession] = useState<'loading' | 'ready' | 'expired'>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);

  const [realName, setRealName] = useState('');
  const [username, setUsername] = useState('');
  const [campus, setCampus] = useState<CampusChoice | null>(null);
  const [classId, setClassId] = useState('');
  const [program, setProgram] = useState('');
  const [acadSession, setAcadSession] = useState('');
  const [section, setSection] = useState('');
  const [roll, setRoll] = useState('');
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // Laptops and desktops get "upload a photo of your card" instead of the camera scanner (decided once per visit)
  const [uploadMode] = useState(prefersPhotoUpload);
  const [cardSource, setCardSource] = useState<'camera' | 'upload'>('camera');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const cardFileRef = useRef<HTMLInputElement>(null);
  const [printed, setPrinted] = useState<PrintedCheck | 'reading' | null>(null);
  const [mismatchOk, setMismatchOk] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
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
        setSiteKey(data.turnstile_site_key ?? null);
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
    !!program &&
    isValidSession(acadSession.trim()) &&
    cleanSection(section) !== null &&
    (!siteKey || !!turnstileToken) &&
    printed !== 'reading' &&
    (!printed || !hasMismatch(printed) || mismatchOk) &&
    ROLL_INPUT_PATTERN.test(roll.trim()) &&
    isUsableRoll(normalizeRoll(roll)) &&
    // The card is not optional: no scan (or picture) blocks sign-up, and so does a barcode that disagrees with the roll number.
    (scannedBarcode ? barcodeMatchesRoll(scannedBarcode, roll) : false);

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
          program,
          session: acadSession.trim(),
          ...(section.trim() ? { section: section.trim() } : {}),
          roll_number: roll.trim(),
          ...(scannedBarcode ? { card: { barcode: scannedBarcode, ...(cardSource === 'upload' ? { source: 'upload' as const } : {}), ...(typeof printed === 'object' && printed ? { printed } : {}) } } : {}),
          ...(siteKey && turnstileToken ? { turnstile_token: turnstileToken } : {}),
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
      if (siteKey) setTurnstileReset((n) => n + 1); // a check can be used once
    } finally {
      setSubmitting(false);
    }
  };

  /** A barcode was read, from the camera or from a picture. Then the printed text is read on this device and compared. */
  const handleCardRead = (text: string, frame: HTMLCanvasElement | undefined, source: 'camera' | 'upload') => {
    setScannedBarcode(text);
    setCardSource(source);
    setScanning(false);
    setError(null);
    setPhotoProblem(null);
    setMismatchOk(false);
    setPrinted(null);
    if (!frame || !campus) return;
    // Read the printed text on this device, then compare. A failure just means "could not read".
    setPrinted('reading');
    const typed = { name: realName, campusName: campus.campus ? campus.campus.name : campus.other, program, session: acadSession.trim() };
    void readCardText(frame).then((t) => {
      setPrinted(compareCard(t, typed));
      frame.width = 0; // the picture is dropped; nothing keeps it
    });
  };

  /** A picture of the card was chosen or dropped (laptop). Rejected pictures say why; nothing is uploaded either way. */
  const handleCardPicture = async (file: File | undefined) => {
    if (!file || photoBusy) return;
    setPhotoBusy(true);
    setPhotoProblem(null);
    setScannedBarcode(null);
    setPrinted(null);
    try {
      const result = await readCardPhoto(file);
      if (result.ok) handleCardRead(result.barcode, result.frame, 'upload');
      else setPhotoProblem(result.message);
    } finally {
      setPhotoBusy(false);
      if (cardFileRef.current) cardFileRef.current.value = ''; // the same file can be chosen again
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
      <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-20 tablet:py-10 px-4" aria-busy="true">
        <div className="w-40 h-5 skeleton-box rounded mx-auto" />
      </div>
    );
  }

  if (session === 'expired') {
    return (
      <div className="w-full max-w-[360px] mx-auto tablet:my-16 tablet:px-8 tablet:bg-[var(--bg,#fff)] tablet:border tablet:border-[var(--line,#E8EBF0)] tablet:rounded-[16px] py-20 tablet:py-10 px-4 text-center space-y-4">
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
          <label htmlFor="signup-program" className={labelClass}>
            Program
          </label>
          <select id="signup-program" value={program} onChange={(e) => setProgram(e.target.value)} className={`${fieldClass} cursor-pointer`}>
            <option value="">Choose your program</option>
            {PROGRAMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="signup-session" className={labelClass}>
            Session
          </label>
          <input
            id="signup-session"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={9}
            placeholder="2024-2026"
            value={acadSession}
            onChange={(e) => setAcadSession(e.target.value.replace(/[^0-9-]/g, ''))}
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor="signup-section" className={labelClass}>
            Section (optional)
          </label>
          <input
            id="signup-section"
            type="text"
            autoComplete="off"
            maxLength={10}
            value={section}
            onChange={(e) => setSection(e.target.value.replace(/[^A-Za-z0-9 -]/g, ''))}
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor="signup-roll" className={labelClass}>
            Roll number
          </label>
          <input
            id="signup-roll"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={32}
            value={roll}
            onChange={(e) => setRoll(e.target.value.replace(/[^A-Za-z0-9 \-/.]/g, ''))}
            aria-describedby="signup-roll-help"
            className={`${fieldClass} font-mono tracking-wider`}
          />
          <p id="signup-roll-help" className="mt-1 text-[12px] text-[var(--muted,#5B6577)]">
            Type it exactly as printed on your card. It is never shown to anyone and is only used to stop one student signing up twice.
          </p>
        </div>

        <div>
          <span className={labelClass}>Student card</span>
          {scannedBarcode && barcodeMatchesRoll(scannedBarcode, roll) ? (
            <p role="status" className="text-[13px] text-[var(--text,#17233A)]">
              Card scanned. The barcode matches your roll number.
            </p>
          ) : scannedBarcode ? (
            <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">
              The barcode reads {scannedBarcode}, which does not match the roll number you typed. Check the number or scan again.
            </p>
          ) : (
            <p className="text-[12px] text-[var(--muted,#5B6577)]">
              {uploadMode
                ? 'Upload a picture of your card to finish. It is required, and a blurry, dark or cropped picture will be turned down with a reason.'
                : 'Scan the barcode on your card to finish. It is required. It is read on this device and the picture is not saved.'}
            </p>
          )}
          {printed === 'reading' && <p role="status" className="mt-1 text-[12px] text-[var(--muted,#5B6577)]">Reading the printed details on your card...</p>}
          {printed && printed !== 'reading' && <PrintedSummary check={printed} confirmed={mismatchOk} onConfirm={setMismatchOk} />}
          {uploadMode ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void handleCardPicture(e.dataTransfer?.files?.[0]); }}
              className={`mt-2 rounded-[12px] border border-dashed p-3 space-y-2 ${dragging ? 'border-[var(--blue,#244C8A)]' : 'border-[var(--line,#E8EBF0)]'}`}
            >
              <input
                ref={cardFileRef}
                id="signup-card-file"
                type="file"
                accept={ACCEPTED_TYPES.join(',')}
                aria-label="Choose a picture of your student card"
                className="sr-only"
                onChange={(e) => void handleCardPicture(e.target.files?.[0])}
              />
              <p className="text-[12px] text-[var(--muted,#5B6577)] m-0">
                Drop a clear picture of the front of your card here, with the whole barcode in it. It is read on this device and the picture is not saved or sent anywhere.
              </p>
              {photoProblem && <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)] m-0">{photoProblem}</p>}
              {photoBusy && <p role="status" className="text-[12px] text-[var(--muted,#5B6577)] m-0">Reading your picture...</p>}
              <button type="button" disabled={photoBusy} onClick={() => cardFileRef.current?.click()} className={secondaryButton}>
                {scannedBarcode ? 'Choose a different picture' : 'Upload a picture of your student card'}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => { setPrinted(null); setScanning(true); }} className={`${secondaryButton} mt-2`}>
              {scannedBarcode ? 'Scan again' : 'Scan student card'}
            </button>
          )}
        </div>

        {siteKey && <TurnstileWidget siteKey={siteKey} onToken={setTurnstileToken} resetKey={turnstileReset} />}

        {error && (
          <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">
            {error}
          </p>
        )}

        <button type="submit" disabled={!formValid || submitting} className={primaryButton}>
          {submitting ? 'Creating account...' : 'Create account'}
        </button>
      </form>
      {scanning && !uploadMode && (
        <CardScanner
          onClose={() => setScanning(false)}
          onResult={(text, frame) => handleCardRead(text, frame, 'camera')}
        />
      )}
    </div>
  );
};
