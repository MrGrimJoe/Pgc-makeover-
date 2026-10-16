import { describe, it, expect } from 'vitest';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { runMigrations } from '../worker/db/migrate.ts';

describe('Migrations runner', () => {
  it('applies migrations from an empty database', async () => {
    // Brand new empty in-memory D1 database
    const db = createSqliteD1(':memory:');

    // Run migrations
    const result = await runMigrations(db);

    expect(result.applied).toContain('001_init.sql');
    expect(result.applied).toContain('002_social.sql');
    expect(result.applied).toContain('003_discovery.sql');

    // Verify _migrations tracking table contains migrations
    const migrationsRows = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
    const migrationNames = migrationsRows.results.map((r) => r.name);
    expect(migrationNames).toContain('001_init.sql');
    expect(migrationNames).toContain('002_social.sql');
    expect(migrationNames).toContain('003_discovery.sql');

    // Verify all required tables exist
    const tablesQuery = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all<{ name: string }>();

    const tableNames = tablesQuery.results.map((r) => r.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('profiles');
    expect(tableNames).toContain('user_settings');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('posts');
    expect(tableNames).toContain('media');
    expect(tableNames).toContain('post_media');
    expect(tableNames).toContain('post_reactions');
    expect(tableNames).toContain('comments');
    expect(tableNames).toContain('follows');
    expect(tableNames).toContain('reports');
    expect(tableNames).toContain('classes');
    expect(tableNames).toContain('topics');
    expect(tableNames).toContain('post_topics');
    expect(tableNames).toContain('user_topic_signals');
    expect(tableNames).toContain('impressions');
    expect(tableNames).toContain('feedback');
    expect(tableNames).toContain('trend_snapshots');
    expect(tableNames).toContain('rate_limits');
    expect(tableNames).toContain('_migrations');

    // Verify indexes exist
    const indexQuery = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
      )
      .all<{ name: string }>();

    const indexNames = indexQuery.results.map((r) => r.name);
    expect(indexNames).toContain('idx_users_provider_subject');
    expect(indexNames).toContain('idx_profiles_username_normalized');
    expect(indexNames).toContain('idx_posts_feed');
    expect(indexNames).toContain('idx_posts_expires_at');
    expect(indexNames).toContain('idx_post_topics_topic');
    expect(indexNames).toContain('idx_user_topic_signals_user');
    expect(indexNames).toContain('idx_rate_limits_key');
  });

  it('is idempotent when run multiple times', async () => {
    const db = createSqliteD1(':memory:');

    // First run
    const firstRun = await runMigrations(db);
    expect(firstRun.applied.length).toBe(3);

    // Second run: should not re-run applied migrations
    const secondRun = await runMigrations(db);
    expect(secondRun.applied.length).toBe(0);
  });
});
