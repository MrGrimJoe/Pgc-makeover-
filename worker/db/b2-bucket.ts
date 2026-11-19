import { z } from 'zod';
import type { R2Bucket, R2Object, R2ObjectBody, R2PutOptions, R2GetOptions } from '@cloudflare/workers-types';

interface B2Config {
  keyId: string;
  applicationKey: string;
  bucketId: string;
  bucketName: string;
}

interface B2AuthCache {
  token: string;
  apiUrl: string;
  downloadUrl: string;
  expiresAt: number;
}

const b2AuthorizeResponseSchema = z.object({
  authorizationToken: z.string(),
  apiInfo: z.object({
    storageApi: z.object({
      apiUrl: z.string(),
      downloadUrl: z.string(),
    }),
  }),
});

const b2UploadUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  authorizationToken: z.string(),
});

const b2UploadResponseSchema = z.object({
  fileId: z.string(),
  contentSha1: z.string().optional(),
});

const b2ListFilesResponseSchema = z.object({
  files: z.array(
    z.object({
      fileName: z.string(),
      fileId: z.string(),
    })
  ),
});

let cachedAuth: B2AuthCache | null = null;

async function getB2Auth(config: B2Config): Promise<B2AuthCache> {
  const now = Date.now();
  if (cachedAuth && cachedAuth.expiresAt > now + 60000) {
    return cachedAuth;
  }

  const credentials = btoa(`${config.keyId}:${config.applicationKey}`);
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`B2 authorize failed (${res.status}): ${err}`);
  }

  const raw = await res.json();
  const parsed = b2AuthorizeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`B2 authorize response invalid: ${parsed.error.message}`);
  }

  cachedAuth = {
    token: parsed.data.authorizationToken,
    apiUrl: parsed.data.apiInfo.storageApi.apiUrl,
    downloadUrl: parsed.data.apiInfo.storageApi.downloadUrl,
    expiresAt: now + 20 * 60 * 60 * 1000, // 20 hours
  };
  return cachedAuth;
}

async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', data.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createB2Bucket(config: B2Config): R2Bucket {
  return {
    async put(key: string, value: unknown, options?: R2PutOptions): Promise<R2Object> {
      const auth = await getB2Auth(config);

      // Convert value to Uint8Array
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value && typeof (value as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
        const ab = await (value as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
        bytes = new Uint8Array(ab);
      } else {
        bytes = new Uint8Array(0);
      }

      const sha1 = await sha1Hex(bytes);
      const contentType = (options?.httpMetadata as Record<string, string> | undefined)?.contentType || 'application/octet-stream';

      // 1. Request upload URL
      const uploadUrlRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
        method: 'POST',
        headers: {
          Authorization: auth.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bucketId: config.bucketId }),
      });

      if (!uploadUrlRes.ok) {
        const err = await uploadUrlRes.text();
        throw new Error(`B2 get_upload_url failed: ${err}`);
      }

      const rawUploadUrl = await uploadUrlRes.json();
      const parsedUploadUrl = b2UploadUrlResponseSchema.safeParse(rawUploadUrl);
      if (!parsedUploadUrl.success) {
        throw new Error(`B2 get_upload_url response invalid: ${parsedUploadUrl.error.message}`);
      }

      // 2. Upload file bytes
      const uploadRes = await fetch(parsedUploadUrl.data.uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: parsedUploadUrl.data.authorizationToken,
          'X-Bz-File-Name': encodeURIComponent(key),
          'Content-Type': contentType,
          'Content-Length': bytes.length.toString(),
          'X-Bz-Content-Sha1': sha1,
        },
        body: bytes as BodyInit,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`B2 upload failed (${uploadRes.status}): ${err}`);
      }

      const rawUploaded = await uploadRes.json();
      const parsedUploaded = b2UploadResponseSchema.safeParse(rawUploaded);
      if (!parsedUploaded.success) {
        throw new Error(`B2 upload response invalid: ${parsedUploaded.error.message}`);
      }

      return {
        key,
        version: parsedUploaded.data.fileId,
        size: bytes.length,
        etag: parsedUploaded.data.contentSha1 || `"${sha1}"`,
        httpEtag: `"${sha1}"`,
        uploaded: new Date(),
        httpMetadata: { contentType },
        customMetadata: options?.customMetadata,
      } as unknown as R2Object;
    },

    async get(key: string, _options?: R2GetOptions): Promise<R2ObjectBody | null> {
      const auth = await getB2Auth(config);
      const res = await fetch(`${auth.downloadUrl}/file/${config.bucketName}/${encodeURIComponent(key)}`, {
        headers: { Authorization: auth.token },
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`B2 download failed (${res.status}): ${await res.text()}`);
      }

      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const size = Number(res.headers.get('content-length') || '0');

      return {
        key,
        size,
        httpMetadata: { contentType },
        body: res.body as unknown as ReadableStream,
        bodyUsed: false,
        async arrayBuffer() {
          return res.arrayBuffer();
        },
        async text() {
          return res.text();
        },
        async json() {
          return res.json();
        },
        async blob() {
          return res.blob();
        },
      } as unknown as R2ObjectBody;
    },

    async head(key: string): Promise<R2Object | null> {
      const auth = await getB2Auth(config);
      const res = await fetch(`${auth.downloadUrl}/file/${config.bucketName}/${encodeURIComponent(key)}`, {
        method: 'HEAD',
        headers: { Authorization: auth.token },
      });

      if (res.status === 404) return null;
      if (!res.ok) return null;

      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const size = Number(res.headers.get('content-length') || '0');

      return {
        key,
        size,
        httpMetadata: { contentType },
      } as unknown as R2Object;
    },

    async delete(keys: string | string[]): Promise<void> {
      const auth = await getB2Auth(config);
      const list = Array.isArray(keys) ? keys : [keys];

      for (const k of list) {
        const listRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_file_names`, {
          method: 'POST',
          headers: {
            Authorization: auth.token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            bucketId: config.bucketId,
            startFileName: encodeURIComponent(k),
            maxFileCount: 1,
          }),
        });

        if (listRes.ok) {
          const raw = await listRes.json();
          const parsed = b2ListFilesResponseSchema.safeParse(raw);
          if (parsed.success) {
            const match = parsed.data.files.find((f) => f.fileName === encodeURIComponent(k) || f.fileName === k);
            if (match) {
              await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
                method: 'POST',
                headers: {
                  Authorization: auth.token,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  fileName: match.fileName,
                  fileId: match.fileId,
                }),
              });
            }
          }
        }
      }
    },
  } as unknown as R2Bucket;
}
