import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, uploadPng } from './_helpers.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import {
  contrastRatio,
  scrimmedWorstCase,
  resolveProfileStyle,
  CUSTOM_WALLPAPER,
  CUSTOM_WALLPAPER_SCRIM,
  CUSTOM_WALLPAPER_SCRIM_ALPHA,
} from '../shared/presets.ts';
import type { Env } from '../worker/types.ts';

const DAY = 86_400_000;

/** Smallest thing the sniffer accepts as WebP: RIFF, size, WEBP, then filler. */
function webpBytes(extra = 16): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(12 + extra));
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return out;
}

describe('Custom profile background: contrast', () => {
  it('white text on a pure white image under the scrim reaches 4.5:1 (worst case)', () => {
    expect(scrimmedWorstCase()).toBe('#737373');
    const ratio = contrastRatio('#ffffff', scrimmedWorstCase());
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.9); // about 4.7, so the margin is real but small
    // Muted text is white too, so it gets the same guarantee
    expect(contrastRatio(CUSTOM_WALLPAPER.muted, scrimmedWorstCase())).toBeGreaterThanOrEqual(4.5);
  });

  it('positive control: a weaker scrim would fail the same check, and no scrim is unreadable', () => {
    const composite = (alpha: number) => {
      const v = Math.round(255 * (1 - alpha)).toString(16).padStart(2, '0');
      return `#${v}${v}${v}`;
    };
    expect(contrastRatio('#ffffff', composite(0.3))).toBeLessThan(4.5);
    expect(contrastRatio('#ffffff', composite(0))).toBeCloseTo(1, 1);
    expect(contrastRatio('#ffffff', composite(CUSTOM_WALLPAPER_SCRIM_ALPHA))).toBeGreaterThanOrEqual(4.5);
  });

  it('chips and buttons sit on an opaque dark surface, readable with white text', () => {
    expect(contrastRatio(CUSTOM_WALLPAPER.text, CUSTOM_WALLPAPER.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('the header always draws the scrim as the top layer of the image', () => {
    const style = resolveProfileStyle({ wallpaper_id: 'custom', wallpaper_media_id: 'med_abc' });
    const bg = style.headerStyle.backgroundImage!;
    expect(bg.startsWith(`linear-gradient(${CUSTOM_WALLPAPER_SCRIM}, ${CUSTOM_WALLPAPER_SCRIM})`)).toBe(true);
    expect(bg).toContain('url(/api/media/med_abc)');
    expect(style.headerStyle.color).toBe('#ffffff');
    expect(style.accent).toBeNull();
  });

  it("'custom' without an image falls back to the default wallpaper (and a preset is unchanged)", () => {
    const none = resolveProfileStyle({ wallpaper_id: 'custom', wallpaper_media_id: null });
    expect(none.wallpaper.id).toBe('plain');
    expect(none.headerStyle.backgroundImage).toBeUndefined();
    expect(resolveProfileStyle({ wallpaper_id: 'plain' }).headerStyle).toEqual({});
  });

  it('a media id cannot break out of the url() (it is encoded)', () => {
    const style = resolveProfileStyle({ wallpaper_id: 'custom', wallpaper_media_id: 'x);background:red;(' });
    expect(style.headerStyle.backgroundImage).not.toContain('x);background:red');
  });
});

describe('Custom profile background: API', () => {
  let env: Env;
  let alice: string;
  let bob: string;

  const uploadBg = async (cookie: string, kind = 'background', bytes: Uint8Array<ArrayBuffer> = webpBytes()): Promise<string> => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/webp' }), 'bg.webp');
    form.append('kind', kind);
    const res = await call(env, 'POST', '/api/media/uploads', { cookie, form });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.id;
  };
  const exists = async (id: string) =>
    ((await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(id).first<{ n: number }>())?.n ?? 0) === 1;
  const age = (id: string, ms: number) =>
    env.DB.prepare('UPDATE media SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - ms).toISOString(), id).run();

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
  });

  it('the owner sets an image: wallpaper becomes custom and both ids are returned', async () => {
    const id = await uploadBg(alice);
    const res = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    expect(res.status).toBe(200);
    expect(res.json.profile.wallpaper_id).toBe('custom');
    expect(res.json.profile.wallpaper_media_id).toBe(id);
    const asBob = await call(env, 'GET', '/api/users/alice', { cookie: bob });
    expect(asBob.json.wallpaper_id).toBe('custom');
    expect(asBob.json.wallpaper_media_id).toBe(id);
  });

  it('rejects a photo-kind upload, someone else\'s background, unknown ids and a preset sent with an image', async () => {
    const photo = await uploadPng(env, alice);
    const aliceBg = await uploadBg(alice);
    const bobBg = await uploadBg(bob);
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: photo } })).status).toBe(400);
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: bobBg } })).status).toBe(400);
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: 'med_missing' } })).status).toBe(400);
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: aliceBg, wallpaper_id: 'plain' } })).status).toBe(400);
    const me = await call(env, 'GET', '/api/me', { cookie: alice });
    expect(me.json.profile.wallpaper_media_id).toBeNull();
    expect(me.json.profile.wallpaper_id ?? null).toBeNull();
    // positive control: the same image, sent correctly, works
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: aliceBg } })).status).toBe(200);
  });

  it("'custom' needs an image; choosing a preset or removing the image clears it", async () => {
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'custom' } })).status).toBe(400);
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'custom', wallpaper_media_id: null } })).status).toBe(400);

    const id = await uploadBg(alice);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    // switching to 'custom' again with the stored image is fine
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'custom' } })).json.profile.wallpaper_media_id).toBe(id);
    // a preset clears the image
    const preset = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'plain' } });
    expect(preset.json.profile.wallpaper_media_id).toBeNull();
    expect(preset.json.profile.wallpaper_id ?? null).toBeNull();
    // set again, then remove with null
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    const removed = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: null } });
    expect(removed.json.profile.wallpaper_media_id).toBeNull();
    expect(removed.json.profile.wallpaper_id ?? null).toBeNull();
  });

  it('other signed-in people can read it, blocked people and signed-out visitors cannot', async () => {
    const id = await uploadBg(alice);
    // before it is a wallpaper it is private (positive control for the rule below)
    expect((await call(env, 'GET', `/api/media/${id}`, { cookie: bob })).status).toBe(403);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    const ok = await call(env, 'GET', `/api/media/${id}`, { cookie: bob });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call(env, 'GET', `/api/media/${id}`)).status).toBeGreaterThanOrEqual(401);
    await call(env, 'POST', '/api/blocks/usr_bob', { cookie: alice, json: { user_id: 'usr_bob' } });
    expect((await call(env, 'GET', `/api/media/${id}`, { cookie: bob })).status).toBe(403);
    // and a blocked viewer does not get the profile either
    expect((await call(env, 'GET', '/api/users/alice', { cookie: bob })).status).toBe(404);
  });

  it('survives the cleanup job while it is the wallpaper; once removed it is cleaned up (positive control)', async () => {
    const id = await uploadBg(alice);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    await age(id, 30 * DAY);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(true);

    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: null } });
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(false);
  });

  it('replacing the image leaves the old one to the cleanup job and keeps the new one', async () => {
    const a = await uploadBg(alice, 'background', webpBytes(16));
    const b = await uploadBg(alice, 'background', webpBytes(32));
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: a } });
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: b } });
    await age(a, 3 * DAY);
    await age(b, 3 * DAY);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
  });

  it('is removed with the account (row and R2 object)', async () => {
    const id = await uploadBg(alice);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    const key = (await env.DB.prepare('SELECT object_key FROM media WHERE id = ?').bind(id).first<{ object_key: string }>())!.object_key;
    expect(await env.MEDIA_BUCKET!.get(key)).not.toBeNull();
    expect((await call(env, 'DELETE', '/api/me', { cookie: alice })).status).toBe(200);
    expect(await exists(id)).toBe(false);
    expect(await env.MEDIA_BUCKET!.get(key)).toBeNull();
  });

  it('a user report records the background image so a moderator can identify the file', async () => {
    const id = await uploadBg(alice);
    // report without a background first (positive control: no evidence row)
    const clean = await call(env, 'POST', '/api/reports', { cookie: bob, json: { target_type: 'user', target_id: 'usr_alice', reason: 'spam' } });
    expect(clean.status).toBe(201);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM report_evidence WHERE report_id = ?').bind(clean.json.id).first<{ n: number }>())!.n).toBe(0);

    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_media_id: id } });
    await env.DB.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").bind(clean.json.id).run();
    const rep = await call(env, 'POST', '/api/reports', { cookie: bob, json: { target_type: 'user', target_id: 'usr_alice', reason: 'inappropriate picture' } });
    expect(rep.status).toBe(201);
    const row = await env.DB.prepare('SELECT snapshot FROM report_evidence WHERE report_id = ?').bind(rep.json.id).first<{ snapshot: string }>();
    expect(JSON.parse(row!.snapshot).attachments[0].media_id).toBe(id);
  });
});
