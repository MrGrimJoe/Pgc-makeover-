import { useState } from 'react';
import { promptInstall, readInstallEnv, useCanPrompt } from '../lib/pwa.ts';
import { QrCode } from './QrCode.tsx';

const h2 = 'm-0 text-[15px] font-semibold text-[var(--text,#17233A)]';
const ghost = 'min-h-[44px] px-3.5 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer disabled:opacity-40';
const muted = 'm-0 text-[13px] text-[var(--muted,#5B6577)]';

/** The public address of the app: the site's own origin, never a path, a token or anything about the person. */
export function canonicalAppUrl(): string {
  return `${window.location.origin}/`;
}

/** Settings card: install instructions that always work (no prompt needed) plus a link and QR code to share. */
export function ShareApp({ className }: { className: string }) {
  const canPrompt = useCanPrompt();
  const [env] = useState(readInstallEnv);
  const [showQr, setShowQr] = useState(false);
  const [note, setNote] = useState('');
  const url = canonicalAppUrl();

  const share = async () => {
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ title: 'Dialtone', url }); return; }
      await navigator.clipboard.writeText(url);
      setNote('Link copied.');
    } catch { /* the share sheet was closed, or copying was refused */ }
  };

  let install: string;
  if (env.standalone) install = 'Dialtone is installed on this device.';
  else if (env.inApp) install = 'Open this page in your browser first (menu, then Open in browser), then add it to your home screen.';
  else if (env.os === 'ios') install = env.browser === 'safari'
    ? 'In Safari tap Share, then Add to Home Screen.'
    : 'Open this page in Safari, tap Share, then Add to Home Screen.';
  else if (env.os === 'android') install = 'In Chrome open the menu (three dots), then Install app or Add to Home screen.';
  else install = 'In Chrome or Edge, use the install icon at the right end of the address bar, or the menu, then Install.';

  return (
    <section aria-labelledby="set-install" className={className}>
      <h2 id="set-install" className={h2}>Install and share</h2>
      <p className={muted}>{install}</p>
      {canPrompt && !env.standalone && (
        <button type="button" className={`${ghost} w-full`} onClick={() => void promptInstall()}>Install on this device</button>
      )}
      <div className="flex gap-2">
        <button type="button" className={`${ghost} flex-1`} onClick={() => void share()}>Share link</button>
        <button type="button" className={`${ghost} flex-1`} aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>{showQr ? 'Hide QR code' : 'Show QR code'}</button>
      </div>
      {note && <p role="status" className={muted}>{note}</p>}
      {showQr && (
        <div className="flex flex-col items-center gap-2 pt-1">
          <QrCode value={url} label="QR code for the Dialtone address" />
          <p className={`${muted} text-center`}>Anyone can scan this to open Dialtone. It holds only the public address.</p>
        </div>
      )}
    </section>
  );
}
