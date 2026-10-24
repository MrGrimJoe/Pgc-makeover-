import { useState } from 'react';
import { Share, X } from 'lucide-react';
import { bannerKind, isDismissed, promptInstall, readInstallEnv, rememberDismissed, useCanPrompt } from '../lib/pwa.ts';

const box = 'mx-3 mt-3 rounded-[12px] border border-[var(--line,#E8EBF0)] bg-[var(--tint,#EAF0FA)] p-3 text-[13px] text-[var(--text,#17233A)]';
const primary = 'min-h-[44px] px-3.5 rounded-[8px] border-0 bg-[var(--blue,#244C8A)] text-white text-[13px] font-semibold cursor-pointer';
const ghost = 'min-h-[44px] px-3.5 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer';

/**
 * One calm, dismissible banner. It appears only when installing is possible and useful:
 * the browser offered an install prompt (Android, Chrome, Edge), the person is in Safari on an iPhone or iPad,
 * or they opened the app inside another app's browser (where sign-in and installing do not work).
 * "Not now" hides it for two weeks; being installed hides it for good. Settings always keeps the instructions.
 * `signedOut` limits it to the open-in-your-browser notice, so the sign-in page is never nagged to install.
 */
export function InstallBanner({ signedOut = false }: { signedOut?: boolean }) {
  const canPrompt = useCanPrompt();
  const [env] = useState(readInstallEnv);
  const [hidden, setHidden] = useState(() => isDismissed());
  const kind = bannerKind(env, canPrompt, hidden);
  if (kind === 'none' || (signedOut && kind !== 'open-in-browser')) return null;

  const dismiss = () => { rememberDismissed(); setHidden(true); };
  const closeBtn = (
    <button type="button" onClick={dismiss} aria-label="Not now" className="shrink-0 w-[44px] h-[44px] -mr-2 -mt-2 inline-flex items-center justify-center rounded-full border-0 bg-transparent text-[var(--muted,#5B6577)] cursor-pointer">
      <X size={18} aria-hidden="true" />
    </button>
  );

  if (kind === 'android-prompt') {
    return (
      <section aria-label="Install the app" className={box}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="m-0 font-semibold">Add Dialtone to your home screen</p>
            <p className="m-0 mt-1 text-[var(--muted,#5B6577)]">Opens like an app, with no browser bar.</p>
          </div>
          {closeBtn}
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" className={primary} onClick={() => void promptInstall().then((r) => { if (r === 'accepted') setHidden(true); })}>Install</button>
          <button type="button" className={ghost} onClick={dismiss}>Not now</button>
        </div>
      </section>
    );
  }

  if (kind === 'ios-safari') {
    return (
      <section aria-label="Install the app" className={box}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="m-0 font-semibold">Add Dialtone to your home screen</p>
            <p className="m-0 mt-1 text-[var(--muted,#5B6577)]">
              Tap <Share size={14} aria-hidden="true" className="inline align-[-2px]" /> <strong>Share</strong> in Safari, then choose <strong>Add to Home Screen</strong>.
            </p>
          </div>
          {closeBtn}
        </div>
      </section>
    );
  }

  // open-in-browser
  const target = env.os === 'ios' ? 'Safari' : 'your browser (Chrome)';
  return (
    <section aria-label="Open in your browser" className={box}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="m-0 font-semibold">Open this page in {target}</p>
          <p className="m-0 mt-1 text-[var(--muted,#5B6577)]">
            {signedOut ? 'Google sign-in does not work inside other apps. ' : ''}
            Use the menu (the three dots or the share icon) and choose <strong>Open in {env.os === 'ios' ? 'Safari' : 'browser'}</strong>.
            {' '}You can then add Dialtone to your home screen.
          </p>
        </div>
        {closeBtn}
      </div>
    </section>
  );
}
