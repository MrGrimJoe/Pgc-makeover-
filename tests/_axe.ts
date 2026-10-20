import { JSDOM } from 'jsdom';
import axe from 'axe-core';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];

/**
 * Runs axe-core against rendered markup. jsdom has no layout engine, so color-contrast is
 * reported as "incomplete" and still needs a check in a real browser.
 */
export async function scanMarkup(markup: string) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>Test page</title></head><body><main>${markup}</main></body></html>`,
    { runScripts: 'outside-only' }
  );
  try {
    dom.window.eval(axe.source);
    return await (dom.window as unknown as { axe: typeof axe }).axe.run(dom.window.document, {
      runOnly: { type: 'tag', values: AXE_TAGS },
    });
  } finally {
    dom.window.close();
  }
}

export function describeViolations(results: Awaited<ReturnType<typeof scanMarkup>>): string {
  return results.violations
    .map((v) => `[${v.impact}] ${v.id}: ${v.help}\n` + v.nodes.map((n) => `    ${n.html}`).join('\n'))
    .join('\n');
}
