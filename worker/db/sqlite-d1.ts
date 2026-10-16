import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result, D1ExecResult } from '@cloudflare/workers-types';

/**
 * Creates a Cloudflare D1-compatible database instance backed by Node.js 22's built-in node:sqlite.
 * Supports both in-memory databases (':memory:') and persistent SQLite files.
 */
export function createSqliteD1(filePath = ':memory:'): D1Database {
  const sqlite = new DatabaseSync(filePath);

  // Enable foreign keys
  sqlite.exec('PRAGMA foreign_keys = ON;');

  class MockPreparedStatement implements D1PreparedStatement {
    private query: string;
    private boundValues: unknown[];

    constructor(query: string, boundValues: unknown[] = []) {
      this.query = query;
      this.boundValues = boundValues;
    }

    bind(...values: unknown[]): D1PreparedStatement {
      return new MockPreparedStatement(this.query, values);
    }

    async first<T = unknown>(colName?: string): Promise<T | null> {
      try {
        const stmt = sqlite.prepare(this.query);
        const params = this.boundValues.map((v) => (v === undefined ? null : v));
        const row = stmt.get(...(params as any[])) as Record<string, unknown> | undefined;

        if (!row) {
          return null;
        }

        if (colName) {
          return (row[colName] as T) ?? null;
        }

        return row as T;
      } catch (err) {
        throw new Error(`D1 first error on "${this.query}": ${(err as Error).message}`);
      }
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      try {
        const stmt = sqlite.prepare(this.query);
        const params = this.boundValues.map((v) => (v === undefined ? null : v));
        const res = stmt.run(...(params as any[]));

        return {
          results: [],
          success: true,
          meta: {
            changes: Number(res.changes),
            last_row_id: Number(res.lastInsertRowid),
            duration: 0,
            rows_read: 0,
            rows_written: Number(res.changes),
            served_by: 'node:sqlite',
            size_after: 0,
            changed_db: true,
          } as any,
        };
      } catch (err) {
        throw new Error(`D1 run error on "${this.query}": ${(err as Error).message}`);
      }
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      try {
        const stmt = sqlite.prepare(this.query);
        const params = this.boundValues.map((v) => (v === undefined ? null : v));
        const rows = stmt.all(...(params as any[])) as T[];

        return {
          results: rows,
          success: true,
          meta: {
            changes: 0,
            last_row_id: 0,
            duration: 0,
            rows_read: rows.length,
            rows_written: 0,
            served_by: 'node:sqlite',
            size_after: 0,
            changed_db: false,
          } as any,
        };
      } catch (err) {
        throw new Error(`D1 all error on "${this.query}": ${(err as Error).message}`);
      }
    }

    async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<any> {
      const allRes = await this.all<Record<string, unknown>>();
      const rows = allRes.results.map((r) => Object.values(r) as T);
      if (options?.columnNames && allRes.results.length > 0) {
        const cols = Object.keys(allRes.results[0]!);
        return [cols, ...rows];
      }
      return rows;
    }
  }

  const d1 = {
    prepare(query: string): D1PreparedStatement {
      return new MockPreparedStatement(query);
    },

    async exec(query: string): Promise<D1ExecResult> {
      try {
        sqlite.exec(query);
        return {
          count: 1,
          duration: 0,
        };
      } catch (err) {
        throw new Error(`D1 exec error on "${query}": ${(err as Error).message}`);
      }
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      sqlite.exec('BEGIN TRANSACTION;');
      try {
        for (const s of statements) {
          const res = (await s.all()) as D1Result<T>;
          results.push(res);
        }
        sqlite.exec('COMMIT;');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK;');
        throw err;
      }
    },

    dump(): Promise<ArrayBuffer> {
      throw new Error('dump not implemented');
    },

    withSession(_token?: string): any {
      return this;
    },
  };

  return d1 as unknown as D1Database;
}
