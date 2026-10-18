import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import { PostComposerPage } from '../src/pages/PostComposerPage.tsx';
import { SearchPage } from '../src/pages/SearchPage.tsx';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];

/**
 * Run axe-core (WCAG 2.0 A/AA + 2.1 AA) against rendered markup.
 * The markup is wrapped in <main> with a lang and title so page-level rules do
 * not fire on the fragment. jsdom has no layout engine, so color-contrast is
 * reported as "incomplete" rather than checked; it needs a real browser.
 */
async function scan(markup: string) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>Test page</title></head><body><main>${markup}</main></body></html>`,
    { runScripts: 'outside-only' }
  );
  try {
    dom.window.eval(axe.source);
    return await (dom.window as unknown as { axe: typeof axe }).axe.run(dom.window.document, {
      runOnly: { type: 'tag', values: TAGS },
    });
  } finally {
    dom.window.close();
  }
}

function describeViolations(results: Awaited<ReturnType<typeof scan>>): string {
  return results.violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` + v.nodes.map((n) => `    ${n.html}`).join('\n')
    )
    .join('\n');
}

describe('Accessibility (axe-core, wcag2a + wcag2aa + wcag21aa)', () => {
  it('Compose screen has no violations', async () => {
    const results = await scan(renderToStaticMarkup(<PostComposerPage onPostCreated={() => {}} />));
    expect(results.passes.length, 'axe should have actually run rules').toBeGreaterThan(0);
    expect(results.violations, describeViolations(results)).toEqual([]);
  });

  it('Search screen (empty state) has no violations', async () => {
    const results = await scan(
      renderToStaticMarkup(<SearchPage currentUserId="usr_x" onViewAuthorProfile={() => {}} />)
    );
    expect(results.passes.length).toBeGreaterThan(0);
    expect(results.violations, describeViolations(results)).toEqual([]);
  });

  it('the scan catches the original bug: aria-label on a <label> (aria-prohibited-attr)', async () => {
    // Icon-only label (an SVG, no text), exactly like the old photo picker. With visible
    // text axe only asks for manual review; with no text it is a hard violation.
    const results = await scan(
      '<label for="f" aria-label="Add photo"><svg aria-hidden="true" width="24" height="24"></svg></label>' +
        '<input id="f" type="file" class="hidden">'
    );
    expect(results.violations.map((v) => v.id)).toContain('aria-prohibited-attr');
  });
});
