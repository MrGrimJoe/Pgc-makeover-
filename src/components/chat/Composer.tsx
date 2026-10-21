import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Paperclip, Send, Smile } from 'lucide-react';
import { panelHeight, useKeyboardInset } from '../../lib/keyboard.ts';

const LINE_PX = 20;
const MAX_LINES = 5;
const PAD_Y = 16;

/** How tall the field should be for its content: grows to 5 lines, then scrolls. Pure. */
export function fieldHeight(scrollHeight: number): number {
  return Math.min(scrollHeight, LINE_PX * MAX_LINES + PAD_Y);
}

/** True on touch devices, where Enter inserts a newline and the send button sends. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

interface ComposerProps {
  /** chat: attach button, sticker button and send. compact: smaller bar for posts and comments (no attach). */
  variant?: 'chat' | 'compact';
  onSend: (text: string) => Promise<void> | void;
  onAttach?: () => void;
  /** Panel shown in place of the keyboard when the sticker button is on. */
  picker?: React.ReactNode;
  pickerOpen?: boolean;
  onTogglePicker?: () => void;
  /** Sending is allowed with empty text (for example when attachments are waiting). */
  canSendEmpty?: boolean;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  maxLength?: number;
  label?: string;
}

/** WhatsApp-style typing bar that rides above the keyboard. */
export const Composer: React.FC<ComposerProps> = ({
  variant = 'chat', onSend, onAttach, picker, pickerOpen = false, onTogglePicker, canSendEmpty = false,
  disabled = false, busy = false, placeholder = 'Message', maxLength = 2000, label = 'Message',
}) => {
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const { inset, lastKeyboardHeight } = useKeyboardInset();
  const compact = variant === 'compact';

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${fieldHeight(el.scrollHeight)}px`;
  }, [text]);

  // The picker replaces the keyboard: keep the field focused but without the on-screen keyboard
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (pickerOpen) {
      el.setAttribute('inputmode', 'none');
      el.blur();
      el.focus();
    } else {
      el.removeAttribute('inputmode');
    }
  }, [pickerOpen]);

  const canSend = !disabled && !busy && (text.trim().length > 0 || canSendEmpty);

  const submit = async () => {
    if (!canSend) return;
    const value = text.trim();
    await onSend(value);
    setText('');
    ta.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    // Touch devices: Enter is a newline and the button sends. Desktop: Enter sends.
    if (isTouchDevice()) return;
    e.preventDefault();
    void submit();
  };

  const iconBtn = `${compact ? 'w-[44px] h-[44px]' : 'w-[44px] h-[44px]'} shrink-0 flex items-center justify-center text-[var(--blue,#244C8A)] bg-transparent border-0 cursor-pointer disabled:opacity-40`;

  return (
    <div
      data-testid="composer"
      style={inset > 0 ? { transform: `translateY(-${inset}px)` } : undefined}
      className="sticky bottom-0 bg-[var(--bg,#fff)] border-t border-[var(--line,#E8EBF0)] px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]"
    >
      <div className="flex items-end gap-1">
        {!compact && onAttach && (
          <button type="button" onClick={onAttach} disabled={disabled} aria-label="Attach" title="Attach" className={iconBtn}>
            <Paperclip className="w-6 h-6 stroke-[1.7]" aria-hidden="true" />
          </button>
        )}
        <textarea
          ref={ta}
          value={text}
          rows={1}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={label}
          enterKeyHint={isTouchDevice() ? 'enter' : 'send'}
          className="flex-1 min-h-[44px] resize-none bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[12px] px-3.5 py-[10px] text-[15px] leading-[20px] text-[var(--text,#17233A)] outline-none focus:border-[var(--blue,#244C8A)]"
        />
        {onTogglePicker && (
          <button
            type="button"
            onClick={onTogglePicker}
            disabled={disabled}
            aria-label={pickerOpen ? 'Show keyboard' : 'Stickers and GIFs'}
            aria-pressed={pickerOpen}
            title="Stickers and GIFs"
            className={iconBtn}
          >
            <Smile className="w-6 h-6 stroke-[1.7]" aria-hidden="true" />
          </button>
        )}
        <button type="button" onClick={() => void submit()} disabled={!canSend} aria-label={busy ? 'Sending' : 'Send'} title="Send" className={iconBtn}>
          <Send className="w-6 h-6 stroke-[1.7]" aria-hidden="true" />
        </button>
      </div>
      {pickerOpen && picker && (
        <div data-testid="picker-panel" style={{ height: panelHeight(lastKeyboardHeight) }} className="mt-2 overflow-y-auto rounded-[12px] border border-[var(--line,#E8EBF0)] bg-[var(--bg2,#F8F9FC)]">
          {picker}
        </div>
      )}
    </div>
  );
};
