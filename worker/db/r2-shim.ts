import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2GetOptions,
} from '@cloudflare/workers-types';

interface StoredR2Item {
  data: Uint8Array;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  uploaded: Date;
  size: number;
  etag: string;
}

/**
 * Creates an in-memory R2Bucket shim for local development and tests.
 */
export function createMemoryR2Bucket(): R2Bucket {
  const store = new Map<string, StoredR2Item>();

  const bucket = {
    async put(
      key: string,
      value: any,
      options?: R2PutOptions
    ): Promise<R2Object> {
      let bytes: Uint8Array;

      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value && typeof value.arrayBuffer === 'function') {
        const ab = await value.arrayBuffer();
        bytes = new Uint8Array(ab);
      } else if (value && typeof value.getReader === 'function') {
        const chunks: Uint8Array[] = [];
        const reader = value.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (chunk) chunks.push(chunk);
        }
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        bytes = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.length;
        }
      } else {
        bytes = new Uint8Array(0);
      }

      const item: StoredR2Item = {
        data: bytes,
        httpMetadata: options?.httpMetadata as Record<string, string> | undefined,
        customMetadata: options?.customMetadata,
        uploaded: new Date(),
        size: bytes.length,
        etag: `"${Math.random().toString(36).substring(2)}"`,
      };

      store.set(key, item);

      return {
        key,
        version: '1',
        size: item.size,
        etag: item.etag,
        httpEtag: item.etag,
        uploaded: item.uploaded,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata,
        range: undefined,
        checksums: {} as any,
        storageClass: 'Standard',
        writeHttpMetadata: () => {},
      } as unknown as R2Object;
    },

    async get(key: string, _options?: R2GetOptions): Promise<R2ObjectBody | null> {
      const item = store.get(key);
      if (!item) return null;

      const obj: R2ObjectBody = {
        key,
        version: '1',
        size: item.size,
        etag: item.etag,
        httpEtag: item.etag,
        uploaded: item.uploaded,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata,
        range: undefined,
        checksums: {} as any,
        storageClass: 'Standard',
        writeHttpMetadata: () => {},
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(item.data);
            controller.close();
          },
        }) as any,
        bodyUsed: false,
        async arrayBuffer() {
          return item.data.buffer.slice(
            item.data.byteOffset,
            item.data.byteOffset + item.data.byteLength
          ) as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(item.data);
        },
        async json() {
          return JSON.parse(new TextDecoder().decode(item.data));
        },
        async blob() {
          return new Blob([item.data as any], {
            type: item.httpMetadata?.contentType || 'application/octet-stream',
          });
        },
      } as unknown as R2ObjectBody;

      return obj;
    },

    async head(key: string): Promise<R2Object | null> {
      const item = store.get(key);
      if (!item) return null;

      return {
        key,
        version: '1',
        size: item.size,
        etag: item.etag,
        httpEtag: item.etag,
        uploaded: item.uploaded,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata,
        range: undefined,
        checksums: {} as any,
        storageClass: 'Standard',
        writeHttpMetadata: () => {},
      } as unknown as R2Object;
    },

    async delete(keys: string | string[]): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        store.delete(k);
      }
    },

    async list(): Promise<any> {
      const objects = Array.from(store.entries()).map(([key, item]) => ({
        key,
        size: item.size,
        etag: item.etag,
        uploaded: item.uploaded,
      }));
      return {
        objects,
        truncated: false,
      };
    },
  };

  return bucket as unknown as R2Bucket;
}
