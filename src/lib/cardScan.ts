/**
 * Reading the barcode on the student card. Everything happens on the phone: the camera picture is decoded in the
 * browser and thrown away. Only the decoded text (the roll number) is ever sent to the server, and the server
 * treats it as a claim to compare, not as proof (a barcode can be copied).
 */
import type { Result } from '@zxing/library';

/** The 1D formats a card is likely to carry. A QR code or a photo of a face is not a roll number. */
const FORMATS = ['CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'ITF', 'CODABAR', 'UPC_A', 'UPC_E'] as const;

/**
 * Decodes one still picture given as 8-bit grey values (width*height). Used by the tests and available for any
 * still-image path; the live scan below uses the same library on video frames.
 */
export async function decodeBarcodeFromGrey(width: number, height: number, grey: Uint8ClampedArray | Uint8Array): Promise<string | null> {
  const lib = await import('@zxing/library');
  const hints = new Map<number, unknown>();
  hints.set(
    lib.DecodeHintType.POSSIBLE_FORMATS,
    FORMATS.map((f) => lib.BarcodeFormat[f])
  );
  hints.set(lib.DecodeHintType.TRY_HARDER, true);
  // The one-dimensional reader only: a QR code, a photo or a logo on the card must never be read as a roll number.
  const reader = new lib.MultiFormatOneDReader(hints as Map<import('@zxing/library').DecodeHintType, unknown>);
  const source = new lib.RGBLuminanceSource(Uint8ClampedArray.from(grey), width, height);
  const bitmap = new lib.BinaryBitmap(new lib.HybridBinarizer(source));
  try {
    const result: Result = reader.decode(bitmap, hints as Map<import('@zxing/library').DecodeHintType, unknown>);
    const text = result.getText().trim();
    return text || null;
  } catch {
    return null; // nothing readable in this picture
  }
}

export interface CameraScan {
  /** Stops decoding and releases the camera. Safe to call twice. */
  stop: () => void;
}

export type CameraScanError = 'denied' | 'no-camera' | 'unsupported' | 'failed';

export function classifyCameraError(err: unknown): CameraScanError {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-camera';
  if (name === 'TypeError' || name === 'NotSupportedError') return 'unsupported';
  return 'failed';
}

/**
 * Opens the back camera in `video` and calls `onResult` once with the first readable barcode, then stops.
 * The library is loaded only now, so people who never reach the card step never download it.
 */
export async function startCameraScan(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError: (kind: CameraScanError) => void
): Promise<CameraScan> {
  if (!navigator.mediaDevices?.getUserMedia) {
    onError('unsupported');
    return { stop() {} };
  }
  let stopped = false;
  let controls: { stop: () => void } | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controls?.stop();
    const stream = video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  try {
    const [{ BrowserMultiFormatOneDReader }, lib] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
    const hints = new Map();
    hints.set(lib.DecodeHintType.POSSIBLE_FORMATS, FORMATS.map((f) => lib.BarcodeFormat[f]));
    hints.set(lib.DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: 150 });
    controls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false },
      video,
      (result) => {
        if (!result || stopped) return;
        const text = result.getText().trim();
        if (!text) return;
        stop();
        onResult(text);
      }
    );
    if (stopped) controls.stop();
  } catch (err) {
    stop();
    onError(classifyCameraError(err));
  }
  return { stop };
}
