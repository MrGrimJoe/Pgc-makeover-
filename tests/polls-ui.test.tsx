// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PostCard } from '../src/components/PostCard.tsx';
import { PostComposerPage } from '../src/pages/PostComposerPage.tsx';
import { mount, click, typeInto, flush, byLabel, byText, axeViolations, installFetch, json, type Mounted } from './_ui.tsx';
import type { PostItem, PollItem } from '../shared/schema.ts';

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(() => { m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; });

const post = (poll: PollItem | null): PostItem => ({
  id: 'p1', author_id: 'u2', author_username: 'zed', author_display_name: 'Zed', author_avatar_media_id: null, body: 'Lunch?',
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'active', media: [],
  likes_count: 0, has_liked: false, comments_count: 0, poll,
});
const hidden: PollItem = { options: [{ id: 'o1', text: 'Pizza' }, { id: 'o2', text: 'Biryani' }], my_vote: null, closed: false };

describe('poll builder in the composer', () => {
  const open = async () => {
    const net = installFetch({ 'POST /api/posts': () => json({ id: 'p9' }, 201) }); restores.push(net.restore);
    const onCreated = vi.fn();
    m = await mount(<PostComposerPage currentUserId="u1" onPostCreated={onCreated} />);
    return { net, onCreated };
  };
  const postButton = () => byText(m!.container, 'button', 'Post') as HTMLButtonElement;

  it('Post stays disabled until two options are filled; then sends the cleaned options', async () => {
    const { net, onCreated } = await open();
    await typeInto(m!.container.querySelector('textarea')!, 'Lunch?');
    await click(byLabel(m!.container, 'Add poll'));
    expect(postButton().disabled).toBe(true);
    await typeInto(byLabel(m!.container, 'Poll option 1') as HTMLInputElement, '  Pizza ');
    expect(postButton().disabled).toBe(true); // one option is not enough
    await typeInto(byLabel(m!.container, 'Poll option 2') as HTMLInputElement, 'Biryani');
    expect(postButton().disabled).toBe(false);
    await click(postButton());
    await flush();
    const body = net.calls.find((c) => c.method === 'POST')!.body as any;
    expect(body.poll).toEqual({ options: ['Pizza', 'Biryani'] });
    expect(onCreated).toHaveBeenCalled();
  });

  it('allows 2 to 6 options: add stops at 6, remove stops at 2, duplicates block posting', async () => {
    await open();
    await typeInto(m!.container.querySelector('textarea')!, 'q');
    await click(byLabel(m!.container, 'Add poll'));
    expect(byLabel(m!.container, 'Remove poll option 1')).toBeNull(); // only 2: cannot go lower
    for (let i = 0; i < 4; i++) await click(byText(m!.container, 'button', 'Add option'));
    expect(m!.container.querySelectorAll('input[aria-label^="Poll option"]')).toHaveLength(6);
    expect((byText(m!.container, 'button', 'Add option') as HTMLButtonElement).disabled).toBe(true);
    await click(byLabel(m!.container, 'Remove poll option 6'));
    expect(m!.container.querySelectorAll('input[aria-label^="Poll option"]')).toHaveLength(5);
    await typeInto(byLabel(m!.container, 'Poll option 1') as HTMLInputElement, 'Same');
    await typeInto(byLabel(m!.container, 'Poll option 2') as HTMLInputElement, 'same');
    expect(postButton().disabled).toBe(true);
    expect(m!.container.textContent).toContain('different from each other');
  });

  it('a poll and photos or stickers exclude each other, and Remove poll brings them back', async () => {
    await open();
    expect((byLabel(m!.container, 'Add photo') as HTMLButtonElement).disabled).toBe(false);
    await click(byLabel(m!.container, 'Add poll'));
    expect((byLabel(m!.container, 'Add photo') as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel(m!.container, 'Add sticker or GIF') as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel(m!.container, 'Add poll') as HTMLButtonElement).disabled).toBe(true);
    await click(byText(m!.container, 'button', 'Remove poll'));
    expect((byLabel(m!.container, 'Add photo') as HTMLButtonElement).disabled).toBe(false);
  });

  it('has no axe violations with the builder open', async () => {
    await open();
    await click(byLabel(m!.container, 'Add poll'));
    expect(await axeViolations(m!.container)).toBe('');
    expect(m!.container.querySelectorAll('input[aria-label^="Poll option"]').length).toBe(2); // positive control
  });
});

describe('poll on a post card', () => {
  it('shows only the options before voting, then the counts the server returns, and marks my vote', async () => {
    const net = installFetch({
      'PUT /api/posts/p1/poll/vote': () => json({ poll: { options: [{ id: 'o1', text: 'Pizza', votes: 3 }, { id: 'o2', text: 'Biryani', votes: 1 }], my_vote: 'o1', total_votes: 4, closed: false } }),
    }); restores.push(net.restore);
    m = await mount(<PostCard post={post(hidden)} currentUserId="u1" />);
    expect(m.container.textContent).toContain('Vote to see results');
    expect(m.container.textContent).not.toMatch(/\d+%/);
    expect(await axeViolations(m.container)).toBe('');

    await click(byText(m.container, 'button', 'Pizza'));
    await flush();
    expect((net.calls.find((c) => c.method === 'PUT')!.body as any)).toEqual({ option_id: 'o1' });
    expect(m.container.textContent).toContain('4 votes');
    expect(m.container.textContent).toContain('75%');
    const buttons = [...m.container.querySelectorAll<HTMLButtonElement>('[data-testid="poll"] button')];
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(buttons[0]!.textContent).toContain('your vote');
    expect(await axeViolations(m.container)).toBe('');
  });

  it('a closed poll cannot be voted on, and a failed vote shows the server message', async () => {
    const net = installFetch({ 'PUT /api/posts/p1/poll/vote': () => json({ error: 'This poll is closed' }, 409) }); restores.push(net.restore);
    m = await mount(<PostCard post={post({ ...hidden, closed: true })} currentUserId="u1" />);
    expect((byText(m.container, 'button', 'Pizza') as HTMLButtonElement).disabled).toBe(true);
    expect(m.container.textContent).toContain('Poll closed');
    m.unmount();

    m = await mount(<PostCard post={post(hidden)} currentUserId="u1" />);
    await click(byText(m.container, 'button', 'Pizza'));
    await flush();
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('This poll is closed');
    expect(m.container.textContent).not.toMatch(/\d+%/);
  });

  it('a post without a poll has no poll area (positive control for the test above)', async () => {
    m = await mount(<PostCard post={post(null)} currentUserId="u1" />);
    expect(m.container.querySelector('[data-testid="poll"]')).toBeNull();
  });
});
