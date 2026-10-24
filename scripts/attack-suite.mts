/**
 * Adversarial test for the Worker: runs real requests against the in-memory D1 and checks that
 * every abuse case is refused. Run with:  npm run attack   (Node 22+, needs node:sqlite)
 * Expected on a healthy build: every check HELD, 0 BROKEN, 0 5xx-crashes.
 *
 * Rules for adding checks: assert a 4xx (not the reason), and add a POSITIVE CONTROL whenever a
 * check asserts that something is hidden or empty, so a broken query cannot pass by returning nothing.
 */
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { CAMPUSES } from '../shared/campuses.ts';
import { STICKER_PACKS } from '../shared/stickers.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';

const db: any = createSqliteD1(':memory:'); const r2: any = createMemoryR2Bucket();
await runMigrations(db, ALL_MIGRATIONS);
const base: any = { DB: db, MEDIA_BUCKET: r2, APP_URL: 'https://app.test', GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'x' };
const prod = { ...base, ENVIRONMENT: 'production', ADMIN_SECRET: 's3cret-value', ROLL_KEY_SECRET: 'attack-suite-roll-secret' };
const dev = { ...base, ENVIRONMENT: 'development' };
const now = new Date().toISOString(), exp = new Date(Date.now() + 864e5).toISOString();
const seed = async (id: string, name: string, dm = 'everyone') => {
  await db.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?,?,?,?)').bind(id, 'sub_' + id, now, 'active').run();
  await db.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?,?,?,?,?)').bind(id, name, name, name, '').run();
  await db.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?,?)').bind(id, dm).run();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').bind('sess_' + id, id, exp).run();
  return 'session_id=sess_' + id;
};
const A = await seed('usr_alice', 'alice'), B = await seed('usr_bob', 'bob'), C = await seed('usr_carol', 'carol'), D = await seed('usr_dave', 'dave', 'followed_only');
const fives: string[] = []; const results: [string, boolean, string][] = [];
const call = async (method: string, path: string, o: any = {}) => {
  const headers: any = { ...(o.headers || {}) }; if (o.cookie) headers.Cookie = o.cookie;
  let body = o.raw; if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = 'application/json'; }
  if (o.form) body = o.form;
  let res: Response;
  try { res = await worker.fetch(new Request('https://app.test' + path, { method, headers, body }), o.env || prod, {} as any); }
  catch (e: any) { fives.push(`UNCAUGHT THROW ${method} ${path} -> ${String(e.message).split('\n')[0].slice(0,90)}`); return { s: 599, j: null, text: '', h: new Headers() }; }
  const text = await res.text(); let j: any = null; try { j = JSON.parse(text); } catch {}
  if (res.status >= 500) fives.push(`${method} ${path} -> ${res.status} ${text.slice(0, 80)}`);
  return { s: res.status, j, text, h: res.headers };
};
const ok = (n: string, c: boolean, d = '') => results.push([n, c, d]);
const idOf = (j: any) => j?.id ?? j?.post?.id ?? j?.comment?.id ?? j?.conversation?.id ?? j?.media?.id ?? j?.message?.id;
const clearRL = async () => { try { await db.prepare('DELETE FROM rate_limits').run(); } catch {} };

// ---------- AUTH ----------
let r = await call('GET', '/api/auth/google?mock=true'); ok('prod: mock authorize does not issue mock redirect', !String(r.h.get('location') || '').includes('mock_code'), `status ${r.s}`);
r = await call('GET', '/api/auth/callback?code=mock_x&state=abc&mock=true', { cookie: 'oauth_state=' + btoa(JSON.stringify({ state: 'abc', nonce: 'n', verifier: 'v' })) }); ok('prod: mock callback rejected', r.s >= 400 && !(r.h.get('set-cookie') || '').includes('session_id'), `status ${r.s}`);
r = await call('GET', '/api/me', { cookie: "session_id=' OR '1'='1" }); ok('SQLi in session cookie -> 401', r.s === 401, `status ${r.s}`);
await db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES ('sess_old','usr_alice',?)").bind(new Date(Date.now() - 1000).toISOString()).run();
r = await call('GET', '/api/me', { cookie: 'session_id=sess_old' }); ok('expired session -> 401', r.s === 401, `status ${r.s}`);
await db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES ('sess_lo','usr_carol',?)").bind(exp).run();
await call('POST', '/api/auth/logout', { cookie: 'session_id=sess_lo' }); r = await call('GET', '/api/me', { cookie: 'session_id=sess_lo' }); ok('logout invalidates the session server-side', r.s === 401, `status ${r.s}`);
const open = ['/api/feed', '/api/me', '/api/search?q=a', '/api/trends', '/api/conversations', '/api/blocks', '/api/classes', '/api/me/interests', '/api/users/alice', '/api/people/suggested', '/api/username-available?u=abc', '/api/signup/session'];
const openRes = []; for (const p of open) openRes.push(p + ':' + (await call('GET', p)).s); ok('unauthenticated GETs all 401', openRes.every(x => x.endsWith(':401')), openRes.join(' '));

// ---------- IDOR ----------
r = await call('POST', '/api/posts', { cookie: A, json: { body: 'alice private thought #secret' } }); const alicePost = idOf(r.j); ok('setup: alice posts', !!alicePost, `status ${r.s} ${r.text.slice(0, 60)}`);
r = await call('DELETE', '/api/posts/' + alicePost, { cookie: B }); ok("bob cannot delete alice's post", r.s === 403 || r.s === 404, `status ${r.s}`);
r = await call('POST', '/api/posts/' + alicePost + '/comments', { cookie: A, json: { body: 'my own comment' } }); const aliceComment = idOf(r.j);
r = await call('DELETE', '/api/comments/' + aliceComment, { cookie: B }); ok("bob cannot delete alice's comment", r.s === 403 || r.s === 404, `status ${r.s}`);
const fd = new FormData(); fd.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], { type: 'image/png' }), 'a.png');
r = await call('POST', '/api/media/uploads', { cookie: A, form: fd }); const aliceMedia = idOf(r.j); ok('setup: alice uploads png', !!aliceMedia, `status ${r.s} ${r.text.slice(0, 60)}`);
r = await call('DELETE', '/api/media/' + aliceMedia, { cookie: B }); ok("bob cannot delete alice's media", r.s === 403 || r.s === 404, `status ${r.s}`);
r = await call('GET', '/api/media/' + aliceMedia, { cookie: B }); ok("bob cannot read alice's UNATTACHED upload (info)", r.s === 403 || r.s === 404, `status ${r.s} (design question)`);
r = await call('POST', '/api/conversations', { cookie: A, json: { user_id: 'usr_carol' } }); const convAC = idOf(r.j);
await call('POST', `/api/conversations/${convAC}/messages`, { cookie: A, json: { body: 'secret hello carol' } });
r = await call('GET', `/api/conversations/${convAC}/messages`, { cookie: B }); ok('bob cannot read alice-carol messages', r.s === 403 || r.s === 404, `status ${r.s}`);
r = await call('POST', `/api/conversations/${convAC}/messages`, { cookie: B, json: { body: 'injected' } }); ok('bob cannot post into alice-carol thread', r.s === 403 || r.s === 404, `status ${r.s}`);
r = await call('GET', '/api/conversations', { cookie: B }); ok("bob's conversation list does not leak others", !r.text.includes('secret hello'), '');
r = await call('PATCH', '/api/me', { cookie: B, json: { username: 'bobby', user_id: 'usr_alice', id: 'usr_alice', status: 'banned', provider_subject: 'x' } });
const al = await db.prepare("SELECT username FROM profiles WHERE user_id='usr_alice'").first(); const bo = await db.prepare("SELECT status FROM users WHERE id='usr_bob'").first();
ok('mass assignment: alice untouched, bob status untouched', al.username === 'alice' && bo.status === 'active', `patch ${r.s}, alice=${al.username}, bob=${bo.status}`);

// ---------- ADMIN / JOB ----------
r = await call('POST', '/api/jobs/cleanup-expired?reference_time=9999999999999', { cookie: B }); ok('job endpoint: normal user rejected (prod)', r.s === 401 || r.s === 403, `status ${r.s}`);
r = await call('POST', '/api/jobs/cleanup-expired?reference_time=9999999999999', { cookie: B, headers: { 'x-admin-secret': 'wrong' } }); ok('job endpoint: wrong secret rejected', r.s === 403 || r.s === 401, `status ${r.s}`);
r = await call('GET', '/api/admin/reports', { cookie: B }); ok('admin reports: normal user rejected', r.s === 401 || r.s === 403, `status ${r.s}`);
r = await call('GET', '/api/admin/reports', { headers: { 'x-admin-secret': 'wrongwrong' } }); ok('admin reports: wrong secret rejected', r.s === 403, `status ${r.s}`);
r = await call('POST', '/api/jobs/cleanup-expired?reference_time=9999999999999', { env: { ...prod, ADMIN_SECRET: undefined } }); ok('job endpoint: unconfigured secret in prod stays closed', r.s === 401 || r.s === 403, `status ${r.s}`);
const survived = await db.prepare("SELECT COUNT(*) c FROM posts WHERE id=?").bind(alicePost).first(); ok("alice's post still exists after attacks", survived.c === 1, '');

// ---------- INPUT ABUSE ----------
await clearRL();
for (const q of ["' OR 1=1 --", '%', '_', '"*', 'NEAR(', 'a" OR b', '\u0000', '😀'.repeat(500), 'x'.repeat(5000)]) { await call('GET', '/api/search?q=' + encodeURIComponent(q), { cookie: B }); }
for (const c of ['garbage', '-1', '9'.repeat(40), '{"a":1}', '%00']) { await call('GET', '/api/feed?cursor=' + encodeURIComponent(c), { cookie: B }); await call('GET', '/api/conversations/' + convAC + '/messages?cursor=' + encodeURIComponent(c), { cookie: A }); }
for (const l of ['0', '-5', '100000', 'abc']) { r = await call('GET', '/api/feed?limit=' + l, { cookie: B }); }
await clearRL();
r = await call('POST', '/api/posts', { cookie: B, json: { body: 'x'.repeat(1001) } }); ok('1001-char post rejected 400', r.s === 400, `status ${r.s}`);
r = await call('POST', '/api/posts', { cookie: B, raw: '{not json', headers: { 'Content-Type': 'application/json' } }); ok('invalid JSON -> 400 not 500', r.s === 400, `status ${r.s}`);
r = await call('POST', '/api/posts', { cookie: B, raw: JSON.stringify({ body: 'x'.repeat(2_000_000) }), headers: { 'Content-Type': 'application/json' } }); ok('2MB JSON body rejected without crash', r.s >= 400 && r.s < 500, `status ${r.s}`);
r = await call('POST', '/api/posts', { cookie: B, json: [1, 2, 3] }); ok('array body -> 400', r.s === 400, `status ${r.s}`);
r = await call('POST', '/api/posts', { cookie: B, json: { body: 'x', media_ids: ['../../etc/passwd', aliceMedia] } }); ok("cannot attach someone else's / bogus media to a post", r.s >= 400 && r.s < 500, `status ${r.s}`);
r = await call('POST', '/api/posts', { cookie: B, json: { body: `<script>alert(1)</script> <img src=x onerror=alert(1)> #xss" OR 1=1 --` } }); ok('XSS/SQLi-looking post stored as inert text (JSON api)', r.s === 201 && (r.h.get('content-type') || '').includes('json'), `status ${r.s}`);
for (const u of ['аlice', 'ali\u200Bce', 'ALICE', 'a'.repeat(200), 'bob; DROP TABLE users', '../x', 'alice ']) { r = await call('PATCH', '/api/me', { cookie: C, json: { username: u } }); ok(`username "${JSON.stringify(u).slice(0, 18)}" cannot steal/collide`, r.s >= 400 && r.s < 500, `status ${r.s}`); }
for (const bad of [{ bio: 'x'.repeat(100000) }, { display_name: '' }, { feed_preferences: 'y'.repeat(1_000_000) }, { class_id: 'nope' }, { dm_policy: 'admin' }]) { r = await call('PATCH', '/api/me', { cookie: C, json: bad }); ok(`PATCH /api/me ${JSON.stringify(bad).slice(0, 28)} rejected`, r.s >= 400 && r.s < 500, `status ${r.s}`); }

// ---------- MEDIA ----------
const up = async (bytes: Uint8Array, type: string, name: string, cookie = B) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); return call('POST', '/api/media/uploads', { cookie, form: f }); };
const enc = new TextEncoder();
r = await up(enc.encode('<html><script>alert(1)</script></html>'), 'image/png', 'x.png'); ok('HTML disguised as png rejected', r.s === 400 || r.s === 415, `status ${r.s}`);
r = await up(enc.encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/svg+xml', 'x.svg'); ok('SVG rejected', r.s >= 400 && r.s < 500, `status ${r.s}`);
r = await up(new Uint8Array(6 * 1024 * 1024), 'image/png', 'big.png'); ok('6MB file rejected', r.s === 413 || r.s === 400, `status ${r.s}`);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc.encode('<script>alert(1)</script>')]);
r = await up(png, 'image/png', 'poly.png'); const polyId = idOf(r.j); if (polyId) { const g = await call('GET', '/api/media/' + polyId, { cookie: B }); ok('polyglot png served as image/png with nosniff', (g.h.get('content-type') || '').startsWith('image/png') && (g.h.get('x-content-type-options') || '') === 'nosniff', `ct=${g.h.get('content-type')} nosniff=${g.h.get('x-content-type-options')}`); }
r = await up(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), 'text/html', 'x.html'); ok('declared text/html rejected', r.s >= 400 && r.s < 500, `status ${r.s}`);

// ---------- SOCIAL LOGIC ----------
await clearRL();
r = await call('POST', '/api/users/usr_bob/follow', { cookie: B }); ok('self-follow rejected', r.s >= 400 && r.s < 500, `status ${r.s}`);
await call('POST', '/api/users/usr_alice/follow', { cookie: B }); await call('POST', '/api/users/usr_alice/follow', { cookie: B });
let n = (await db.prepare("SELECT COUNT(*) c FROM follows WHERE follower_id='usr_bob' AND followed_id='usr_alice'").first()).c; ok('double follow = 1 row', n === 1, `rows ${n}`);
r = await call('POST', '/api/users/usr_ghost/follow', { cookie: B }); ok('follow nonexistent user -> 4xx', r.s >= 400 && r.s < 500, `status ${r.s}`);
await Promise.all(Array.from({ length: 20 }, () => call('POST', `/api/posts/${alicePost}/likes`, { cookie: B })));
n = (await db.prepare('SELECT COUNT(*) c FROM post_reactions WHERE post_id=? AND user_id=?').bind(alicePost, 'usr_bob').first()).c; ok('20 parallel likes by one user = 1 row', n === 1, `rows ${n}`);
await clearRL();
const raceU = await Promise.all([call('PATCH', '/api/me', { cookie: C, json: { username: 'samename' } }), call('PATCH', '/api/me', { cookie: D, json: { username: 'samename' } })]);
ok('username race: exactly one wins, loser gets 409 not 500', raceU.filter(x => x.s === 200).length === 1 && raceU.some(x => x.s === 409), raceU.map(x => x.s).join(','));
// blocks
await clearRL();
r = await call('POST', '/api/blocks/usr_bob', { cookie: A, json: { user_id: 'usr_bob' } }); ok('alice blocks bob', r.s < 300, `status ${r.s}`);
const bf = await call('GET', '/api/feed', { cookie: B }); ok("blocked bob can't see alice's posts in feed", !bf.text.includes('alice private thought'), '');
await call('POST', '/api/posts', { cookie: C, json: { body: 'carol visible post' } });
for (const [who, ck] of [['blocker alice', A], ['blocked bob', B]] as const) { const pf = await call('GET', '/api/feed?mode=for_you&limit=10', { cookie: ck }); ok(`POSITIVE CONTROL: ${who} still sees other people's posts in the For-you feed`, pf.text.includes('carol visible post'), `status ${pf.s}, body ${pf.text.slice(0, 60)}`); }
const bs = await call('GET', '/api/search?q=alice', { cookie: B }); ok('blocked bob cannot find alice in search', !bs.text.includes('"alice"'), bs.text.slice(0, 80));
r = await call('GET', '/api/posts/' + alicePost, { cookie: B }); ok("bob cannot open alice's post by id after block", r.s === 403 || r.s === 404, `status ${r.s}  (spec said exclude from feeds/search/comments/profile)`);
r = await call('GET', '/api/users/alice', { cookie: B }); ok("bob cannot open alice's profile after block", r.s === 403 || r.s === 404, `status ${r.s}`);
r = await call('POST', '/api/conversations', { cookie: B, json: { user_id: 'usr_alice' } }); ok('blocked bob cannot start DM with alice', r.s === 403, `status ${r.s}`);
r = await call('POST', '/api/conversations', { cookie: A, json: { user_id: 'usr_bob' } }); ok('alice (blocker) cannot DM bob either', r.s === 403, `status ${r.s}`);
r = await call('POST', '/api/users/usr_alice/follow', { cookie: B }); ok('blocked bob cannot follow alice', r.s === 403, `status ${r.s}`);
r = await call('POST', `/api/posts/${alicePost}/comments`, { cookie: B, json: { body: 'hi from blocked bob' } }); ok("blocked bob cannot comment on alice's post", r.s >= 400 && r.s < 500, `status ${r.s}`);
r = await call('POST', `/api/posts/${alicePost}/likes`, { cookie: B }); ok("blocked bob cannot like alice's post", r.s >= 400 && r.s < 500, `status ${r.s}`);
// dm policy
r = await call('POST', '/api/conversations', { cookie: C, json: { user_id: 'usr_dave' } }); ok('followed_only DM policy blocks non-follower', r.s === 403, `status ${r.s}`);
r = await call('POST', '/api/conversations', { cookie: C, json: { user_id: 'usr_ghost' } }); ok('DM to nonexistent user 4xx', r.s >= 400 && r.s < 500, `status ${r.s}`);
r = await call('POST', '/api/conversations', { cookie: C, json: { user_id: 'usr_carol' } }); ok('DM to self rejected', r.s >= 400 && r.s < 500, `status ${r.s}`);

// ---------- SIGN UP, CAMPUSES, PRIVACY, STYLES ----------
await clearRL();
const CMP_A = CAMPUSES.find((c) => c.city === 'Lahore')!.id; // campus names ship inside the app, nothing is seeded
const startSignup = async (sub: string, email: string) => {
  const init = await call('GET', `/api/auth/google?mock=true&intent=signup&mock_sub=${sub}&mock_email=${encodeURIComponent(email)}&mock_name=Test`, { env: dev });
  const state = /oauth_state=([^;]+)/.exec(init.h.get('set-cookie') || '')?.[1] || '';
  const cb = await call('GET', init.h.get('location') || '/', { env: dev, cookie: 'oauth_state=' + state });
  const t = /signup_ticket=([^;]+)/.exec(cb.h.get('set-cookie') || '')?.[1];
  return { cookie: t ? 'signup_ticket=' + t : '', location: cb.h.get('location') || '' };
};
const VALID = { real_name: 'Ayesha Khan', username: 'ayesha_k', campus_id: CMP_A, class_id: 'cls_2026', roll_number: '2024-0907', card: { barcode: '20240907' } };
// log in never creates accounts
const initLogin = await call('GET', '/api/auth/google?mock=true&intent=login&mock_sub=stranger', { env: dev });
const cbLogin = await call('GET', initLogin.h.get('location') || '/', { env: dev, cookie: 'oauth_state=' + (/oauth_state=([^;]+)/.exec(initLogin.h.get('set-cookie') || '')?.[1] || '') });
const strangers = (await db.prepare("SELECT COUNT(*) c FROM users WHERE provider_subject LIKE '%stranger%'").first()).c;
ok('log in with an unknown Google account creates no user', cbLogin.h.get('location') === '/?auth=no_account' && strangers === 0, `location ${cbLogin.h.get('location')}, rows ${strangers}`);
r = await call('GET', '/api/auth/google?intent=superadmin'); ok('unknown intent rejected', r.s === 400, `status ${r.s}`);
// forged and missing tickets
for (const [label, ck] of [['no cookie', undefined], ['forged ticket', 'signup_ticket=tkt_forged'], ['SQLi ticket', "signup_ticket=' OR '1'='1"]] as const) {
  r = await call('POST', '/api/signup/complete', { cookie: ck, json: VALID }); ok(`signup complete with ${label} -> 401`, r.s === 401, `status ${r.s}`);
  r = await call('GET', '/api/campuses', { cookie: ck }); ok(`removed campus list route stays gone (${label}) -> 404`, r.s === 404, `status ${r.s}`);
}
const t1 = await startSignup('att1', 'attacker.one@gmail.com');
ok('POSITIVE CONTROL: sign up ticket is issued for a new Google account', t1.cookie.startsWith('signup_ticket=tkt_') && t1.location === '/?signup=1', `cookie ${t1.cookie.slice(0, 20)} loc ${t1.location}`);
// input abuse on signup
for (const [label, patch] of [['roll too short', { roll_number: '9' }], ['roll markup', { roll_number: '9<7>' }], ['roll SQLi', { roll_number: "9'); --" }], ['old roll_last3 field', { roll_last3: '907' }], ['mass assignment', { status: 'admin', id: 'usr_alice' }], ['SQLi campus id', { campus_id: "x' OR '1'='1" }], ['unknown class', { class_id: 'cls_nope' }], ['reserved username', { username: 'admin' }], ['markup in real name', { real_name: '<img src=x onerror=alert(1)>' }], ['taken username', { username: 'alice' }]] as const) {
  await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: t1.cookie, json: { ...VALID, ...patch } }); ok(`signup complete: ${label} rejected`, r.s >= 400 && r.s < 500, `status ${r.s}`);
}
const noUsersYet = (await db.prepare("SELECT COUNT(*) c FROM profiles WHERE username_normalized='ayesha_k'").first()).c; ok('no account was created by the rejected attempts', noUsersYet === 0, `rows ${noUsersYet}`);
// campus input abuse: the list is bundled, so the only free text is campus_other
await clearRL();
for (const [m, path] of [['GET', '/api/campuses'], ['GET', '/api/campuses?q=central'], ['GET', '/api/campuses/cities'], ['POST', '/api/campuses'], ['GET', '/api/admin/campuses'], ['PATCH', '/api/admin/campuses/x']] as const) { r = await call(m, path, { cookie: t1.cookie, headers: { 'x-admin-secret': 's3cret-value' }, json: m === 'GET' ? undefined : { name: 'Pending Hills College' } }); ok(`removed route ${m} ${path.slice(0, 24)} -> 404`, r.s === 404, `status ${r.s}`); }
const bundledCount = CAMPUSES.length; ok('POSITIVE CONTROL: the bundled campus list is loaded', bundledCount > 100 && CAMPUSES.some((c) => c.id === CMP_A), `count ${bundledCount}`);
for (const [label, patch] of [['markup', { campus_other: '<script>alert(1)</script>' }], ['one character', { campus_other: 'a' }], ['500 characters', { campus_other: 'x'.repeat(500) }], ['array', { campus_other: ['array'] }], ['control character', { campus_other: 'Bell\u0007' }], ['both fields', { campus_other: 'Green Valley College' }], ['status mass assignment', { campus_other: 'Green Valley College', status: 'approved' }]] as const) { await clearRL(); const { campus_id: _drop, ...rest } = VALID; const body = label === 'both fields' ? { ...VALID, ...patch } : { ...rest, ...patch }; r = await call('POST', '/api/signup/complete', { cookie: t1.cookie, json: body }); ok(`signup campus_other: ${label} rejected`, r.s >= 400 && r.s < 500, `status ${r.s}`); }
{ const { campus_id: _drop, ...rest } = VALID; await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: t1.cookie, json: rest }); ok('signup with neither campus nor campus_other rejected', r.s >= 400 && r.s < 500, `status ${r.s}`); }
for (const [label, patch] of [['unknown id', { campus_id: 'cmp_not_in_list' }], ['SQLi id', { campus_id: "x' OR '1'='1" }], ['markup other', { campus_other: '<img src=x onerror=alert(1)>' }], ['both fields', { campus_id: CMP_A, campus_other: 'Green Valley College' }]] as const) { await clearRL(); r = await call('PATCH', '/api/me', { cookie: A, json: patch }); ok(`profile campus: ${label} rejected`, r.s >= 400 && r.s < 500, `status ${r.s}`); }
await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: t1.cookie, json: VALID }); ok('POSITIVE CONTROL: sign-up completes with a bundled campus', r.s === 201, `status ${r.s} ${r.text.slice(0, 80)}`);
const ayesha = 'session_id=' + (/session_id=([^;]+)/.exec(r.h.get('set-cookie') || '')?.[1] || '');
// ticket cannot be replayed, ticket race
await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: t1.cookie, json: { ...VALID, username: 'ayesha_two' } }); ok('used ticket cannot be replayed', r.s === 401, `status ${r.s}`);
const t2 = await startSignup('att2', 'two@gmail.com'), t3 = await startSignup('att3', 'three@gmail.com'); await clearRL();
const raceS = await Promise.all([call('POST', '/api/signup/complete', { cookie: t2.cookie, json: { ...VALID, username: 'raced_name', roll_number: '111', card: { barcode: '111' } } }), call('POST', '/api/signup/complete', { cookie: t3.cookie, json: { ...VALID, username: 'raced_name', roll_number: '222', card: { barcode: '222' } } })]);
ok('sign-up username race: one 201 and one 409, no 5xx', raceS.map(x => x.s).sort().join(',') === '201,409', raceS.map(x => x.s).join(','));
const t4 = await startSignup('att4', 'four@gmail.com'); await clearRL();
const dbl = await Promise.all([1, 2, 3].map(() => call('POST', '/api/signup/complete', { cookie: t4.cookie, json: { ...VALID, username: 'double_tap', roll_number: '333', card: { barcode: '333' } } })));
const dblUsers = (await db.prepare("SELECT COUNT(*) c FROM profiles WHERE username_normalized='double_tap'").first()).c; ok('triple submit of one ticket creates exactly one account', dbl.filter(x => x.s === 201).length === 1 && dblUsers === 1, `${dbl.map(x => x.s).join(',')} rows ${dblUsers}`);
// student identity: card, duplicates, disputes
{
  const tm = await startSignup('idm', 'idm@gmail.com'); await clearRL();
  r = await call('POST', '/api/signup/complete', { cookie: tm.cookie, json: { ...VALID, username: 'id_mismatch', roll_number: '444', card: { barcode: '445' } } });
  ok('card barcode that disagrees with the roll number -> 422 and no account', r.s === 422 && (await db.prepare("SELECT COUNT(*) c FROM profiles WHERE username_normalized='id_mismatch'").first()).c === 0, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: tm.cookie, json: { ...VALID, username: 'id_mismatch', roll_number: '444', card: undefined } });
  ok('no card at all while the scan is required -> 422', r.s === 422, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: tm.cookie, json: { ...VALID, username: 'id_mismatch', roll_number: '444', card: { barcode: '444', verified: true } } });
  ok('card with a smuggled "verified" field rejected', r.s === 400, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/signup/complete', { cookie: tm.cookie, json: { ...VALID, username: 'id_mismatch', roll_number: '444', card: { barcode: '444' } } });
  ok('POSITIVE CONTROL: matching card signs up', r.s === 201, `status ${r.s}`);
  const tdup = await startSignup('iddup', 'iddup@gmail.com'); await clearRL();
  r = await call('POST', '/api/signup/complete', { cookie: tdup.cookie, json: { ...VALID, username: 'id_dup', roll_number: '4-4-4', card: { barcode: '0444' } } });
  ok('same roll number spelled differently is a duplicate (409)', r.s === 409 && !/id_mismatch|idm@/.test(r.text), `status ${r.s} ${r.text.slice(0, 120)}`);
  const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => startSignup(`idrace${i}`, `idrace${i}@gmail.com`)));
  await clearRL();
  const raced = await Promise.all(racers.map((t, i) => call('POST', '/api/signup/complete', { cookie: t.cookie, json: { ...VALID, username: `id_race_${i}`, roll_number: '777', card: { barcode: '777' } } })));
  ok('6 simultaneous sign-ups with one roll number: exactly one 201, rest 409, no 5xx', raced.filter(x => x.s === 201).length === 1 && raced.filter(x => x.s === 409).length === 5, raced.map(x => x.s).join(','));
  r = await call('GET', '/api/admin/disputes'); ok('GET /api/admin/disputes signed out -> 401', r.s === 401, `status ${r.s}`);
  r = await call('GET', '/api/admin/disputes', { cookie: ayesha }); ok('GET /api/admin/disputes as an ordinary student -> 403', r.s === 403, `status ${r.s}`);
}
// username availability
await clearRL(); const ua = async (u: string) => (await call('GET', '/api/username-available?u=' + encodeURIComponent(u), { cookie: A })).j;
ok('username check: taken, reserved, invalid and free all answered correctly', (await ua('ayesha_k'))?.reason === 'taken' && (await ua('admin'))?.reason === 'reserved' && (await ua("x' OR '1'='1"))?.reason === 'invalid' && (await ua('fresh_name_9'))?.available === true, '');
r = await call('PATCH', '/api/me', { cookie: C, json: { username: 'support' } }); ok('reserved username cannot be taken on the profile screen', r.s === 400, `status ${r.s}`);
// privacy: roll number and email never leave the server
const viewer = A;
const sweep = [await call('GET', '/api/me', { cookie: ayesha }), await call('PATCH', '/api/me', { cookie: ayesha, json: { bio: 'hello #hi' } }), await call('GET', '/api/users/ayesha_k', { cookie: viewer }), await call('GET', '/api/users/ayesha_k', { cookie: ayesha }), await call('GET', '/api/search?q=a', { cookie: viewer }), await call('GET', '/api/people/suggested', { cookie: viewer }), await call('GET', '/api/feed?mode=for_you', { cookie: viewer }), await call('GET', '/api/campuses?q=pending', { cookie: ayesha })];
const leaked = sweep.filter(x => /roll_last3|roll_key|roll_number|"email"|attacker\.one@gmail\.com|"907"|20240907/.test(x.text));
ok('roll number and email never appear in any response', leaked.length === 0, leaked.map(x => x.text.slice(0, 60)).join(' | '));
ok('POSITIVE CONTROL: those responses really contain the profile', sweep[0]!.j?.profile?.username === 'ayesha_k' && sweep[2]!.j?.real_name === 'Ayesha Khan', sweep[0]!.text.slice(0, 80));
r = await call('POST', '/api/posts', { cookie: ayesha, json: { body: 'hello from ayesha #hi' } }); const feedLeak = (await call('GET', '/api/search?q=hello', { cookie: viewer })).text;
ok("real name never shows up on posts or search results (profile page only)", feedLeak.includes('ayesha_k') && !feedLeak.includes('Ayesha Khan'), feedLeak.slice(0, 80));
for (const body of [{ email: 'x@y.z' }, { roll_last3: '123' }, { real_name: '<b>x</b>' }]) { r = await call('PATCH', '/api/me', { cookie: ayesha, json: body }); ok(`PATCH /api/me ${JSON.stringify(body).slice(0, 26)} rejected`, r.s === 400, `status ${r.s}`); }
const privRow = await db.prepare("SELECT email, roll_last3 FROM user_private WHERE user_id = (SELECT user_id FROM profiles WHERE username_normalized='ayesha_k')").first(); ok('private record stored server-side', privRow?.roll_last3 === '907' && privRow?.email === 'attacker.one@gmail.com', JSON.stringify(privRow));
// avatars
await clearRL(); r = await call('PATCH', '/api/me', { cookie: C, json: { avatar_media_id: aliceMedia } }); ok("cannot set someone else's upload as avatar (would expose it)", r.s === 400, `status ${r.s}`);
r = await call('GET', '/api/media/' + aliceMedia, { cookie: C }); ok("alice's private upload still unreadable by carol", r.s === 403 || r.s === 404, `status ${r.s}`);
r = await call('PATCH', '/api/me', { cookie: A, json: { avatar_media_id: aliceMedia } }); ok('POSITIVE CONTROL: owner can set their own upload as avatar', r.s === 200, `status ${r.s}`);
r = await call('GET', '/api/media/' + aliceMedia, { cookie: C }); ok('avatar is visible to other signed-in people', r.s === 200, `status ${r.s}`);
r = await call('GET', '/api/media/' + aliceMedia); ok('avatar is not visible when signed out', r.s === 401, `status ${r.s}`);
// search scope + suggested people
await db.prepare(`UPDATE profiles SET class_id='cls_2026', campus_id='${CMP_A}' WHERE user_id IN ('usr_alice','usr_carol')`).run();
await db.prepare(`UPDATE profiles SET class_id='cls_2027', campus_id='${CMP_A}' WHERE user_id='usr_dave'`).run();
await clearRL(); await call('POST', '/api/posts', { cookie: C, json: { body: 'scopetest from carol' } }); await call('POST', '/api/posts', { cookie: D, json: { body: 'scopetest from dave' } });
// the earlier username race renamed carol or dave, so look the current names up
const carolName = (await db.prepare("SELECT username FROM profiles WHERE user_id='usr_carol'").first()).username as string;
const daveName = (await db.prepare("SELECT username FROM profiles WHERE user_id='usr_dave'").first()).username as string;
const sc = async (scope: string, ck: string) => (await call('GET', '/api/search?q=scopetest&scope=' + encodeURIComponent(scope), { cookie: ck })); const names = (x: any) => (x.j?.posts || []).map((p: any) => p.author_username).sort().join(',');
ok('POSITIVE CONTROL: scope=all finds both authors', names(await sc('all', A)) === [carolName, daveName].sort().join(','), names(await sc('all', A)));
ok('scope=class only returns the callers own class', names(await sc('class', A)) === carolName, names(await sc('class', A)));
ok('scope=campus returns the campus', names(await sc('campus', A)) === [carolName, daveName].sort().join(','), names(await sc('campus', A)));
r = await sc("class' OR '1'='1", A); ok('SQLi in scope -> 400', r.s === 400, `status ${r.s}`);
r = await sc('class', B); ok('missing class is reported, not silently widened', r.s === 200 && r.j?.scope_missing === 'class' && (r.j?.posts || []).length === 0, r.text.slice(0, 80));
await clearRL(); r = await call('GET', '/api/people/suggested', { cookie: A }); ok('POSITIVE CONTROL: suggested people lists a classmate', (r.j?.people || []).some((p: any) => p.username === carolName && p.relation === 'class'), r.text.slice(0, 100));
ok('suggested people excludes self and non-matching people', !(r.j?.people || []).some((p: any) => p.username === 'alice' || p.username === 'bob'), r.text.slice(0, 100));
await call('POST', '/api/blocks/usr_carol', { cookie: A, json: { user_id: 'usr_carol' } }); await clearRL();
r = await call('GET', '/api/people/suggested', { cookie: A }); ok('blocked people are not suggested', !(r.j?.people || []).some((p: any) => p.username === carolName) && (r.j?.people || []).some((p: any) => p.username === daveName), r.text.slice(0, 100));
r = await call('GET', '/api/people/suggested', { cookie: C }); ok('and the blocked side does not get the blocker suggested either', !(r.j?.people || []).some((p: any) => p.username === 'alice'), r.text.slice(0, 100));
// profile styles
await clearRL();
for (const body of [{ wallpaper_id: 'url(http://evil.example/x.png)' }, { theme_id: 'red; background:url(javascript:1)' }, { text_style_id: '<script>' }, { wallpaper_id: 7 }]) { r = await call('PATCH', '/api/me', { cookie: B, json: body }); ok(`style ${JSON.stringify(body).slice(0, 36)} rejected`, r.s === 400, `status ${r.s}`); }
r = await call('PATCH', '/api/me', { cookie: B, json: { wallpaper_id: 'dusk', theme_id: 'ocean', text_style_id: 'mono' } }); ok('POSITIVE CONTROL: valid style presets are accepted', r.s === 200 && r.j?.profile?.wallpaper_id === 'dusk', `status ${r.s}`);
// free-text campus: positive control that a good value is accepted, and it clears the listed campus
await clearRL(); r = await call('PATCH', '/api/me', { cookie: ayesha, json: { campus_other: 'Green Valley College' } }); ok('POSITIVE CONTROL: a free-text campus is accepted', r.s === 200, `status ${r.s}`);
r = await call('GET', '/api/me', { cookie: ayesha }); ok('free-text campus replaces the listed campus', r.j?.profile?.campus_id === null && r.j?.profile?.campus_other === 'Green Valley College', r.text.slice(0, 120));

// ---------- MEDIA FOUNDATION: kinds, caps, read rules, library, forwarding ----------
{
  const enc = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const webp = (n: number) => new Uint8Array([...enc('RIFF'), 8, 0, 0, 0, ...enc('WEBP'), n, 0]);
  const upKind = async (cookie: string, bytes: Uint8Array, type: string, kind: string) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), 'f'); f.append('kind', kind); return call('POST', '/api/media/uploads', { cookie, form: f }); };
  const SND = await seed('usr_snd', 'sender'), RCV = await seed('usr_rcv', 'receiver'), OUT = await seed('usr_out', 'outsider');
  await clearRL();
  r = await upKind(A, new Uint8Array(enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')), 'image/svg+xml', 'sticker'); ok('SVG sticker rejected', r.s === 400, `status ${r.s}`);
  r = await upKind(A, new Uint8Array(enc('<svg onload=alert(1)>')), 'image/webp', 'sticker'); ok('SVG disguised as webp rejected (magic bytes)', r.s === 400, `status ${r.s}`);
  r = await upKind(A, new Uint8Array(enc('<html><script>alert(1)</script>')), 'image/gif', 'gif'); ok('HTML disguised as gif rejected', r.s === 400, `status ${r.s}`);
  for (const kind of ['../etc', 'photo; DROP TABLE media', 'admin', '']) { r = await upKind(A, webp(1), 'image/webp', kind); ok(`unknown media kind ${JSON.stringify(kind).slice(0, 24)} rejected`, r.s === 400, `status ${r.s}`); }
  const big = new Uint8Array(300 * 1024 + 1); big.set(webp(2)); r = await upKind(A, big, 'image/webp', 'sticker'); ok('sticker over 300 KB -> 413', r.s === 413, `status ${r.s}`);
  r = await upKind(A, webp(3), 'image/webp', 'sticker'); const stickerId = idOf(r.j); ok('POSITIVE CONTROL: a valid sticker uploads', r.s === 201 && !!stickerId, `status ${r.s}`);
  r = await upKind(A, webp(3), 'image/webp', 'sticker'); ok('same bytes by the same owner reuse the row', r.s === 200 && idOf(r.j) === stickerId, `status ${r.s}`);
  r = await upKind(B, webp(3), 'image/webp', 'sticker'); ok('same bytes by another owner never reuse alice’s row (no cross-user dedupe leak)', r.s === 201 && idOf(r.j) !== stickerId, `status ${r.s}`);
  r = await call('POST', '/api/media/uploads', { form: (() => { const f = new FormData(); f.append('file', new Blob([webp(4)], { type: 'image/webp' })); return f; })() }); ok('upload without a session -> 401', r.s === 401, `status ${r.s}`);
  r = await call('GET', `/api/media/${stickerId}/thumb`); ok('thumbnail without a session -> 401', r.s === 401, `status ${r.s}`);
  r = await call('GET', `/api/media/${stickerId}`, { cookie: B }); ok('another person cannot read a sticker that is not attached anywhere -> 403', r.s === 403, `status ${r.s}`);
  r = await call('POST', '/api/stickers/library', { cookie: B, json: { media_id: stickerId } }); ok('cannot add someone else’s sticker to your library -> 404', r.s === 404, `status ${r.s}`);
  for (const bad of ["x' OR '1'='1", '../x', 123, null, ['a']]) { r = await call('POST', '/api/stickers/library', { cookie: A, json: { media_id: bad } }); ok(`library media_id ${JSON.stringify(bad).slice(0, 20)} rejected`, r.s === 400, `status ${r.s}`); }
  r = await call('POST', '/api/stickers/library', { cookie: A, json: { media_id: stickerId } }); ok('POSITIVE CONTROL: owner adds own sticker to the library', r.s === 201, `status ${r.s}`);
  r = await call('DELETE', `/api/stickers/library/${stickerId}`, { cookie: B }); ok('removing from someone else’s library -> 404', r.s === 404, `status ${r.s}`);
  r = await call('DELETE', `/api/media/${stickerId}`, { cookie: B }); ok('deleting someone else’s media -> 403', r.s === 403, `status ${r.s}`);
  // forwarding: sender -> receiver message with media; outsider is not in the conversation
  const fwdMedia = await upKind(SND, webp(9), 'image/webp', 'sticker').then((x: any) => idOf(x.j));
  const ab = await call('POST', '/api/conversations', { cookie: SND, json: { user_id: 'usr_rcv' } }); const abId = ab.j?.id ?? ab.j?.conversation?.id;
  const sent = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { body: 'x', media_ids: [fwdMedia] } }); const msgId = sent.j?.message?.id; ok('setup: sender sends media to receiver', sent.s === 201 && !!msgId, `status ${sent.s}`);
  r = await call('GET', `/api/media/${fwdMedia}`, { cookie: OUT }); ok('an outsider cannot read message media -> 403', r.s === 403, `status ${r.s}`);
  r = await call('GET', `/api/media/${fwdMedia}`, { cookie: RCV }); ok('POSITIVE CONTROL: the recipient reads message media', r.s === 200, `status ${r.s}`);
  const ca = await call('POST', '/api/conversations', { cookie: OUT, json: { user_id: 'usr_snd' } }); const caId = ca.j?.id ?? ca.j?.conversation?.id;
  r = await call('POST', `/api/messages/${msgId}/forward`, { cookie: OUT, json: { conversation_id: caId } }); ok('an outsider cannot forward a message they are not in -> 404', r.s === 404, `status ${r.s}`);
  r = await call('POST', `/api/messages/nope/forward`, { cookie: OUT, json: { conversation_id: caId } }); ok('forwarding a missing message gives the same 404', r.s === 404, `status ${r.s}`);
  r = await call('POST', `/api/messages/${msgId}/forward`, { cookie: RCV, json: { conversation_id: caId } }); ok('forwarding into a conversation you are not in -> 403', r.s === 403, `status ${r.s}`);
  for (const bad of [null, 5, ['x'], {}]) { r = await call('POST', `/api/messages/${msgId}/forward`, { cookie: RCV, json: { conversation_id: bad } }); ok(`forward conversation_id ${JSON.stringify(bad)} rejected`, r.s === 400, `status ${r.s}`); }
  r = await call('POST', `/api/conversations/${caId}/messages`, { cookie: OUT, json: { body: 'x', media_ids: [fwdMedia] } }); ok('sending someone else’s media id through the normal route -> 400', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/messages/${msgId}/forward`, { json: { conversation_id: abId } }); ok('forward without a session -> 401', r.s === 401, `status ${r.s}`);
  // message shape rules: media-only is fine, empty is not, at most 4 attachments, unknown fields rejected
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { body: '   ' } }); ok('empty message with no media -> 400', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { body: 'x', media_ids: [fwdMedia, fwdMedia, fwdMedia, fwdMedia, fwdMedia] } }); ok('5 attachments -> 400', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { body: 'x', media_ids: ['med_does_not_exist'] } }); ok('unknown media id -> 400', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { body: 'x', sender_id: 'usr_rcv' } }); ok('extra field (sender_id) rejected', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { media_ids: [fwdMedia] } }); ok('POSITIVE CONTROL: media-only message is accepted', r.s === 201, `status ${r.s}`);
  r = await call('GET', '/api/conversations', { cookie: RCV }); ok('conversation list previews the media kind of the last message', r.j?.conversations?.[0]?.last_message?.media_kind === 'sticker', JSON.stringify(r.j?.conversations?.[0]?.last_message).slice(0, 120));
  // sticker keys: forged, malformed, someone else's file, wrong kind, mixed content
  const SK = STICKER_PACKS[0]!; const skKey = `app:${SK.id}/${SK.items[0]!.number}`;
  await clearRL();
  for (const key of ['app:placeholder/999999', 'app:nope/1', "app:placeholder/1'; DROP TABLE posts;--", '../../etc/passwd', 'javascript:alert(1)', 'usr:med_does_not_exist', 'usr:../../x', 'app:placeholder/0', 'x'.repeat(300), 7, ['app:placeholder/1'], { k: 1 }]) {
    r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { sticker_key: key } }); ok(`message sticker_key ${JSON.stringify(key).slice(0, 28)} -> 400`, r.s === 400, `status ${r.s}`);
    await clearRL(); r = await call('POST', '/api/posts', { cookie: SND, json: { body: 'x', sticker_key: key } }); ok(`post sticker_key ${JSON.stringify(key).slice(0, 28)} -> 400`, r.s === 400, `status ${r.s}`);
  }
  await clearRL(); r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { sticker_key: skKey } }); ok('POSITIVE CONTROL: a bundled sticker key is accepted and nothing is written to media', r.s === 201 && (r.j?.message?.media ?? []).length === 0, `status ${r.s}`);
  const otherSticker = await upKind(OUT, webp(77), 'image/webp', 'sticker').then((x: any) => idOf(x.j));
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { sticker_key: `usr:${otherSticker}` } }); ok('using another person’s private sticker by key -> 400 (same as a missing one)', r.s === 400, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/posts', { cookie: SND, json: { body: 'x', sticker_key: `usr:${otherSticker}` } }); ok('post: another person’s private sticker -> 400', r.s === 400, `status ${r.s}`);
  const photoForKey = await up(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]), 'image/png', 'k.png', SND).then((x: any) => idOf(x.j));
  r = await call('POST', `/api/conversations/${abId}/messages`, { cookie: SND, json: { sticker_key: `usr:${photoForKey}` } }); ok('a photo cannot be used as a sticker key -> 400', r.s === 400, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/posts', { cookie: SND, json: { body: 'x', media_ids: [photoForKey], sticker_key: skKey } }); ok('post with photos AND a sticker -> 400', r.s === 400, `status ${r.s}`);
  const stickerAsPhoto = await upKind(SND, webp(78), 'image/webp', 'sticker').then((x: any) => idOf(x.j));
  await clearRL(); r = await call('POST', '/api/posts', { cookie: SND, json: { body: 'x', media_ids: [stickerAsPhoto] } }); ok('a sticker cannot be smuggled into a post as a photo -> 400', r.s === 400, `status ${r.s}`);
  await clearRL(); const skPost = await call('POST', '/api/posts', { cookie: SND, json: { body: 'sticker post', sticker_key: skKey } }); ok('POSITIVE CONTROL: a post with a bundled sticker is accepted', skPost.s === 201, `status ${skPost.s}`);
  await clearRL(); r = await call('POST', `/api/posts/${skPost.j?.id}/comments`, { cookie: RCV, json: {} }); ok('empty comment -> 400', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/posts/${skPost.j?.id}/comments`, { cookie: RCV, json: { sticker_key: skKey, body: 'hi', admin: true } }); ok('comment with an extra field -> 400', r.s === 400, `status ${r.s}`);
  r = await call('POST', `/api/posts/${skPost.j?.id}/comments`, { cookie: RCV, json: { sticker_key: skKey } }); ok('POSITIVE CONTROL: a sticker-only comment is accepted', r.s === 201 && r.j?.sticker_key === skKey, `status ${r.s}`);
  const commentSticker = await upKind(RCV, webp(79), 'image/webp', 'sticker').then((x: any) => idOf(x.j));
  await clearRL(); r = await call('POST', `/api/posts/${skPost.j?.id}/comments`, { cookie: RCV, json: { sticker_key: `usr:${commentSticker}` } }); ok('comment with an uploaded sticker accepted', r.s === 201, `status ${r.s}`);
  r = await call('GET', `/api/media/${commentSticker}`, { cookie: SND }); ok('the post author can read the comment sticker', r.s === 200, `status ${r.s}`);
  r = await call('POST', '/api/blocks', { cookie: SND, json: { user_id: 'usr_rcv' } }); r = await call('GET', `/api/media/${commentSticker}`, { cookie: SND }); ok('after blocking the commenter, their comment sticker is unreadable -> 403', r.s === 403, `status ${r.s}`);
  r = await call('POST', '/api/stickers/library', { cookie: OUT, json: { media_id: commentSticker } }); ok('cannot add a sticker you do not own to your library', r.s === 404 || r.s === 403, `status ${r.s}`);
}


// ---------- POLLS + CUSTOM BACKGROUNDS ----------
{
  const enc = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const webp = (n: number) => new Uint8Array([...enc('RIFF'), 8, 0, 0, 0, ...enc('WEBP'), n, 0]);
  const upKind = async (cookie: string, bytes: Uint8Array, type: string, kind: string) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), 'f'); f.append('kind', kind); return call('POST', '/api/media/uploads', { cookie, form: f }); };
  const SK = STICKER_PACKS[0]!; const skKey = `app:${SK.id}/${SK.items[0]!.number}`;
  const PA = await seed('usr_polla', 'polla'), PB = await seed('usr_pollb', 'pollb'), PC = await seed('usr_pollc', 'pollc'), PD = await seed('usr_polld', 'polld');
  const mkPoll = async (cookie: string, options: unknown) => { await clearRL(); return call('POST', '/api/posts', { cookie, json: { body: 'poll q', poll: { options } } }); };
  const hostile = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a'.repeat(10_000), null, 42, ['x'], { a: 1 }];
  for (const bad of hostile) { r = await mkPoll(PA, ['ok', bad]); ok(`poll option ${JSON.stringify(bad)?.slice(0, 26)} rejected`, r.s === 400, `status ${r.s}`); }
  for (const bad of [['one'], [], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'a,b', null, { options: ['a', 'b'] }, ['Same', ' same ']]) { r = await mkPoll(PA, bad); ok(`poll options ${JSON.stringify(bad)?.slice(0, 30)} rejected`, r.s === 400, `status ${r.s}`); }
  await clearRL(); r = await call('POST', '/api/posts', { cookie: PA, json: { body: 'x', poll: { options: ['a', 'b'], multiple: true } } }); ok('unknown key inside poll rejected', r.s === 400, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/posts', { cookie: PA, json: { body: 'x', poll: { options: ['a', 'b'] }, sticker_key: skKey } }); ok('poll + sticker rejected', r.s === 400, `status ${r.s}`);
  r = await mkPoll(PA, ["Bob'); DROP TABLE polls;--", 'Alice']); const pid = idOf(r.j); ok('POSITIVE CONTROL: a poll with SQL-looking text is stored as plain text', r.s === 201 && !!pid, `status ${r.s}`);
  const tableOk = (await db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'polls'").first()).c === 1; ok('polls table still exists after injection text', tableOk, '');
  const optIds = (r.j?.poll?.options ?? []).map((o: any) => o.id); const other = idOf((await mkPoll(PA, ['x', 'y'])).j); const otherOpt = (await db.prepare('SELECT id FROM poll_options WHERE poll_id = ? LIMIT 1').bind(other).first()).id;
  const vote = (cookie: string | undefined, post: string, option: unknown) => call('PUT', `/api/posts/${post}/poll/vote`, { cookie, json: { option_id: option } });
  r = await vote(undefined, pid, optIds[0]); ok('vote without a session -> 401', r.s === 401, `status ${r.s}`);
  for (const bad of ["x' OR '1'='1", '../x', 123, null, ['a'], '', 'a'.repeat(500)]) { r = await vote(PB, pid, bad); ok(`vote option_id ${JSON.stringify(bad)?.slice(0, 22)} rejected`, r.s === 400, `status ${r.s}`); }
  r = await vote(PB, pid, otherOpt); ok('option from another poll -> 400 (no cross-poll votes)', r.s === 400, `status ${r.s}`);
  const plainPost = idOf((await (async () => { await clearRL(); return call('POST', '/api/posts', { cookie: PA, json: { body: 'no poll' } }); })()).j); r = await vote(PB, plainPost, optIds[0]); ok('vote on a post without a poll -> 404', r.s === 404, `status ${r.s}`);
  r = await vote(PB, 'pst_nope', optIds[0]); ok('vote on a missing post -> 404', r.s === 404, `status ${r.s}`);
  r = await vote(PB, pid, optIds[0]); ok('POSITIVE CONTROL: a valid vote works', r.s === 200 && r.j?.poll?.my_vote === optIds[0], `status ${r.s}`);
  await Promise.all([vote(PB, pid, optIds[0]), vote(PB, pid, optIds[1]), vote(PB, pid, optIds[0]), vote(PB, pid, optIds[1])]);
  const rowsAfter = (await db.prepare('SELECT COUNT(*) c FROM poll_votes WHERE poll_id = ? AND user_id = ?').bind(pid, 'usr_pollb').first()).c; ok('parallel votes by one account leave exactly one row', rowsAfter === 1, `rows ${rowsAfter}`);
  r = await call('GET', `/api/posts/${pid}`, { cookie: PC }); const rawNonVoter = JSON.stringify(r.j?.poll ?? {}); ok('a non-voter never receives counts', r.s === 200 && !/votes/.test(rawNonVoter), rawNonVoter.slice(0, 120));
  r = await call('GET', '/api/feed?author=polla', { cookie: PC }); const feedRaw = JSON.stringify(r.j ?? {}); ok('feed JSON for a non-voter carries no vote counts', r.s === 200 && !/"votes"|total_votes/.test(feedRaw), '');
  r = await call('GET', `/api/posts/${pid}`, { cookie: PB }); const voterRaw = JSON.stringify(r.j ?? {}); ok('the response never lists who voted (no voter ids besides the author)', !/usr_pollb|usr_pollc|voter/.test(voterRaw), '');
  r = await call('GET', `/api/posts/${pid}`, { cookie: PA }); ok('the author sees the counts', typeof r.j?.poll?.total_votes === 'number', JSON.stringify(r.j?.poll).slice(0, 100));
  await call('POST', '/api/blocks', { cookie: PA, json: { user_id: 'usr_pollc' } }); r = await vote(PC, pid, optIds[0]); ok('a blocked person cannot vote -> 404', r.s === 404, `status ${r.s}`);
  await db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), other).run(); r = await vote(PD, other, otherOpt); ok('voting on an expired poll -> 409', r.s === 409, `status ${r.s}`);
  let lim = 0; for (let i = 0; i < 75; i++) { const x = await vote(PD, pid, optIds[i % 2]); if (x.s === 429) lim++; } ok('vote spam is rate limited (429 seen)', lim > 0, `429s: ${lim}/75`);

  // custom backgrounds
  const bg = (cookie: string, bytes: Uint8Array, mime = 'image/webp') => upKind(cookie, bytes, mime, 'background');
  r = await bg(PA, new Uint8Array(enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')), 'image/svg+xml'); ok('SVG background rejected', r.s === 400, `status ${r.s}`);
  const bigBg = new Uint8Array(400 * 1024 + 1); bigBg.set(webp(1)); r = await bg(PA, bigBg); ok('background over 400 KB -> 413', r.s === 413, `status ${r.s}`);
  r = await bg(PA, webp(21)); const bgId = idOf(r.j); ok('POSITIVE CONTROL: a valid background uploads', r.s === 201 && !!bgId, `status ${r.s}`);
  r = await call('GET', `/api/media/${bgId}`, { cookie: PB }); ok('an unattached background is private -> 403', r.s === 403, `status ${r.s}`);
  r = await call('PATCH', '/api/me', { cookie: PB, json: { wallpaper_media_id: bgId } }); ok("someone else's background cannot be set -> 400", r.s === 400, `status ${r.s}`);
  for (const bad of ["x' OR '1'='1", '../../etc/passwd', 123, ['a'], '', 'a'.repeat(300)]) { r = await call('PATCH', '/api/me', { cookie: PA, json: { wallpaper_media_id: bad } }); ok(`wallpaper_media_id ${JSON.stringify(bad)?.slice(0, 22)} rejected`, r.s === 400, `status ${r.s}`); }
  r = await call('PATCH', '/api/me', { cookie: PA, json: { wallpaper_id: 'custom' } }); ok("'custom' with no image -> 400", r.s === 400, `status ${r.s}`);
  const photoId = await upKind(PA, webp(22), 'image/webp', 'photo').then((x: any) => idOf(x.j)); r = await call('PATCH', '/api/me', { cookie: PA, json: { wallpaper_media_id: photoId } }); ok('a photo cannot be used as a background -> 400', r.s === 400, `status ${r.s}`);
  r = await call('PATCH', '/api/me', { cookie: PA, json: { wallpaper_media_id: bgId } }); ok('POSITIVE CONTROL: the owner sets their own background', r.s === 200 && r.j?.profile?.wallpaper_id === 'custom', `status ${r.s}`);
  r = await call('GET', `/api/media/${bgId}`, { cookie: PB }); ok('once it is the profile background, signed-in people can read it', r.s === 200, `status ${r.s}`);
  r = await call('GET', `/api/media/${bgId}`); ok('signed-out visitors cannot read it', r.s === 401 || r.s === 403, `status ${r.s}`);
  r = await call('PATCH', '/api/me', { cookie: PA, json: { wallpaper_media_id: bgId, wallpaper_id: 'plain' } }); ok('image plus a preset in one request -> 400', r.s === 400, `status ${r.s}`);
  r = await call('PATCH', '/api/me', { cookie: PA, json: { wallpaper_id: 'plain' } }); ok('choosing a preset clears the image', r.s === 200 && r.j?.profile?.wallpaper_media_id === null, `status ${r.s}`);
  // spam check and the post limit
  const PS = await seed('usr_spammer', 'spammer'); const spamText = 'FREE MONEY!!! click here https://win.xyz and https://cash.top whatsapp +923001234567';
  await clearRL(); r = await call('POST', '/api/posts', { cookie: PS, json: { body: 'A normal question about the homework due on Friday' } }); ok('POSITIVE CONTROL: a normal post is accepted', r.s === 201, `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/posts', { cookie: PS, json: { body: spamText } }); ok('a spam-looking post is refused (422) and not published', r.s === 422, `status ${r.s}`);
  await clearRL(); await call('POST', '/api/posts', { cookie: PS, json: { body: spamText } }); r = await call('POST', '/api/posts', { cookie: PS, json: { body: spamText } }); ok('third spam attempt in a row locks posting (403)', r.s === 403 && r.j?.code === 'spam_locked', `status ${r.s}`);
  await clearRL(); r = await call('POST', '/api/posts', { cookie: PS, json: { body: 'A perfectly normal post after the lock started' } }); ok('a locked account cannot post even normal text (403)', r.s === 403, `status ${r.s}`);
  let over = 0; const PL = await seed('usr_limiter', 'limiter'); await clearRL(); for (let i = 0; i < 6; i++) { const x = await call('POST', '/api/posts', { cookie: PL, json: { body: `Distinct everyday sentence number ${i} for the limit` } }); if (x.s === 429) over++; } ok('more than 3 posts in 15 minutes is refused (3 of 6 hit 429)', over === 3, `429s: ${over}/6`);
}

// ---------- EXPIRY / LIFECYCLE ----------
const mk = async (id: string, author: string, ageDays: number, likers: string[], commenter: string[] = []) => {
  const created = new Date(Date.now() - ageDays * 864e5).toISOString();
  await db.prepare('INSERT INTO posts (id,author_id,body,created_at,expires_at,status) VALUES (?,?,?,?,?,?)').bind(id, author, 'p ' + id, created, new Date(new Date(created).getTime() + 7 * 864e5).toISOString(), 'active').run();
  for (const u of likers) await db.prepare("INSERT INTO post_reactions (post_id,user_id,type,created_at) VALUES (?,?,'like',?)").bind(id, u, created).run();
  for (const u of commenter) await db.prepare('INSERT INTO comments (id,post_id,author_id,body,created_at,expires_at) VALUES (?,?,?,?,?,?)').bind('c_' + id + u, id, u, 'c', created, exp).run();
};
await mk('e_two', 'usr_dave', 7.01, ['usr_alice', 'usr_bob']);
await mk('e_three', 'usr_dave', 7.01, ['usr_alice', 'usr_bob', 'usr_carol']);
await mk('e_selfpad', 'usr_dave', 7.01, ['usr_dave', 'usr_alice', 'usr_bob']);
await mk('e_samepeople', 'usr_dave', 7.01, ['usr_alice', 'usr_bob'], ['usr_alice', 'usr_bob']);
await mk('e_old', 'usr_dave', 14.5, ['usr_alice', 'usr_bob', 'usr_carol']);
await mk('e_young', 'usr_dave', 3, []);
const jr = await runPostLifecycleExpiry(prod, Date.now());
const ex = async (id: string) => (await db.prepare('SELECT COUNT(*) c FROM posts WHERE id=?').bind(id).first()).c === 1;
ok('day7, 2 engagers -> deleted', !(await ex('e_two')), ''); ok('day7, 3 engagers -> kept', await ex('e_three'), '');
ok("author's own like does not count toward 3", !(await ex('e_selfpad')), ''); ok('same 2 people like+comment still counts as 2 (deleted)', !(await ex('e_samepeople')), '');
ok('past day 14 -> hard stop even if popular', !(await ex('e_old')), ''); ok('3-day-old post untouched', await ex('e_young'), '');
const mid = idOf((await call('POST', `/api/conversations/${convAC}/messages`, { cookie: C, json: { body: 'reported message' } })).j);
if (mid) { await db.prepare("UPDATE messages SET sent_at=?, expires_at=? WHERE id=?").bind(new Date(Date.now() - 15 * 864e5).toISOString(), new Date(Date.now() - 864e3).toISOString(), mid).run(); r = await call('POST', '/api/reports', { cookie: A, json: { target_type: 'message', target_id: mid, reason: 'abuse test' } }); await runPostLifecycleExpiry(prod, Date.now());
  const gone = (await db.prepare('SELECT COUNT(*) c FROM messages WHERE id=?').bind(mid).first()).c === 0; const ev = (await db.prepare('SELECT COUNT(*) c FROM report_evidence').first()).c;
  ok('expired message deleted', gone, ''); ok('reported message evidence survives message expiry', ev >= 1, `report ${r.s}, evidence rows ${ev}`); }
// rate limit
await clearRL(); let limited = 0; for (let i = 0; i < 80; i++) { const x = await call('POST', '/api/posts', { cookie: D, json: { body: 'spam ' + i } }); if (x.s === 429) limited++; } ok('post spam is rate limited (429 seen)', limited > 0, `429s: ${limited}/80`);
// account deletion
const delC = await seed('usr_erin', 'erin'); await call('POST', '/api/posts', { cookie: delC, json: { body: 'erin post' } }); r = await call('DELETE', '/api/me', { cookie: delC }); r = await call('GET', '/api/me', { cookie: delC });
const left = (await db.prepare("SELECT (SELECT COUNT(*) FROM posts WHERE author_id='usr_erin')+(SELECT COUNT(*) FROM sessions WHERE user_id='usr_erin')+(SELECT COUNT(*) FROM profiles WHERE user_id='usr_erin') c").first()).c; ok('account deletion removes posts/sessions/profile; cookie dead', r.s === 401 && left === 0, `me=${r.s}, leftover rows ${left}`);
const ayeshaId = (await db.prepare("SELECT user_id FROM profiles WHERE username_normalized='ayesha_k'").first()).user_id; await call('DELETE', '/api/me', { cookie: ayesha });
const privLeft = (await db.prepare('SELECT COUNT(*) c FROM user_private WHERE user_id = ?').bind(ayeshaId).first()).c; ok('account deletion also removes the private roll number and email', privLeft === 0, `rows ${privLeft}`);

const rl = results.filter(x => x[1] && /status 429/.test(x[2])); console.log("held-but-only-because-429:", rl.length, rl.map(x=>x[0]).join(" / "));
const bad = results.filter(x => !x[1]);
console.log(`\nCHECKS: ${results.length}  HELD: ${results.length - bad.length}  BROKEN: ${bad.length}  5xx-crashes: ${fives.length}`);
for (const [n, , d] of bad) console.log('BROKEN:', n, '|', d);
for (const f of fives.slice(0, 15)) console.log('5xx:', f);
if (bad.length > 0 || fives.length > 0) process.exit(1);
