import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../lib/focus-trap.ts';

/** Length of the slide-out animation; the sheet unmounts this long after a close request. */
export const SHEET_CLOSE_MS = 250;

interface BottomSheetProps {
  /** Accessible name of the dialog */
  label: string;
  /** Called once, after the slide-out has finished */
  onClose: () => void;
  /** Content, or a function that receives `requestClose` (for a Close button inside the sheet) */
  children: React.ReactNode | ((api: { requestClose: () => void }) => React.ReactNode);
  /** Extra classes for the panel (height etc.) */
  className?: string;
}

let sheetCounter = 0;

/**
 * A panel that slides up from the bottom (like YouTube and TikTok comments) and slides back down when:
 * the backdrop is tapped, Escape is pressed, the phone/browser Back button is used, a close button calls
 * the `requestClose` passed to render-prop children, or it is dragged down from its top bar.
 * Back is wired through one history entry that the sheet adds on open and removes on close.
 */
export const BottomSheet: React.FC<BottomSheetProps> = ({
  label,
  onClose,
  children,
  className = '',
}) => {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`sheet-${++sheetCounter}`);
  const closingRef = useRef(false);
  const poppedRef = useRef(false); // the Back button already removed our history entry
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
  }, []);

  // Unmount after the slide-out (a timer, because animationend never fires when motion is reduced or in tests)
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => onCloseRef.current(), SHEET_CLOSE_MS + 30);
    return () => window.clearTimeout(t);
  }, [closing]);

  // Back button: one history entry for as long as the sheet is open
  useEffect(() => {
    const id = idRef.current;
    window.history.pushState({ ...(window.history.state ?? {}), sheet: id }, '');
    const onPop = () => {
      if ((window.history.state as { sheet?: string } | null)?.sheet === id) return; // still on our entry
      poppedRef.current = true;
      requestClose();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed some other way: remove the entry we added (unless the app already moved on from it)
      if (!poppedRef.current && (window.history.state as { sheet?: string } | null)?.sheet === id) window.history.back();
    };
  }, [requestClose]);

  // The page behind does not scroll while the sheet is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useFocusTrap(panelRef, requestClose, !closing);

  // Drag down from the top bar to close
  const drag = useRef<{ startY: number; startT: number; dy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (closingRef.current) return;
    drag.current = { startY: e.clientY, startT: e.timeStamp, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    panelRef.current?.classList.add('sheet-dragging');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !panelRef.current) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    panelRef.current.style.transform = `translateY(${d.dy}px)`;
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const panel = panelRef.current;
    if (!d || !panel) return;
    panel.classList.remove('sheet-dragging');
    const fast = d.dy / Math.max(1, e.timeStamp - d.startT) > 0.6; // px per ms
    if (d.dy > 100 || (fast && d.dy > 30)) {
      panel.style.setProperty('--drag', `${d.dy}px`);
      panel.style.transform = '';
      requestClose();
    } else {
      panel.style.transform = ''; // springs back through the CSS transition-free reset
    }
  };

  return (
    <div
      className="sheet-backdrop fixed inset-0 z-50 bg-[#17233A]/50 flex items-end justify-center"
      data-closing={closing}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-closing={closing}
        className={`sheet-panel w-full max-w-[430px] bg-surface border border-border border-b-0 rounded-t-[16px] flex flex-col shadow-sheet pb-[env(safe-area-inset-bottom)] ${className}`}
      >
        {/* Grab bar: the drag handle (touch-action none so the browser does not scroll instead) */}
        <div
          data-sheet-handle
          className="pt-2 pb-1 flex justify-center cursor-grab touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span aria-hidden="true" className="w-10 h-1 rounded-full bg-border" />
        </div>
        {typeof children === 'function' ? (children as (api: { requestClose: () => void }) => React.ReactNode)({ requestClose }) : children}
      </div>
    </div>
  );
};
