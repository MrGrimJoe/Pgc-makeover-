import React, { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; 'expired-callback': () => void; 'error-callback': () => void }) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('missing')));
    script.onerror = () => { loading = null; reject(new Error('blocked')); };
    document.head.appendChild(script);
  });
  return loading;
}

interface Props {
  siteKey: string;
  /** A fresh token, or null when it expired or the check failed (the form must not be sendable then). */
  onToken: (token: string | null) => void;
  /** Change this number to ask for a new check (a token works once). */
  resetKey?: number;
}

/** Cloudflare's bot check. Only mounted when the server says it is switched on. */
export const TurnstileWidget: React.FC<Props> = ({ siteKey, onToken, resetKey = 0 }) => {
  const host = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !host.current) return;
        widgetId.current = api.render(host.current, {
          sitekey: siteKey,
          callback: (t) => onTokenRef.current(t),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => { onTokenRef.current(null); setFailed(true); },
        });
      })
      .catch(() => { if (!cancelled) { setFailed(true); onTokenRef.current(null); } });
    return () => { cancelled = true; if (widgetId.current) window.turnstile?.remove(widgetId.current); };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey > 0 && widgetId.current) { onTokenRef.current(null); window.turnstile?.reset(widgetId.current); }
  }, [resetKey]);

  return (
    <div>
      <div ref={host} aria-label="Security check" />
      {failed && <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">The security check could not load. Check your connection, turn off content blockers for this site, and reload.</p>}
    </div>
  );
};
