/**
 * The chat background lives on the phone only. A choice is either one of the plain-CSS presets or an imported image
 * (downscaled to at most 1280 px WebP under about 300 KB) kept as a Blob in IndexedDB. Nothing is uploaded, so there
 * is no moderation and no storage cost. Keys include the user id so two accounts on one phone do not share a choice.
 */
import { DEFAULT_CHAT_BACKGROUND, isChatBackgroundId, type ChatBackgroundId } from '../../shared/chat-background.ts';
import { BACKGROUND_MAX_EDGE, browserMediaEnv, compressPhoto, type MediaEnv } from './media.ts';

export const CHAT_BG_MAX_BYTES = 300 * 1024;

export type ChatBackgroundChoice = { kind: 'preset'; id: ChatBackgroundId } | { kind: 'image'; blob: Blob };

interface StoredChoice {
  kind: 'preset' | 'image';
  id?: string;
  blob?: Blob;
}

const DB_NAME = 'student-network-local';
const STORE = 'chat-background';

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open local storage'));
  });
}

async function withStore<T>(idb: IDBFactory, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(idb);
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Local storage failed'));
    });
  } finally {
    db.close();
  }
}

/** Duck-typed so it also accepts Blobs rebuilt by structured clone in other realms (and test environments). */
function isBlobLike(b: unknown): b is Blob {
  return !!b && typeof b === 'object' && typeof (b as Blob).size === 'number' && (b as Blob).size > 0 && typeof (b as Blob).type === 'string';
}

const keyFor = (userId: string) => `bg:${userId}`;
const defaultIdb = () => (typeof indexedDB === 'undefined' ? null : indexedDB);

/** The saved choice, or the Plain preset when nothing is saved or storage is unavailable. */
export async function loadChatBackground(userId: string, idb: IDBFactory | null = defaultIdb()): Promise<ChatBackgroundChoice> {
  const fallback: ChatBackgroundChoice = { kind: 'preset', id: DEFAULT_CHAT_BACKGROUND };
  if (!idb) return fallback;
  try {
    const v = (await withStore(idb, 'readonly', (s) => s.get(keyFor(userId)))) as StoredChoice | undefined;
    if (v?.kind === 'image' && isBlobLike(v.blob)) return { kind: 'image', blob: v.blob };
    if (v?.kind === 'preset' && isChatBackgroundId(v.id)) return { kind: 'preset', id: v.id };
  } catch {
    // storage blocked (private mode): behave as if nothing was saved
  }
  return fallback;
}

export async function saveChatBackgroundPreset(userId: string, id: ChatBackgroundId, idb: IDBFactory | null = defaultIdb()): Promise<void> {
  if (!idb) throw new Error('This browser cannot save a chat background.');
  await withStore(idb, 'readwrite', (s) => s.put({ kind: 'preset', id } satisfies StoredChoice, keyFor(userId)));
}

/** Downscales the picked picture (1280 px, WebP, about 300 KB) and keeps it on the phone. Returns the stored blob. */
export async function saveChatBackgroundImage(
  userId: string,
  file: Blob,
  opts: { env?: MediaEnv; idb?: IDBFactory | null } = {}
): Promise<Blob> {
  const idb = opts.idb === undefined ? defaultIdb() : opts.idb;
  if (!idb) throw new Error('This browser cannot save a chat background.');
  const prepared = await compressPhoto(file, opts.env ?? browserMediaEnv(), { kind: 'background', maxEdge: BACKGROUND_MAX_EDGE, maxBytes: CHAT_BG_MAX_BYTES });
  await withStore(idb, 'readwrite', (s) => s.put({ kind: 'image', blob: prepared.blob } satisfies StoredChoice, keyFor(userId)));
  return prepared.blob;
}

export async function resetChatBackground(userId: string, idb: IDBFactory | null = defaultIdb()): Promise<void> {
  if (!idb) return;
  await withStore(idb, 'readwrite', (s) => s.delete(keyFor(userId)));
}
