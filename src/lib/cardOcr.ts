/**
 * Reads the printed text on the card, on this device. The engine and language data are served from this site
 * (/ocr, copied by scripts/copy-ocr-assets.mjs), loaded only when a card has been scanned, and the picture is never
 * uploaded. Any failure (offline, blocked, out of memory) comes back as "no text", which the screen treats as
 * "could not read" and carries on: OCR is a hint and never blocks sign-up by itself.
 */
export interface OcrPaths { workerPath: string; corePath: string; langPath: string }

export const BROWSER_OCR_PATHS: OcrPaths = { workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr' };

export async function readCardText(image: unknown, paths: OcrPaths = BROWSER_OCR_PATHS, timeoutMs = 45000): Promise<string> {
  interface W { recognize: (i: unknown) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> }
  const held: { worker: W | null } = { worker: null };
  try {
    const { createWorker } = await import('tesseract.js');
    const work = (async () => {
      held.worker = (await createWorker('eng', 1, { ...paths, gzip: true, cacheMethod: 'none', logger: () => {} })) as unknown as W;
      const { data } = await held.worker.recognize(image);
      return data.text ?? '';
    })();
    return await Promise.race([work, new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs))]);
  } catch {
    return '';
  } finally {
    try { await held.worker?.terminate(); } catch { /* already gone */ }
  }
}
