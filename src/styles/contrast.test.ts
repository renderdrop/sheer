import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The contrast script (DESIGN v2 section 2): every text pair must reach 4.5:1 and every UI pair 3:1 (WCAG 2.x), computed from
 * the colour tokens in tokens.css, so a palette change that breaks a pair fails `npm run check`.
 */

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

const declarations = new Map<string, string>();
for (const match of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
  const [, name, value] = match;
  // The first declaration wins: later ones sit in media queries (forced-colors, reduced motion).
  if (name !== undefined && value !== undefined && !declarations.has(name)) declarations.set(name, value.trim());
}

/** Resolves a token to a #rrggbb value through `var()` chains. */
function resolveToken(name: string, seen: string[] = []): string {
  const raw = declarations.get(name);
  if (raw === undefined) throw new Error(`Unknown token ${name}`);
  if (seen.includes(name)) throw new Error(`Token cycle at ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  if (ref?.[1] !== undefined) return resolveToken(ref[1], [...seen, name]);
  if (!/^#[0-9a-f]{6}$/i.test(raw)) throw new Error(`${name} is not a plain hex colour: ${raw}`);
  return raw.toLowerCase();
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Pair {
  what: string;
  fg: string;
  bg: string;
}

const TEXT_MIN = 4.5;
const UI_MIN = 3;

// Text pairs (>= 4.5:1).
const TEXT_PAIRS: Pair[] = [
  { what: 'Ink on Canvas', fg: '--text-primary', bg: '--surface-canvas' },
  { what: 'Ink on White', fg: '--text-primary', bg: '--surface-panel' },
  { what: 'Ink on Sand', fg: '--text-primary', bg: '--surface-subtle' },
  { what: 'Ink on pressed', fg: '--text-primary', bg: '--surface-pressed' },
  { what: 'Ink on Solar (primary button, chips, active tool row)', fg: '--on-accent', bg: '--accent' },
  { what: 'Ink on Solar bright (primary hover)', fg: '--on-accent', bg: '--accent-bright' },
  { what: 'Ink on page area', fg: '--text-primary', bg: '--surface-page-area' },
  { what: 'Text-secondary on Canvas', fg: '--text-secondary', bg: '--surface-canvas' },
  { what: 'Text-secondary on White', fg: '--text-secondary', bg: '--surface-panel' },
  { what: 'Text-secondary on Sand', fg: '--text-secondary', bg: '--surface-subtle' },
  { what: 'Caption on White card', fg: '--text-secondary', bg: '--color-card' },
  { what: 'Danger text on White', fg: '--color-danger', bg: '--surface-panel' },
  { what: 'Danger text on Sand', fg: '--color-danger', bg: '--surface-subtle' },
  { what: 'Danger text on Canvas', fg: '--color-danger', bg: '--surface-canvas' },
  { what: 'White on danger (redact band, window close)', fg: '--color-white', bg: '--color-danger' },
];

// UI pairs (>= 3:1): edges, rings and the Ink partner of each yellow state (DESIGN 2.1 to 2.10).
const UI_PAIRS: Pair[] = [
  { what: 'Stone control edge on White', fg: '--color-stone', bg: '--surface-panel' },
  { what: 'Stone control edge on Sand', fg: '--color-stone', bg: '--surface-subtle' },
  { what: '2.1 focus ring hairline (Ink) against the Solar band', fg: '--color-ink', bg: '--accent' },
  { what: '2.1 focus ring hairline on White', fg: '--color-ink', bg: '--surface-panel' },
  { what: '2.1 focus ring hairline on Canvas', fg: '--color-ink', bg: '--surface-canvas' },
  { what: '2.1 focus ring hairline on page area', fg: '--color-ink', bg: '--surface-page-area' },
  { what: '2.2 selected thumbnail chip numerals (Ink on Solar)', fg: '--color-ink', bg: '--accent' },
  { what: '2.3 active tool row label (Ink on Solar)', fg: '--color-ink', bg: '--accent' },
  { what: '2.4 toggle on: Ink border on Solar track', fg: '--color-ink', bg: '--accent' },
  { what: '2.4 toggle off: Stone border on Sand track', fg: '--color-stone', bg: '--surface-subtle' },
  { what: '2.4 toggle off: Text-secondary knob on Sand track', fg: '--text-secondary', bg: '--surface-subtle' },
  { what: '2.5 slider thumb: Ink border on White', fg: '--color-ink', bg: '--surface-panel' },
  { what: '2.5 slider thumb: Ink border on Solar', fg: '--color-ink', bg: '--accent' },
  { what: '2.6 checkbox Stone border on White', fg: '--color-stone', bg: '--surface-panel' },
  { what: '2.6 checkbox checked: Ink border and check on Solar', fg: '--color-ink', bg: '--accent' },
  { what: '2.7 swatch Stone ring on White', fg: '--color-stone', bg: '--surface-panel' },
  { what: '2.7 swatch Stone ring on Sand', fg: '--color-stone', bg: '--surface-subtle' },
  { what: '2.7 selected swatch Ink ring on White', fg: '--color-ink', bg: '--surface-panel' },
  { what: '2.8 active tab: Ink label on White', fg: '--color-ink', bg: '--surface-panel' },
  { what: '2.9 input bottom edge (Stone) on White', fg: '--color-stone', bg: '--surface-panel' },
  { what: '2.10 segmented active border (Stone) on White segment', fg: '--color-stone', bg: '--surface-panel' },
  { what: '2.10 segmented active border (Stone) on Sand track', fg: '--color-stone', bg: '--surface-subtle' },
  { what: 'Danger outline on White', fg: '--color-danger', bg: '--surface-panel' },
];

function failures(pairs: readonly Pair[], min: number): string[] {
  return pairs
    .map((pair) => ({ pair, ratio: contrastRatio(resolveToken(pair.fg), resolveToken(pair.bg)) }))
    .filter(({ ratio }) => ratio < min)
    .map(({ pair, ratio }) => `${pair.what}: ${ratio.toFixed(2)}:1 < ${min}:1`);
}

describe('contrast of the colour tokens (DESIGN v2 section 2)', () => {
  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The documented values from DESIGN section 2 and the token comments.
    expect(contrastRatio(resolveToken('--color-stone'), '#ffffff')).toBeCloseTo(3.47, 1);
    expect(contrastRatio(resolveToken('--color-danger'), '#ffffff')).toBeCloseTo(5.34, 1);
    expect(contrastRatio(resolveToken('--accent'), '#ffffff')).toBeCloseTo(1.12, 1);
  });

  it('the self-test catches a failing pair', () => {
    // Solar on White is the pair the whole of section 2 exists for.
    const bad: Pair[] = [{ what: 'Solar on White', fg: '--accent', bg: '--surface-panel' }];
    expect(failures(bad, TEXT_MIN)).toHaveLength(1);
    expect(failures(bad, UI_MIN)).toHaveLength(1);
    expect(failures([{ what: 'Ink on White', fg: '--text-primary', bg: '--surface-panel' }], TEXT_MIN)).toEqual([]);
  });

  it('every text pair reaches 4.5:1', () => {
    expect(failures(TEXT_PAIRS, TEXT_MIN)).toEqual([]);
  });

  it('every UI pair reaches 3:1', () => {
    expect(failures(UI_PAIRS, UI_MIN)).toEqual([]);
  });

  it('documents the one known exception: Text-secondary on the page area stays below 4.5:1', () => {
    const ratio = contrastRatio(resolveToken('--text-secondary'), resolveToken('--surface-page-area'));
    expect(ratio).toBeCloseTo(4.38, 1);
    expect(ratio).toBeLessThan(TEXT_MIN);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('Text-secondary is never used on the page area', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = sourceFiles(root).filter((file) => !file.endsWith('tokens.css'));
  const PAGE_AREA = /bg-page-area|surface-page-area|color-page-area/;
  const SECONDARY = /text-text-muted|text-muted|text-secondary|color-text-muted/;

  it('scans the sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no line or CSS rule combines them', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const chunks = file.endsWith('.css') ? text.split('}') : text.split('\n');
      if (chunks.some((chunk) => PAGE_AREA.test(chunk) && SECONDARY.test(chunk))) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
