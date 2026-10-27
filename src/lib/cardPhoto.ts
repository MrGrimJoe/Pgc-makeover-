/**
 * Student card from a picture file, for sign-up on a laptop or desktop (where the camera scanner is not offered).
 *
 * Same rules as the camera scan (src/lib/cardScan.ts): the picture is read on this device and thrown away. Only the
 * decoded barcode text is ever sent, and the server treats it as a claim to compare against the typed roll number,
 * not as proof. So "enforcing the upload" means enforcing a readable barcode that matches the roll number: the server
 * already refuses sign-up without one (`card_required`) and with a wrong one (`card_mismatch`).
 *
 * A picture is rejected, with a reason the person can act on, when:
 *   - it is not a JPG, PNG or WebP picture, is too big, or cannot be opened;
 *   - it is too small to hold a readable barcode (too-small), or flat (almost no contrast: black, or washed out by a flash);
 *   - the barcode cannot be read from it. The measurements below only choose the explanation (blurry, dark, or simply
 *     no barcode in the picture). The decoder decides. A picture with a readable barcode is never rejected for a
 *     measurement, so a threshold that is slightly off can never lock a real student out.
 * The thresholds were set by measuring real card pictures: a clean card is mostly white (average brightness about 240 of
 * 255), so brightness alone must never reject a picture. Contrast and "detail" (below) are what separate a good picture
 * from a bad one.
 */
import { decodeBarcodeFromGrey } from './cardScan.ts';

export type CardPhotoProblem =
  | 'type'
  | 'size'
  | 'unopenable'
  | 'too-small'
  | 'too-dark'
  | 'too-bright'
  | 'blurry'
  | 'no-barcode';

export const CARD_PHOTO_MESSAGES: Record<CardPhotoProblem, string> = {
  type: 'Use a JPG, PNG or WebP picture of the front of your card.',
  size: 'That picture is too big. Use one under 12 MB.',
  unopenable: 'That file could not be opened as a picture. Try another one.',
  'too-small': 'The picture is too small to read the barcode. Take it closer or at a higher quality, at least 800 pixels wide.',
  'too-dark': 'The picture is too dark. Take it in better light and try again.',
  'too-bright': 'The picture is washed out, probably glare or a flash. Tilt the card a little and try again.',
  blurry: 'The picture is blurry, so the barcode cannot be read. Hold the camera steady, let it focus, and try again.',
  'no-barcode': 'No barcode was found. Use a straight, close picture of the front of the card with the whole barcode in it, and no glare across it.',
};

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_BYTES = 12 * 1024 * 1024;
/** Longest side below this cannot carry a card barcode a decoder can read. */
export const MIN_LONG_SIDE = 800;
/** Pictures are decoded at most this wide: a bigger one is only slower, not better. */
export const MAX_DECODE_WIDTH = 1600;

export interface PhotoStats {
  width: number;
  height: number;
  /** 0 to 255 */
  brightness: number;
  /** Standard deviation of the grey values; a flat or washed-out picture has very little. */
  contrast: number;
  /**
   * Variance of the Laplacian (how much fine edge detail there is) divided by the contrast squared, so a dim picture is
   * not mistaken for a blurry one. A sharp card is around 1; slightly soft but still readable is about 0.1; below
   * about 0.02 the bars have run together.
   */
  detail: number;
}

/** Measures a picture given as 8-bit grey values (width*height). Pure, so it is easy to test. */
export function measureGrey(width: number, height: number, grey: Uint8ClampedArray | Uint8Array): PhotoStats {
  const n = grey.length || 1;
  let sum = 0;
  for (let i = 0; i < grey.length; i++) sum += grey[i]!;
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < grey.length; i++) varSum += (grey[i]! - mean) ** 2;

  // 4-neighbour Laplacian on the inside pixels
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * grey[i]! - grey[i - 1]! - grey[i + 1]! - grey[i - width]! - grey[i + width]!;
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const lapMean = count ? lapSum / count : 0;
  const contrast = Math.sqrt(varSum / n);
  const lapVar = count ? lapSq / count - lapMean * lapMean : 0;
  return { width, height, brightness: mean, contrast, detail: lapVar / Math.max(contrast * contrast, 1) };
}

/** Below this the picture is flat: no barcode can be in it. */
const FLAT_CONTRAST = 12;
/** An average this dark, with a barcode that could not be read, is an underexposed picture. */
const UNDEREXPOSED = 70;
/** Below this the bars have run together. A readable but soft picture measured 0.095; an unreadable one 0.019. */
const BLURRY_DETAIL = 0.05;

/** Problems that are clear from the measurements alone, before any decoding. `null` means: go ahead and try to read it. */
export function judgeBeforeReading(stats: PhotoStats, originalWidth = stats.width, originalHeight = stats.height): CardPhotoProblem | null {
  if (Math.max(originalWidth, originalHeight) < MIN_LONG_SIDE) return 'too-small';
  if (stats.contrast < FLAT_CONTRAST) return stats.brightness < 128 ? 'too-dark' : 'too-bright';
  return null;
}

/** The reason to give when the barcode could not be read. */
export function explainFailedRead(stats: PhotoStats): CardPhotoProblem {
  if (stats.brightness < UNDEREXPOSED) return 'too-dark';
  if (stats.detail < BLURRY_DETAIL) return 'blurry';
  return 'no-barcode';
}

/** A picture, opened and turned into grey values. `original*` is the size of the file's picture before any shrinking. */
export interface LoadedPicture {
  width: number;
  height: number;
  grey: Uint8ClampedArray;
  originalWidth: number;
  originalHeight: number;
  /** Kept in memory only, so the printed text can be read on this device. Never uploaded. */
  frame?: HTMLCanvasElement;
}
export type PictureLoader = (file: File) => Promise<LoadedPicture>;

/** Opens the file in the browser. Honors the photo's rotation. Throws when the file is not a usable picture. */
export const loadPictureFromFile: PictureLoader = async (file) => {
  let source: ImageBitmap | HTMLImageElement;
  let originalWidth: number;
  let originalHeight: number;
  let release = () => {};
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bitmap;
    originalWidth = bitmap.width;
    originalHeight = bitmap.height;
    release = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('unopenable'));
      img.src = url;
    }).finally(() => URL.revokeObjectURL(url));
    source = img;
    originalWidth = img.naturalWidth;
    originalHeight = img.naturalHeight;
  }
  try {
    const scale = Math.min(1, MAX_DECODE_WIDTH / Math.max(originalWidth, 1));
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round(originalWidth * scale));
    frame.height = Math.max(1, Math.round(originalHeight * scale));
    const ctx = frame.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(source, 0, 0, frame.width, frame.height);
    const { data } = ctx.getImageData(0, 0, frame.width, frame.height);
    const grey = new Uint8ClampedArray(frame.width * frame.height);
    for (let i = 0, p = 0; i < grey.length; i++, p += 4) grey[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
    return { width: frame.width, height: frame.height, grey, originalWidth, originalHeight, frame };
  } finally {
    release();
  }
};

export type CardPhotoResult =
  | { ok: true; barcode: string; frame?: HTMLCanvasElement }
  | { ok: false; problem: CardPhotoProblem; message: string };

const reject = (problem: CardPhotoProblem): CardPhotoResult => ({ ok: false, problem, message: CARD_PHOTO_MESSAGES[problem] });

/**
 * Checks a chosen file and reads the barcode from it. Never throws: every failure is a `problem` with a message.
 * `load` is only replaced in tests.
 */
export async function readCardPhoto(file: File, load: PictureLoader = loadPictureFromFile): Promise<CardPhotoResult> {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return reject('type');
  if (file.size > MAX_BYTES) return reject('size');
  let picture: LoadedPicture;
  try {
    picture = await load(file);
  } catch {
    return reject('unopenable');
  }
  const stats = measureGrey(picture.width, picture.height, picture.grey);
  const early = judgeBeforeReading(stats, picture.originalWidth, picture.originalHeight);
  if (early) return reject(early);
  const barcode = await decodeBarcodeFromGrey(picture.width, picture.height, picture.grey);
  if (!barcode) return reject(explainFailedRead(stats));
  return { ok: true, barcode, frame: picture.frame };
}

/**
 * Should sign-up offer "upload a photo of your card" instead of the camera scanner?
 * Yes on a device whose main pointer is a mouse or trackpad (a laptop or desktop, even one with a touch screen or a
 * webcam), and wherever the browser has no camera API at all. Phones and tablets (main pointer: finger) keep the scanner.
 * Where the browser cannot tell (no matchMedia), the scanner is kept, so phones behave exactly as before.
 */
export function prefersPhotoUpload(): boolean {
  if (typeof window === 'undefined') return false;
  const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  if (dev) {
    const forced = new URLSearchParams(window.location.search).get('card'); // dev only: ?card=upload or ?card=scan
    if (forced === 'upload') return true;
    if (forced === 'scan') return false;
  }
  if (typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(pointer: fine)').matches) return true;
  return !navigator.mediaDevices?.getUserMedia;
}
