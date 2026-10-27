// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { AdminPage } from '../src/pages/AdminPage.tsx';
import { SettingsPage } from '../src/pages/SettingsPage.tsx';
import { LayoutProvider } from '../src/lib/layout.ts';
import { mount, click, flush, typeInto, byLabel, byText, axeViolations, installFetch, json, type Mounted } from './_ui.tsx';
import type { MeResponse } from '../shared/schema.ts';

window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;
let m: Mounted | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => { m?.unmount(); m = null; cleanups.splice(0).forEach((c) => c()); document.body.innerHTML = ''; await new Promise((r) => setTimeout(r, 60)); });

const meAs = (role: 'user' | 'admin' | 'master', id = 'usr_me'): MeResponse => ({
  user: { id, created_at: '', status: 'active' },
  profile: { username: 'mia', username_normalized: 'mia', display_name: 'Mia', bio: '', avatar_media_id: null, class_id: null, campus_id: null },
  settings: { dm_policy: 'everyone', feed_preferences: 'for_you' },
  role,
} as MeResponse);

const people = [
  { id: 'usr_me', username: 'mia', display_name: 'Mia', role: 'admin', status: 'active' },
  { id: 'usr_adm', username: 'otheradmin', display_name: 'Other Admin', role: 'admin', status: 'active' },
  { id: 'usr_a', username: 'ada', display_name: 'Ada', role: 'user', status: 'active' },
  { id: 'usr_s', username: 'sam', display_name: 'Sam', role: 'user', status: 'suspended' },
  { id: 'usr_b', username: 'ben', display_name: 'Ben', role: 'user', status: 'banned' },
];

const routes = () => ({
  'GET /api/admin/stats': () => json({ users: 5, posts: 9, open_reports: 1, media_bytes: 0 }),
  'GET /api/admin/reports/rep_1/preview': () => json({ report_id: 'rep_1', target_type: 'post', exists: true, text: 'rude words', author_id: 'usr_a', author_username: 'ada', status: 'active' }),
  'PATCH /api/admin/reports/rep_1': () => json({ success: true }),
  'GET /api/admin/reports': () => json({ reports: [{ id: 'rep_1', reporter_username: 'sam', target_type: 'post', target_id: 'post_1', reason: 'abuse', status: 'pending', created_at: '2026-10-24T10:00:00Z' }] }),
  'GET /api/admin/users': () => json({ users: people }),
  'POST /api/admin/users/usr_a/status': () => json({ success: true, status: 'banned' }),
  'POST /api/admin/appoint': () => json({ success: true, your_role: 'user' }),
  'GET /api/admin/actions': () => json({ actions: [{ id: 'a1', action: 'status:suspended', detail: 'spam', created_at: '2026-10-24T10:00:00Z', actor_username: 'master admin', target_username: 'sam' }, { id: 'a2', action: 'appoint:handover', detail: null, created_at: '2026-10-24T09:00:00Z', actor_username: 'mia', target_username: 'ada' }] }),
});

const open = async (role: 'admin' | 'master', extra: { onLostAdmin?: () => void } = {}) => {
  const net = installFetch(routes()); cleanups.push(net.restore);
  m = await mount(<AdminPage currentUser={meAs(role)} onBack={() => undefined} onLostAdmin={extra.onLostAdmin ?? (() => undefined)} />);
  await flush(); await flush();
  return net;
};
const tab = async (name: string) => { await click(byText(document.body, 'button', name)); await flush(); await flush(); };
const row = (username: string) => [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(`@${username}`))!;
const buttonsIn = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent);

describe('Admin page', () => {
  it('shows the counts and the reports that wait, and Look reveals what was reported and who wrote it', async () => {
    await open('admin');
    expect(document.body.textContent).toContain('Open reports');
    expect(document.body.textContent).toContain('reported by @sam: abuse');
    expect(document.body.textContent).not.toContain('rude words');
    await click(byText(document.body, 'button', 'Look'));
    await flush();
    expect(document.body.textContent).toContain('rude words');
    expect(document.body.textContent).toContain('by @ada');
    expect(await axeViolations(document.body)).toBe('');
  });

  it('a report can be marked reviewed; the author can be banned after a confirmation with a reason', async () => {
    const net = await open('admin');
    await click(byText(document.body, 'button', 'Look')); await flush();
    await click(byText(document.body, 'button', 'Reviewed'));
    expect(net.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/api/admin/reports/rep_1') && (c.body as { status: string }).status === 'reviewed')).toBe(true);

    await click(byText(document.body, 'button', 'Ban author'));
    expect(document.body.textContent).toContain('Ban @ada?');
    expect(document.body.textContent).toContain('Only the master admin can undo a ban');
    await typeInto(byLabel(document.body, 'Reason') as HTMLInputElement, 'abuse');
    await click(byText(document.body.querySelector('[aria-label="Confirm"]') as HTMLElement, 'button', 'Ban'));
    await flush();
    const post = net.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/users/usr_a/status'))!;
    expect(post.body).toEqual({ status: 'banned', reason: 'abuse' });
    expect(document.body.textContent).toContain('@ada is now banned.');
    expect(document.querySelector('[aria-label="Confirm"]')).toBeNull();
  });

  it('nothing is sent until the confirmation is accepted, and Cancel sends nothing', async () => {
    const net = await open('admin');
    await tab('People');
    await click(byText(row('ada') as HTMLElement, 'button', 'Suspend'));
    expect(document.body.textContent).toContain('Suspend @ada?');
    await click(byText(document.body.querySelector('[aria-label="Confirm"]') as HTMLElement, 'button', 'Cancel'));
    expect(net.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  describe('People: what each role is offered', () => {
    it('an appointed admin: actions on ordinary accounts only, nothing on another admin or on themselves, no Reinstate for a ban', async () => {
      await open('admin');
      await tab('People');
      expect(buttonsIn(row('ada'))).toEqual(['Suspend', 'Ban', 'Make admin']);
      expect(buttonsIn(row('sam'))).toEqual(['Ban', 'Reinstate']);
      expect(buttonsIn(row('ben'))).toEqual([]);
      expect(buttonsIn(row('otheradmin'))).toEqual([]);
      expect(buttonsIn(row('mia'))).toEqual([]);
      expect(row('mia').textContent).toContain('(you)');
      expect(await axeViolations(document.body)).toBe('');
    });

    it('the master: also acts on admins and can reinstate a banned account', async () => {
      await open('master');
      await tab('People');
      expect(buttonsIn(row('ben'))).toEqual(['Reinstate']);
      expect(buttonsIn(row('otheradmin'))).toEqual(['Suspend', 'Ban']);
      expect(document.body.textContent).toContain('Master admin');
    });

    it('searching asks the server for names that start with the text', async () => {
      const net = await open('admin');
      await tab('People');
      await typeInto(byLabel(document.body, 'Search people by username') as HTMLInputElement, 'ad');
      await click(byText(document.body, 'button', 'Search'));
      expect(net.calls.some((c) => c.url.endsWith('/api/admin/users?q=ad'))).toBe(true);
    });
  });

  describe('Make admin', () => {
    it('an appointed admin is warned they lose the role, and after the hand-over the page tells the app', async () => {
      let lost = 0;
      const net = await open('admin', { onLostAdmin: () => { lost++; } });
      await tab('People');
      await click(byText(row('ada') as HTMLElement, 'button', 'Make admin'));
      expect(document.body.textContent).toContain('You stop being an admin the moment they become one.');
      await click(byText(document.body.querySelector('[aria-label="Confirm"]') as HTMLElement, 'button', 'Make admin'));
      await flush();
      expect(net.calls.find((c) => c.url.endsWith('/api/admin/appoint'))!.body).toEqual({ user_id: 'usr_a' });
      expect(lost).toBe(1);
    });

    it('the master is told they stay the master, and is not logged out of admin', async () => {
      let lost = 0;
      const n = installFetch({ ...routes(), 'POST /api/admin/appoint': () => json({ success: true, your_role: 'master' }) }); cleanups.push(n.restore);
      m = await mount(<AdminPage currentUser={meAs('master')} onBack={() => undefined} onLostAdmin={() => { lost++; }} />);
      await flush(); await flush();
      await tab('People');
      await click(byText(row('ada') as HTMLElement, 'button', 'Make admin'));
      expect(document.body.textContent).toContain('You stay the master admin.');
      expect(document.body.textContent).not.toContain('You stop being an admin');
      await click(byText(document.body.querySelector('[aria-label="Confirm"]') as HTMLElement, 'button', 'Make admin'));
      await flush();
      expect(lost).toBe(0);
      expect(document.body.textContent).toContain('@ada is now an admin.');
    });

    it('a refusal from the server is shown and nothing else changes', async () => {
      const n = installFetch({ ...routes(), 'POST /api/admin/appoint': () => json({ error: 'That account is already an admin' }, 409) }); cleanups.push(n.restore);
      let lost = 0;
      m = await mount(<AdminPage currentUser={meAs('admin')} onBack={() => undefined} onLostAdmin={() => { lost++; }} />);
      await flush(); await flush();
      await tab('People');
      await click(byText(row('ada') as HTMLElement, 'button', 'Make admin'));
      await click(byText(document.body.querySelector('[aria-label="Confirm"]') as HTMLElement, 'button', 'Make admin'));
      await flush();
      expect(document.body.textContent).toContain('That account is already an admin');
      expect(lost).toBe(0);
    });
  });

  it('Activity lists what happened, naming the master only as "The master admin"', async () => {
    await open('admin');
    await tab('Activity');
    const text = document.body.textContent!;
    expect(text).toContain('The master admin suspended @sam');
    expect(text).toContain('@mia handed the admin role to @ada');
    expect(text).not.toContain('@master admin');
    expect(await axeViolations(document.body)).toBe('');
  });
});

describe('Settings: the Admin tools entry and the account id', () => {
  const settings = (role: 'user' | 'admin' | 'master', withHandler = true) => (
    <LayoutProvider>
      <SettingsPage currentUser={meAs(role)} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} onOpenAdmin={withHandler ? () => undefined : undefined} />
    </LayoutProvider>
  );
  const net = () => installFetch({ 'GET /api/blocks': () => json({ blocks: [] }), 'GET /api/me/interests': () => json({ interests: [] }), 'GET /api/stickers/library': () => json({ items: [] }) });

  for (const role of ['admin', 'master'] as const) {
    it(`${role}: Admin tools is offered and opens the admin page`, async () => {
      cleanups.push(net().restore);
      let opened = 0;
      m = await mount(<LayoutProvider><SettingsPage currentUser={meAs(role)} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} onOpenAdmin={() => { opened++; }} /></LayoutProvider>);
      await flush(); await flush();
      await click(byText(document.body, '[role="tab"]', 'Account'));
      await click(byText(document.body, 'button', 'Open admin tools'));
      expect(opened).toBe(1);
    });
  }

  it('an ordinary account never sees the entry, even if the app passed a handler', async () => {
    cleanups.push(net().restore);
    m = await mount(settings('user'));
    await flush(); await flush();
    await click(byText(document.body, '[role="tab"]', 'Account')); // where the entry would be
    expect(byText(document.body, 'button', 'Open admin tools')).toBeNull();
    expect(document.body.textContent).not.toContain('Admin tools');
  });

  it('everyone can see and copy their own account id (the bootstrap command needs it)', async () => {
    cleanups.push(net().restore);
    m = await mount(settings('user'));
    await flush(); await flush();
    await click(byText(document.body, '[role="tab"]', 'Account'));
    expect(document.body.textContent).toContain('Account ID: usr_me');
    expect(byText(document.body, 'button', 'Copy')).not.toBeNull();
  });
});
