/**
 * Reading the barcode on the student card. Everything happens on the phone: the camera picture is decoded in the
 * browser and thrown away. Only the decoded text (the roll number) is ever sent to the server, and the server
 * treats it as a claim to compare, not as proof (a barcode can be copied).
 */

/** The 1D formats a card is likely to carry. A QR code or a photo of a face is not a roll number. */
const FORMATS = ['CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'ITF', 'CODABAR', 'UPC_A', 'UPC_E'] as const;

type Lib = typeof import('@zxing/library');
let libPromise: Promise<Lib> | null = null;
const loadLib = () => (libPromise ??= import('@zxing/library'));

/** A decoder that can be called again and again on frames (the library is loaded once). */
async function makeDecoder(): Promise<(width: number, height: number, grey: Uint8ClampedArray | Uint8Array) => Promise<string | null>> {
  const lib = await loadLib();
  const hints = new Map<import('@zxing/library').DecodeHintType, unknown>();
  hints.set(lib.DecodeHintType.POSSIBLE_FORMATS, FORMATS.map((f) => lib.BarcodeFormat[f]));
  // TRY_HARDER looks at every row of the picture (and at turned pictures). The barcode is wherever the card has it,
  // not necessarily in the middle band the default would look at. A one-dimensional reader only: a QR code, a photo or a
  // logo on the card must never be read as a roll number.
  hints.set(lib.DecodeHintType.TRY_HARDER, true);
  const reader = new lib.MultiFormatOneDReader(hints);
  const attempt = (width: number, height: number, grey: Uint8ClampedArray | Uint8Array): string | null => {
    try {
      const source = new lib.RGBLuminanceSource(Uint8ClampedArray.from(grey), width, height);
      const text = reader.decode(new lib.BinaryBitmap(new lib.HybridBinarizer(source)), hints).getText().trim();
      return text || null;
    } catch {
      return null; // nothing readable in this picture
    }
  };
  const crop = (width: number, grey: Uint8ClampedArray | Uint8Array, x: number, y: number, w: number, h: number) => {
    const out = new Uint8ClampedArray(w * h);
    for (let row = 0; row < h; row++) out.set(grey.subarray((y + row) * width + x, (y + row) * width + x + w), row * w);
    return out;
  };
  // A card is full of other things: a border, a photo, printed lines. Found by testing on a card picture: one dark line
  // to the left of the barcode makes the reader give up on the whole row, although the same barcode reads perfectly
  // once the line is cut off. So when the whole picture gives nothing, try it with the edges trimmed, then in bands.
  // The first answer wins; the whole picture goes first, so a clean scan costs one attempt.
  const WINDOWS: Array<[number, number]> = [[0, 1], [0.03, 1], [0.03, 0.97], [0, 0.97], [0.08, 0.92], [0.15, 1], [0, 0.8], [0.25, 1]];
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0)); // lets the screen breathe between attempts
  return async (width, height, grey) => {
    const tries: Array<[number, number, number, number]> = []; // x, y, w, h
    for (const [a, b] of WINDOWS) tries.push([Math.round(width * a), 0, Math.round(width * (b - a)), height]);
    const bandH = Math.round(height * 0.4);
    for (const y of [Math.round(height * 0.6), Math.round(height * 0.3), 0]) {
      for (const [a, b] of [[0.03, 0.97], [0.03, 0.6], [0.4, 0.97]] as Array<[number, number]>) {
        tries.push([Math.round(width * a), Math.min(y, height - bandH), Math.round(width * (b - a)), bandH]);
      }
    }
    for (const [x, y, w, h] of tries) {
      const text = x === 0 && y === 0 && w === width && h === height ? attempt(width, height, grey) : attempt(w, h, crop(width, grey, x, y, w, h));
      if (text) return text;
      await pause();
    }
    return null;
  };
}

/** Decodes one still picture given as 8-bit grey values (width*height). Used by the tests and any still-image path. */
export async function decodeBarcodeFromGrey(width: number, height: number, grey: Uint8ClampedArray | Uint8Array): Promise<string | null> {
  return (await makeDecoder())(width, height, grey);
}

/** One still of what the camera sees right now, kept in memory only so the printed text can be read. Never uploaded. */
function snapshot(video: HTMLVideoElement): HTMLCanvasElement | undefined {
  try {
    if (!video.videoWidth || !video.videoHeight) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return canvas;
  } catch {
    return undefined;
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
 * Each camera frame is drawn to a canvas, turned into grey values and decoded here. The library is loaded only now,
 * so people who never reach the card step never download it.
 */
export async function startCameraScan(
  video: HTMLVideoElement,
  onResult: (text: string, frame?: HTMLCanvasElement) => void,
  onError: (kind: CameraScanError) => void
): Promise<CameraScan> {
  if (!navigator.mediaDevices?.getUserMedia) {
    onError('unsupported');
    return { stop() {} };
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    const stream = video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  try {
    const decode = await makeDecoder();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return { stop };
    }
    video.srcObject = stream;
    video.muted = true;
    await video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no canvas');
    const MAX_WIDTH = 1280; // bigger pictures are only slower, not better
    let busy = false;
    const tick = async () => {
      if (stopped || busy) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const grey = new Uint8ClampedArray(canvas.width * canvas.height);
        for (let i = 0, p = 0; i < grey.length; i++, p += 4) grey[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
        busy = true;
        const text = await decode(canvas.width, canvas.height, grey).finally(() => { busy = false; });
        if (stopped) return;
        if (text) {
          const frame = snapshot(video);
          stop();
          onResult(text, frame);
          return;
        }
      }
      timer = setTimeout(() => void tick(), 150);
    };
    void tick();
  } catch (err) {
    stop();
    onError(classifyCameraError(err));
  }
  return { stop };
}
