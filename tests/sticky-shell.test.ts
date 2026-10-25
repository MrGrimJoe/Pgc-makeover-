import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// jsdom has no layout engine, so it cannot prove that a header sticks. What it can guard is the cause of the
// bug: `overflow-x-hidden` on <main> turns it into a scroll container and every sticky header and bar inside it
// (chat header, typing bar, Settings and Admin headers, desktop side lists) stops sticking to the window.
describe('app shell keeps sticky headers working', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const main = app.match(/<main className="([^"]*)"/)?.[1] ?? '';

  it('main clips horizontal overflow without becoming a scroll container', () => {
    expect(main).toContain('overflow-x-clip');
    expect(main).not.toMatch(/overflow-(x-)?(hidden|auto|scroll)/);
  });

  it('the phone chat header sticks under the 48px app bar and the typing bar above the 56px tab bar', () => {
    const chat = readFileSync('src/components/chat/ChatScreen.tsx', 'utf8');
    expect(chat).toContain("top-[48px]");
    expect(chat).toContain('dockAboveTabBar={!embedded}');
    const composer = readFileSync('src/components/chat/Composer.tsx', 'utf8');
    expect(composer).toContain("bottom: '56px'");
  });
});
