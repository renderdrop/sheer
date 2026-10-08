import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');
const px = (name: string): number => {
  const match = new RegExp(`--${name}:\\s*([0-9.]+)px`).exec(tokens);
  if (match?.[1] === undefined) throw new Error(`token ${name} missing`);
  return Number(match[1]);
};

// F19.6: at 1280 x 800 with open tabs and many recents the tools section must end inside the window (layout maths, jsdom has no layout).
describe('Home fits 1280 x 800 with open tabs', () => {
  it('sums the section heights below the window chrome', () => {
    const space = { pad: 32, gap: 16, headGap: 8, head: 28, toolsHeadGap: 12, recentGap: 16 };
    const hero = px('home-hero-compact');
    const open = space.gap + space.head + space.headGap + px('home-open-height');
    const recent = space.gap + space.head + space.headGap + 2 * px('home-card-height') + space.recentGap;
    const tools = space.gap + space.head + space.toolsHeadGap + 4 * px('home-row-height');
    const total = space.pad + hero + open + recent + tools;
    const chrome = 72; // title bar, tab strip and toolbar, upper bound
    expect(total).toBe(712);
    expect(total + chrome).toBeLessThanOrEqual(800);
  });
});
