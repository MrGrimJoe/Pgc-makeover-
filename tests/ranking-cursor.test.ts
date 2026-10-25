import { describe, it, expect } from 'vitest';
import { decodeDeliveredCursor, encodeDeliveredCursor, hashPostId } from '../worker/ranking/cursor.ts';

describe('ranked feed cursor', () => {
  it('round-trips the delivered posts', () => {
    const ids = ['post_1', 'usr-abc-123', 'a'.repeat(36)];
    const decoded = decodeDeliveredCursor(encodeDeliveredCursor(ids.map(hashPostId)));
    expect(decoded).toEqual(new Set(ids.map(hashPostId)));
  });

  it('gives different ids different hashes', () => {
    const hashes = new Set(Array.from({ length: 5000 }, (_, i) => hashPostId(`post_${i}`)));
    expect(hashes.size).toBe(5000);
  });

  it('stays small for a full candidate pool', () => {
    const cursor = encodeDeliveredCursor(Array.from({ length: 160 }, (_, i) => hashPostId(crypto.randomUUID() + i)));
    expect(cursor.length).toBeLessThan(2500);
  });

  it('treats a missing, legacy, malformed or oversized cursor as "start from the top"', () => {
    expect(decodeDeliveredCursor(null)).toBeNull();
    expect(decodeDeliveredCursor('')).toBeNull();
    expect(decodeDeliveredCursor('3')).toBeNull(); // old page-number cursor
    expect(decodeDeliveredCursor('d1:abc;DROP TABLE')).toBeNull();
    expect(decodeDeliveredCursor('d1:' + 'a'.repeat(9000))).toBeNull();
  });
});
