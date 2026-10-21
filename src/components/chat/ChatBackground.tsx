import React, { useEffect, useState } from 'react';
import { IMAGE_SCRIM_ALPHA, presetStyle, type ChatBackgroundId, type ThemeMode } from '../../../shared/chat-background.ts';
import type { ChatBackgroundChoice } from '../../lib/chat-background.ts';

/** The theme the page is showing: an explicit data-theme wins, otherwise the system setting. */
export function currentThemeMode(): ThemeMode {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
  }
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface ChatBackgroundProps {
  choice: ChatBackgroundChoice;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Paints the chat background behind its children. An imported image always sits under a scrim in the app surface
 * color, so text on the background keeps WCAG AA contrast whatever the picture looks like.
 */
export const ChatBackground: React.FC<ChatBackgroundProps> = ({ choice, className = '', children }) => {
  const [url, setUrl] = useState<string | null>(null);
  const blob = choice.kind === 'image' ? choice.blob : null;
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL?.(u);
  }, [blob]);

  const mode = currentThemeMode();
  const style: React.CSSProperties =
    choice.kind === 'preset'
      ? presetStyle(choice.id as ChatBackgroundId, mode)
      : { backgroundImage: url ? `url(${url})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' };

  return (
    <div className={`relative ${className}`} style={style} data-testid="chat-background" data-kind={choice.kind}>
      {choice.kind === 'image' && <div aria-hidden="true" data-testid="chat-scrim" className="absolute inset-0 pointer-events-none" style={{ background: 'var(--bg, #fff)', opacity: IMAGE_SCRIM_ALPHA }} />}
      <div className="relative">{children}</div>
    </div>
  );
};
