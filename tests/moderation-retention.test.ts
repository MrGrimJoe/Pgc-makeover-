import { describe, it, expect } from 'vitest';
import { makeEnv, seedUser } from './_helpers.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';

const day = 24 * 60 * 60 * 1000;
const ago = (n: number, ref: number) => new Date(ref - n * day).toISOString();

describe('moderation record retention', () => {
  it('deletes handled records after their time and never touches open ones', async () => {
    const env = await makeEnv();
    await seedUser(env, 'usr_a', 'user_a');
    await seedUser(env, 'usr_b', 'user_b');
    const ref = Date.now();
    const rep = (id: string, status: string, age: number) =>
      env.DB.prepare("INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?, 'usr_a', 'user', 'usr_b', 'spam', ?, ?)").bind(id, status, ago(age, ref)).run();
    await rep('old_pending', 'pending', 400);
    await rep('old_reviewed', 'reviewed', 100);
    await rep('old_dismissed', 'dismissed', 91);
    await rep('new_reviewed', 'reviewed', 10);
    const disp = (id: string, status: string, resolvedAge: number | null) =>
      env.DB.prepare("INSERT INTO registration_disputes (id, provider_subject, campus_key, roll_key, status, created_at, resolved_at) VALUES (?, ?, 'c', ?, ?, ?, ?)").bind(id, id, id, status, ago(500, ref), resolvedAge === null ? null : ago(resolvedAge, ref)).run();
    await disp('d_open_old', 'open', null);
    await disp('d_done_old', 'resolved', 120);
    await disp('d_done_new', 'resolved', 5);
    const appeal = (id: string, status: string, decidedAge: number | null, user: string) =>
      env.DB.prepare("INSERT INTO appeals (id, user_id, message, status, account_status, created_at, decided_at) VALUES (?, ?, 'm', ?, 'suspended', ?, ?)").bind(id, user, status, ago(400, ref), decidedAge === null ? null : ago(decidedAge, ref)).run();
    await appeal('a_open_old', 'open', null, 'usr_a');
    await appeal('a_denied_old', 'denied', 200, 'usr_b');
    await env.DB.prepare("INSERT INTO appeal_tickets (id, user_id, expires_at) VALUES ('t_old', 'usr_a', ?), ('t_live', 'usr_a', ?)").bind(ago(1, ref), new Date(ref + day).toISOString()).run();

    await runPostLifecycleExpiry(env, ref);

    const ids = async (sql: string) => ((await env.DB.prepare(sql).all<{ id: string }>()).results || []).map((r) => r.id).sort();
    expect(await ids('SELECT id FROM reports')).toEqual(['new_reviewed', 'old_pending']);
    expect(await ids('SELECT id FROM registration_disputes')).toEqual(['d_done_new', 'd_open_old']);
    expect(await ids('SELECT id FROM appeals')).toEqual(['a_open_old']);
    expect(await ids('SELECT id FROM appeal_tickets')).toEqual(['t_live']);
  });
});
