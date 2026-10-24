import React, { useEffect, useRef, useState } from 'react';
import { BottomSheet } from './BottomSheet.tsx';
import { startCameraScan, type CameraScan, type CameraScanError } from '../lib/cardScan.ts';

interface CardScannerProps {
  /** The decoded barcode text. Called once; the camera is already stopped. */
  onResult: (barcode: string) => void;
  onClose: () => void;
}

const ERROR_TEXT: Record<CameraScanError, string> = {
  denied: 'The camera is blocked. Allow camera access for this site in your browser settings, then try again.',
  'no-camera': 'No camera was found on this device.',
  unsupported: 'This browser cannot open the camera here. Try Chrome or Safari, or use a phone.',
  failed: 'The camera could not be started. Close other apps that use it and try again.',
};

/** Live camera view that reads the barcode on the student card. Nothing is recorded, uploaded or kept. */
export const CardScanner: React.FC<CardScannerProps> = ({ onResult, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanRef = useRef<CameraScan | null>(null);
  const [error, setError] = useState<CameraScanError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    setError(null);
    startCameraScan(
      video,
      (text) => {
        if (!cancelled) onResultRef.current(text);
      },
      (kind) => {
        if (!cancelled) setError(kind);
      }
    ).then((scan) => {
      if (cancelled) scan.stop();
      else scanRef.current = scan;
    });
    return () => {
      cancelled = true;
      scanRef.current?.stop(); // the camera light goes off when the sheet closes, however it closes
      scanRef.current = null;
    };
  }, [attempt]);

  return (
    <BottomSheet label="Scan your student card" onClose={onClose} className="p-4">
      {({ requestClose }) => (
        <div className="flex flex-col gap-3">
          <h2 className="text-[16px] font-semibold text-[var(--text,#17233A)]">Scan your student card</h2>
          <p className="text-[13px] text-[var(--muted,#5B6577)]">
            Hold the card flat and put the barcode inside the picture. It is read on this device. The picture is not saved or sent anywhere.
          </p>
          <div className="relative w-full aspect-[4/3] rounded-[12px] overflow-hidden bg-black">
            <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-cover" aria-label="Camera view" />
          </div>
          {error ? (
            <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">
              {ERROR_TEXT[error]}
            </p>
          ) : (
            <p role="status" className="text-[13px] text-[var(--muted,#5B6577)]">
              Looking for the barcode...
            </p>
          )}
          <div className="flex gap-2">
            {error && (
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="flex-1 min-h-[44px] rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[14px] font-semibold cursor-pointer border-0"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={requestClose}
              className="flex-1 min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[14px] font-semibold cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
};
