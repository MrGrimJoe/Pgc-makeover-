/**
 * JSON response, gzip-compressed when the caller accepts it and the body is big enough to be worth it.
 * Browsers decompress transparently, so `fetch(...).json()` on the phone needs no extra code.
 * Batches are per viewer, so they are never shareable: `Cache-Control: private, no-store`.
 */
export const COMPRESS_MIN_BYTES = 1024;

export async function compressedJson(
  request: Request,
  data: unknown,
  status = 200,
  minBytes = COMPRESS_MIN_BYTES,
): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
    Vary: 'Accept-Encoding',
    'X-Uncompressed-Bytes': String(bytes.byteLength),
  };
  const accepts = /\bgzip\b/i.test(request.headers.get('Accept-Encoding') ?? '');
  if (!accepts || bytes.byteLength < minBytes || typeof CompressionStream === 'undefined') {
    return new Response(bytes, { status, headers });
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = String(gz.byteLength);
  return new Response(gz, { status, headers });
}
