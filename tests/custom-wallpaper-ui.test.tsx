// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { ProfileEditPage } from '../src/pages/ProfileEditPage.tsx';
import { mount, click, flush, byText, axeViolations, installFetch, json, pngFile, type Mounted } from './_ui.tsx';
import type { MeResponse } from '../shared/schema.ts';
import { CUSTOM_WALLPAPER_SCRIM } from '../shared/presets.ts';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/media-upload.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib/media-upload.ts')>();
  // Canvas work cannot run in jsdom; the compression itself is covered in media-client.test.ts
  return { ...real, prepareProfileBackground: prepare };
});

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(() => { m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; prepare.mockReset(); });

const baseMe = (profile: Partial<MeResponse['profile']> = {}): MeResponse =>
  ({
    user: { id: 'usr_me', created_at: '', status: 'active' },
    profile: { username: 'mia', username_normalized: 'mia', display_name: 'Mia', bio: '', avatar_media_id: null, class_id: null, campus_id: null, ...profile },
    settings: { dm_policy: 'everyone', feed_preferences: 'for_you' },
  }) as MeResponse;

async function open(me: MeResponse) {
  const net = installFetch({
    'GET /api/classes': () => json({ classes: [] }),
    'PATCH /api/me': () => json(me),
  });
  restores.push(net.restore);
  m = await mount(<ProfileEditPage currentUser={me} onProfileUpdated={() => undefined} onViewPublicProfile={() => undefined} onCancel={() => undefined} />);
  await flush();
  return net;
}

async function pick(label: string, file: File) {
  const input = m!.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

const patchBody = (net: Awaited<ReturnType<typeof open>>) => net.calls.filter((c) => c.method === 'PATCH').at(-1)?.body as Record<string, unknown>;

describe('Profile style picker: your own image', () => {
  it('picks an image, previews it under the scrim, and saves only the media id', async () => {
    prepare.mockResolvedValue({ id: 'med_bg1', kind: 'background' });
    const net = await open(baseMe());
    expect(byText(m!.container, 'button', 'Remove image')).toBeNull(); // positive control: nothing to remove yet
    await pick('Choose your own background image', pngFile());
    expect(prepare).toHaveBeenCalledTimes(1);

    const preview = m!.container.querySelector<HTMLElement>('[data-testid="style-preview"]')!;
    expect(preview.style.backgroundImage.replace(/\s/g, '')).toContain(CUSTOM_WALLPAPER_SCRIM.replace(/\s/g, ''));
    expect(preview.style.backgroundImage).toContain('/api/media/med_bg1');
    expect(byText(m!.container, 'button', 'Remove image')).not.toBeNull();

    await click(byText(m!.container, 'button', 'Done'));
    await flush();
    const body = patchBody(net);
    expect(body.wallpaper_media_id).toBe('med_bg1');
    expect(body.wallpaper_id).toBeUndefined();
  });

  it('Remove image sends a null wallpaper and no media id', async () => {
    const net = await open(baseMe({ wallpaper_id: 'custom', wallpaper_media_id: 'med_old' }));
    await click(byText(m!.container, 'button', 'Remove image'));
    expect(byText(m!.container, 'button', 'Remove image')).toBeNull();
    await click(byText(m!.container, 'button', 'Done'));
    await flush();
    const body = patchBody(net);
    expect(body.wallpaper_id).toBeNull();
    expect(body.wallpaper_media_id).toBeUndefined();
  });

  it('an upload error is shown and nothing is selected', async () => {
    prepare.mockRejectedValue(new Error('The picture is still 900 KB after shrinking. Try a simpler picture.'));
    await open(baseMe());
    await pick('Choose your own background image', pngFile());
    expect(m!.container.querySelector('[role="alert"]')?.textContent).toContain('still 900 KB');
    expect(byText(m!.container, 'button', 'Remove image')).toBeNull();
  });

  it('has no axe violations with an image set (contrast is covered by the numeric test)', async () => {
    await open(baseMe({ wallpaper_id: 'custom', wallpaper_media_id: 'med_old' }));
    expect(await axeViolations(m!.container)).toBe('');
    // positive control: the labelled file input and the radio for the image are really there
    expect(m!.container.querySelector('input[aria-label="Replace your background image"]')).not.toBeNull();
    expect(m!.container.querySelector('input[type="radio"][value="custom"]')).not.toBeNull();
  });
});
