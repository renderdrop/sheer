import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');
const num = (name: string, unit: 'px' | '' = 'px'): number => {
  const match = new RegExp(`--${name}:\\s*([0-9.]+)${unit};`).exec(tokens);
  if (match?.[1] === undefined) throw new Error(`token ${name} missing`);
  return Number(match[1]);
};

/** Tailwind classes Home uses between its sections: `mt-4`, `gap-2` (heading to list), `gap-3` (tools heading to rows). */
const SECTION_GAP = num('space-4');
const HEAD_GAP = num('space-2');
const TOOLS_HEAD_GAP = num('space-3');
/** The tallest banner Home shows above its body: the recovery notice, two lines, measured 73.6 in WebView2 (v20rc2 run). */
const BANNER = 74;
const TOOLS = 8;

/**
 * The layout chain of Home from the window top to the tools' last row (jsdom has no layout, so this is the sum of the tokens that
 * set each height, F19.6): the 56 strip, the banner slot, the main column's top padding, the compact hero, the "Open" row, two
 * rows of recent cards under a heading that carries "Show all", then the tools heading and rows.
 */
function toolsBottom(windowWidth: number, { openTabs }: { openTabs: boolean }) {
  const chrome = num('topbar-height') + BANNER;
  const top = num('home-main-top');
  const hero = num('home-hero-compact');
  const title = num('type-title-line');
  const open = openTabs ? SECTION_GAP + title + HEAD_GAP + num('home-open-height') : 0;
  // The heading row is as high as its "Show all" ghost button (control sm), which is taller than the title line.
  const recentHead = Math.max(title, num('control-sm'));
  const recent = SECTION_GAP + recentHead + HEAD_GAP + 2 * num('home-card-height') + num('space-4');
  const columns = windowWidth >= 1200 ? num('home-tool-columns-wide', '') : 1;
  const toolsTop = chrome + top + hero + open + recent + SECTION_GAP + title + TOOLS_HEAD_GAP;
  return { toolsTop, bottom: toolsTop + Math.ceil(TOOLS / columns) * num('home-row-height') };
}

describe('Home fits the window with open tabs and many recents (F19.6)', () => {
  it('keeps the compact hero tall enough for the plus and its padding', () => {
    expect(num('home-hero-compact')).toBeGreaterThanOrEqual(num('home-plus') + 2 * num('space-3'));
    expect(num('home-hero-compact')).toBeGreaterThanOrEqual(num('control-xl') + 2 * num('space-3'));
  });

  it('ends the tools 16 above the bottom of a 1280 x 800 window with four tabs open and a banner', () => {
    const { bottom } = toolsBottom(1280, { openTabs: true });
    expect(bottom).toBe(762);
    expect(bottom).toBeLessThanOrEqual(800 - 16);
  });

  it('fits a tool name over a two-line description in the 56 row, so wrapping keeps the rows at 56 (FX-6)', () => {
    expect(num('type-label-line') + 2 * num('type-caption-line')).toBeLessThanOrEqual(num('home-row-height'));
  });

  it('fits 1280 x 800 without open tabs too', () => {
    expect(toolsBottom(1280, { openTabs: false }).bottom).toBeLessThanOrEqual(800 - 16);
  });

  it('starts the tools above the fold at 960 x 640', () => {
    const { toolsTop } = toolsBottom(960, { openTabs: true });
    expect(toolsTop).toBeLessThan(640);
  });
});
