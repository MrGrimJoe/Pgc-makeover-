import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { scanMarkup, describeViolations } from './_axe.ts';
import { SignInPage } from '../src/pages/SignInPage.tsx';
import { OnboardingPage } from '../src/pages/OnboardingPage.tsx';
import { CampusPickerView, type CampusPickerViewProps } from '../src/components/CampusPicker.tsx';
import { ProfileStylePicker } from '../src/components/ProfileStylePicker.tsx';
import { Avatar } from '../src/components/Avatar.tsx';
import type { CampusItem } from '../shared/schema.ts';

async function expectClean(element: React.ReactElement) {
  const results = await scanMarkup(renderToStaticMarkup(element));
  expect(results.passes.length, 'axe should have actually run rules').toBeGreaterThan(0);
  expect(results.violations, describeViolations(results)).toEqual([]);
}

const noop = () => {};
const campuses: CampusItem[] = [
  { id: 'c1', name: 'Central Campus', city: 'Lahore', status: 'approved' },
  { id: 'c2', name: 'North Campus', city: 'Karachi', status: 'pending' },
];

function pickerProps(over: Partial<CampusPickerViewProps> = {}): CampusPickerViewProps {
  return {
    id: 'campus',
    label: 'Campus',
    selected: null,
    editing: false,
    query: '',
    open: false,
    loading: false,
    results: [],
    activeIndex: -1,
    cities: [],
    city: '',
    canRequest: false,
    requestOpen: false,
    requestCity: '',
    requesting: false,
    message: null,
    onQueryChange: noop,
    onFocus: noop,
    onKeyDown: noop,
    onSelect: noop,
    onChange: noop,
    onCityChange: noop,
    onOpenRequest: noop,
    onRequestCityChange: noop,
    onSubmitRequest: noop,
    onCancelRequest: noop,
    ...over,
  };
}

describe('Accessibility: sign up and profile styling', () => {
  it('sign-in screen has no violations', async () => {
    await expectClean(<SignInPage />);
  });

  it('sign-in screen with the "no account" notice has no violations', async () => {
    await expectClean(<SignInPage notice="no_account" />);
  });

  it('onboarding page (loading state) has no violations', async () => {
    await expectClean(<OnboardingPage onComplete={noop} onRestart={noop} />);
  });

  describe('campus picker', () => {
    it('closed, nothing chosen', async () => {
      await expectClean(<CampusPickerView {...pickerProps()} />);
    });

    it('open with results, the add option and a city filter', async () => {
      const html = renderToStaticMarkup(
        <CampusPickerView
          {...pickerProps({ query: 'cen', open: true, results: campuses, activeIndex: 1, cities: ['Karachi', 'Lahore'], canRequest: true })}
        />
      );
      expect(html).toContain('role="listbox"');
      expect(html).toContain('aria-activedescendant="campus-option-1"');
      expect(html).toContain('My campus is not listed');
      const results = await scanMarkup(html);
      expect(results.violations, describeViolations(results)).toEqual([]);
    });

    it('with nothing found, the list is not rendered and a message is announced', async () => {
      const html = renderToStaticMarkup(<CampusPickerView {...pickerProps({ query: 'zzz', open: true })} />);
      expect(html).not.toContain('role="listbox"');
      expect(html).toContain('No campus found');
      const results = await scanMarkup(html);
      expect(results.violations, describeViolations(results)).toEqual([]);
    });

    it('request form open, with an error', async () => {
      await expectClean(
        <CampusPickerView {...pickerProps({ query: 'Green Valley', requestOpen: true, requestCity: 'Multan', message: 'Too many campus requests.' })} />
      );
    });

    it('a campus is selected (pending review)', async () => {
      const html = renderToStaticMarkup(<CampusPickerView {...pickerProps({ selected: campuses[1]! })} />);
      expect(html).toContain('Waiting for review');
      const results = await scanMarkup(html);
      expect(results.violations, describeViolations(results)).toEqual([]);
    });
  });

  it('profile style picker (default and customised) has no violations', async () => {
    const base = { displayName: 'Ayesha', username: 'ayesha_k', bio: 'Hello there', avatarMediaId: null, onChange: noop };
    await expectClean(<ProfileStylePicker {...base} value={{ wallpaper_id: null, theme_id: null, text_style_id: null }} />);
    await expectClean(<ProfileStylePicker {...base} value={{ wallpaper_id: 'dusk', theme_id: 'coral', text_style_id: 'serif' }} />);
  });

  it('avatar renders one initial or the picture', () => {
    expect(renderToStaticMarkup(<Avatar displayName="ayesha" username="a" size={32} />)).toContain('>A<');
    const withPicture = renderToStaticMarkup(<Avatar mediaId="med_1" displayName="x" size={32} />);
    expect(withPicture).toContain('src="/api/media/med_1"');
    expect(withPicture).toContain('alt=""');
  });

  it('picker radio groups are labelled fieldsets', () => {
    const html = renderToStaticMarkup(
      <ProfileStylePicker displayName="A" username="a" bio="" avatarMediaId={null} onChange={noop} value={{ wallpaper_id: 'mist', theme_id: null, text_style_id: null }} />
    );
    expect(html.match(/<fieldset/g)).toHaveLength(3);
    expect(html).toContain('<legend');
    const mistRadio = html.match(/<input[^>]*value="mist"[^>]*>/)?.[0] ?? '';
    expect(mistRadio).toContain('checked');
    const plainRadio = html.match(/<input[^>]*value="plain"[^>]*>/)?.[0] ?? '';
    expect(plainRadio).not.toContain('checked');
  });
});
