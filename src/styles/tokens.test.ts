import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LAYOUT, PANEL } from '../components/tokens';

/**
 * tokens.css against docs/DESIGN.md v2 section 1 (ADR-100), and the "tokens only" rule for the rest of src/.
 * The expected values below are transcribed from the spec tables, so a change on either side fails here.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const raw = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8');
/** Comments start at a line start or after a space, so the glob in `@source not` stays. */
const stripComments = (text: string): string => text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1');
const LEGACY_MARKER = '/* legacy aliases — removed in R7 (ADR-100) */';
const FORCED_MARKER = '/* Forced colors';
const legacyStart = raw.indexOf(LEGACY_MARKER);
const legacyEnd = raw.indexOf(FORCED_MARKER);
/** The whole file without comments, the part before the legacy block, and the legacy block itself. */
const css = stripComments(raw);
const main = stripComments(raw.slice(0, legacyStart));
const legacyCss = stripComments(raw.slice(legacyStart + LEGACY_MARKER.length, legacyEnd));

/** Lowercase, single spaces, no space after commas: Prettier's spelling of a value does not matter. */
const norm = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, ' ').replace(/,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

/** The bodies of all blocks in `source` whose header matches `header` (a regular expression source, at a line start). */
function blockBodies(source: string, header: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(new RegExp(`^\\s*${header}\\s*\\{`, 'gm'))) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (depth > 0 && index < source.length) {
      const char = source[index++];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    bodies.push(source.slice(start, index - 1));
  }
  if (bodies.length === 0) throw new Error(`no block matching ${header}`);
  return bodies;
}

const blockBody = (header: string): string => blockBodies(css, header).join('\n');

/** Custom property declarations of a block body, in order. Nested blocks are not parsed. */
function declarations(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    if (name !== undefined && value !== undefined) result.set(name, norm(value));
  }
  return result;
}

const themeStatic = declarations(blockBodies(main, '@theme static').join('\n'));
const root = declarations(blockBodies(main, ':root').join('\n'));
const legacy = declarations(legacyCss);

/** A token of the main part of the file (not the legacy block). */
const token = (name: string): string | undefined => themeStatic.get(name) ?? root.get(name);

describe('primitives (DESIGN 1.1)', () => {
  const primitives: Record<string, string> = {
    '--color-yellow': '#fff84d',
    '--color-yellow-bright': '#ffff22',
    '--color-ink': '#0f0f0f',
    '--color-text-secondary': '#6f6f6b',
    '--color-canvas': '#fafaf8',
    '--color-sand': '#f6f5f1',
    '--color-mist': '#dde2ea',
    '--color-border': '#e5e5e1',
    '--color-white': '#ffffff',
    '--color-stone': '#8a8a86',
    '--color-danger': '#c8321f',
  };

  it.each(Object.entries(primitives))('%s is %s, in :root and not a Tailwind utility', (name, value) => {
    expect(root.get(name)).toBe(value);
    expect(themeStatic.has(name)).toBe(false);
  });

  it('every primitive row of the DESIGN 1.1 table is in the file', () => {
    const design = readFileSync(join(SRC, '..', 'docs', 'DESIGN.md'), 'utf8').replace(/\r\n/g, '\n');
    const section = design.slice(design.indexOf('### 1.1'), design.indexOf('### 1.2'));
    let checked = 0;
    for (const line of section.split('\n').filter((entry) => entry.startsWith('| `'))) {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      for (let at = 0; at + 1 < cells.length; at += 2) {
        const name = /^`(--[\w-]+)`$/.exec(cells[at] ?? '')?.[1];
        const value = cells[at + 1] ?? '';
        if (name === undefined || /\//.test(name + value)) continue;
        expect(token(name), name).toBe(norm(value));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(13);
  });

  it('radii: sm 6, md 10, lg 14, xl 18, dialog 16, pill 999, and the aliases of the old names', () => {
    const radii = { sm: '6px', md: '10px', lg: '14px', xl: '18px', dialog: '16px', pill: '999px' };
    for (const [name, value] of Object.entries(radii)) expect(themeStatic.get(`--radius-${name}`), name).toBe(value);
    expect(themeStatic.get('--radius-button')).toBe('var(--radius-md)');
    expect(themeStatic.get('--radius-panel')).toBe('var(--radius-lg)');
    expect(themeStatic.get('--radius-card')).toBe('var(--radius-md)');
    expect(themeStatic.has('--radius-xs')).toBe(false);
  });

  it('spacing is the 4 px grid by BRAND names and Tailwind maps to it', () => {
    const space = {
      '1': 4,
      '2': 8,
      '3': 12,
      '4': 16,
      '5': 20,
      '6': 24,
      '8': 32,
      '10': 40,
      '12': 48,
      '16': 64,
      '20': 80,
      '24': 96,
    };
    for (const [name, px] of Object.entries(space)) {
      expect(root.get(`--space-${name}`), name).toBe(`${px}px`);
      expect(themeStatic.get(`--spacing-${name}`), name).toBe(`var(--space-${name})`);
    }
    expect(themeStatic.get('--spacing-0')).toBe('0px'); // so components never write min-w-[0]
    for (const old of ['0-5', '1-5']) {
      expect(root.has(`--space-${old}`), old).toBe(false);
      expect(themeStatic.has(`--spacing-${old}`), old).toBe(false);
    }
  });
});

describe('semantic tokens and the role layer (DESIGN 1.2, 1.3)', () => {
  const semantic: Record<string, string> = {
    '--surface-canvas': 'var(--color-canvas)',
    '--surface-panel': 'var(--color-white)',
    '--surface-page-area': '#efefec',
    '--surface-page': 'var(--color-white)',
    '--surface-subtle': 'var(--color-sand)',
    '--surface-pressed': '#e5e5e1',
    '--text-primary': 'var(--color-ink)',
    '--text-secondary': 'var(--color-text-secondary)',
    '--border-subtle': '1px solid var(--color-border)',
    '--border-control': '1px solid var(--color-stone)',
    '--accent': 'var(--color-yellow)',
    '--accent-bright': 'var(--color-yellow-bright)',
    '--on-accent': 'var(--color-ink)',
    '--ring-focus': '0 0 0 1px var(--color-ink),0 0 0 3px var(--accent)',
    '--opacity-disabled': '0.4',
    '--scrim': 'rgba(15,15,15,0.12)',
  };

  it.each(Object.entries(semantic))('%s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });

  it('shadows: two only, the numbered ones are aliases', () => {
    expect(themeStatic.get('--shadow-standard')).toBe('0 2px 12px rgba(0,0,0,0.04)');
    expect(themeStatic.get('--shadow-floating')).toBe('0 8px 30px rgba(0,0,0,0.08)');
    expect(themeStatic.get('--shadow-1')).toBe('var(--shadow-standard)');
    expect(themeStatic.get('--shadow-2')).toBe('var(--shadow-floating)');
    expect(themeStatic.get('--shadow-3')).toBe('var(--shadow-floating)');
    expect(root.get('--page-shadow')).toBe('var(--shadow-floating)');
    expect([...themeStatic.keys()].filter((name) => name.startsWith('--shadow-'))).toHaveLength(5);
  });

  /** The role layer re-pointed per the 1.3 table: every Tailwind color keeps its name. */
  const roles: Record<string, string> = {
    '--color-app': 'var(--surface-canvas)',
    '--color-panel': 'var(--surface-panel)',
    '--color-subtle': 'var(--surface-subtle)',
    '--color-pressed': 'var(--surface-pressed)',
    '--color-page-area': 'var(--surface-page-area)',
    '--color-scrollbar': 'rgba(15,15,15,0.2)',
    '--color-scrollbar-hover': 'rgba(15,15,15,0.36)',
    '--color-text': 'var(--text-primary)',
    '--color-text-muted': 'var(--text-secondary)',
    '--color-text-disabled': 'var(--color-stone)',
    '--color-icon-disabled': 'var(--color-stone)',
    '--color-accent': 'var(--accent)',
    '--color-accent-hover': 'var(--accent-bright)',
    '--color-accent-pressed': 'var(--accent)',
    '--color-on-accent': 'var(--on-accent)',
    '--color-focus': 'var(--accent)',
    '--color-control-border': 'var(--color-stone)',
    '--color-control-hover': 'var(--color-sand)',
    '--color-control-pressed': 'var(--surface-pressed)',
    '--color-selected': 'var(--color-sand)',
    '--color-fill-disabled': 'var(--color-sand)',
    '--color-track': 'var(--surface-pressed)',
    '--color-divider': 'var(--color-border)',
    '--color-tile': 'var(--color-sand)',
    '--color-tile-icon': 'var(--color-ink)',
    '--color-card': 'var(--color-white)',
    '--color-tooltip-bg': 'var(--color-white)',
    '--color-tooltip-text': 'var(--color-ink)',
    '--color-tooltip-key': 'var(--color-sand)',
    '--color-error-icon': 'var(--color-danger)',
    '--color-error-text': 'var(--color-danger)',
    '--color-surface': 'var(--color-white)',
    '--color-surface-strong': 'var(--color-white)',
    '--color-surface-solid': 'var(--color-white)',
    '--color-backdrop': 'var(--scrim)',
    '--color-on-close': 'var(--color-white)',
    '--win-close-hover': 'var(--color-danger)',
    '--color-page': 'var(--surface-page)',
    '--color-doc-paper': 'var(--color-white)',
    '--color-doc-ink': 'var(--color-ink)',
    '--color-doc-select': 'var(--color-ink)',
    '--color-doc-hover': 'var(--color-stone)',
    '--color-doc-text-select': 'color-mix(in srgb,var(--hl-solar) 35%,transparent)',
    '--color-doc-hit': 'color-mix(in srgb,var(--hl-solar) 70%,transparent)',
    '--color-doc-hit-active': 'var(--hl-solar)',
    '--color-doc-field': 'rgba(221,226,234,0.6)',
    '--color-doc-field-hover': 'var(--color-mist)',
    '--color-doc-required': 'var(--color-ink)',
    '--color-doc-redact': 'var(--color-danger)',
    '--color-doc-redact-fill': 'rgba(200,50,31,0.12)',
    '--color-doc-crop-shade': 'rgba(15,15,15,0.4)',
  };

  it.each(Object.entries(roles))('%s', (name, value) => {
    expect(token(name)).toBe(value);
  });

  it('the roles the table removes are gone: yellow text, success, warning, background fields', () => {
    for (const name of [
      '--color-text-accent',
      '--color-success-icon',
      '--color-success-text',
      '--color-warning-icon',
      '--color-warning-text',
      '--color-bg',
      '--bg-gradient',
      '--canvas-edge',
      '--ground-shadow',
      '--glass-filter',
      '--glass-edge',
      '--surface',
      '--surface-solid',
      '--surface-fallback',
    ]) {
      expect(css, name).not.toMatch(new RegExp(`${name}\\s*:`));
    }
  });

  it('light only: no dark values, no glass, no solid mode, no theme or transparency selectors', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('prefers-reduced-transparency');
    expect(css).not.toContain('data-theme');
    expect(css).not.toContain('data-transparency');
    expect(css).not.toContain('@custom-variant');
    expect(css).not.toContain('backdrop-filter');
    expect(css).not.toMatch(/@utility (glass|surface)/);
    expect(blockBody(':root')).toMatch(/color-scheme: light;/);
  });
});

describe('highlight, stroke and glow tokens (DESIGN 1.4, 5)', () => {
  const palette: Record<string, [string, string]> = {
    solar: ['#fff84d', '#fff84d'],
    mint: ['#7debb5', '#1f9e6a'],
    sky: ['#a3deff', '#3d8fd1'],
    rose: ['#ffc7d7', '#e15c86'],
    lavender: ['#dccfff', '#9278e6'],
  };

  it.each(Object.entries(palette))('%s', (name, [highlight, stroke]) => {
    expect(root.get(`--hl-${name}`)).toBe(highlight);
    expect(root.get(`--stroke-${name}`)).toBe(stroke);
  });

  it('Ink is the default stroke and --ink-signature is the only blue', () => {
    expect(root.get('--stroke-ink')).toBe('#0f0f0f');
    expect(root.get('--ink-signature')).toBe('#1f3a93');
  });

  it('glow recipes: Solar at most 0.95 alpha, the Mist counter-light at 20% 10%', () => {
    expect(root.get('--glow-mist')).toBe('radial-gradient(circle at 20% 10%,rgba(221,226,234,0.8),transparent 45%)');
    expect(root.get('--glow-hero')).toContain('circle at 80% 85%,rgba(255,248,77,0.95) 0%,rgba(255,248,77,0.55) 22%');
    expect(root.get('--glow-hero')).toContain('transparent 55%'.replace('transparent', 'rgba(255,248,77,0)'));
    expect(root.get('--glow-empty')).toContain('circle at 70% 75%,rgba(255,255,34,0.9),transparent 48%');
    expect(root.get('--glow-card')).toBe('radial-gradient(circle at 90% 90%,rgba(255,248,77,0.7),transparent 60%)');
    expect(root.get('--glow-drop')).toBe('var(--glow-empty)');
    expect(root.get('--glow-splash')).toContain('rgba(255,255,34,0.9)');
    for (const name of ['hero', 'empty', 'card', 'drop', 'splash']) expect(root.has(`--glow-${name}`), name).toBe(true);
    for (const [, alpha] of css.matchAll(/rgba\(255, ?(?:248, ?77|255, ?34), ?([\d.]+)\)/g)) {
      expect(Number(alpha)).toBeLessThanOrEqual(0.95);
    }
  });
});

describe('sizes and the focus ring (DESIGN 1.3, 2)', () => {
  it('control and target sizes, hairline, focus band', () => {
    expect(root.get('--control-sm')).toBe('28px');
    expect(root.get('--control-md')).toBe('36px');
    expect(root.get('--control-lg')).toBe('40px');
    expect(root.get('--control-xl')).toBe('44px');
    expect(root.get('--target-min')).toBe('24px');
    expect(root.get('--target-default')).toBe('var(--control-md)');
    expect(root.get('--hairline')).toBe('1px');
    expect(root.get('--focus-width')).toBe('2px');
    expect(root.get('--focus-offset')).toBe('2px');
  });

  it('icon sizes and stroke; --icon-12 and --icon-stroke-sm are gone', () => {
    for (const size of [16, 18, 20, 24]) expect(root.get(`--icon-${size}`)).toBe(`${size}px`);
    expect(root.get('--icon-stroke')).toBe('1.75px');
    expect(token('--icon-12')).toBeUndefined();
    expect(token('--icon-stroke-sm')).toBeUndefined();
    expect(legacy.has('--icon-12')).toBe(false);
    expect(legacy.has('--icon-stroke-sm')).toBe(false);
  });

  it('the ring is a box-shadow of the focus-visible rule, with a transparent outline for forced colors', () => {
    expect(css).toMatch(
      /:focus-visible:not\([^)]*\)\s*\{\s*outline: var\(--focus-width\) solid transparent;\s*box-shadow: var\(--ring-focus\);/,
    );
  });

  it('the selected swatch is an Ink ring and the annotation ring pairs Solar with an Ink hairline', () => {
    expect(css).toMatch(
      /\[data-swatch\]\[aria-checked="true"\]\s*\{\s*outline: var\(--focus-width\) solid var\(--color-ink\);/,
    );
    expect(css).toMatch(
      /\[data-annot-ring\]\s*\{[^}]*outline: calc\(var\(--hairline\) \/ var\(--page-scale, 1\)\) solid var\(--color-ink\)/,
    );
  });

  it('search hits multiply Mist over the page', () => {
    expect(css).toMatch(
      /\[data-search-hit\]\s*\{[^}]*background: var\(--color-doc-hit\);[^}]*mix-blend-mode: multiply;/,
    );
  });
});

describe('widths and the left panel (DESIGN 1.3)', () => {
  const widths: Record<string, string> = {
    '--field-width': '56px',
    '--slider-min': '120px',
    '--popover-min': '200px',
    '--popover-max': '320px',
    '--tooltip-max': '240px',
    '--panel-min': '200px',
    '--panel-default': '200px',
    '--panel-max': '320px',
    '--panel-collapse-below': '144px',
    '--splitter-width': '8px',
    '--outline-indent': '16px',
    '--outline-indent-max': '64px',
    '--tab-min': '96px',
    '--tab-max': '200px',
    '--dialog-width': '400px',
    '--toast-height': '40px',
    '--toast-min': '240px',
    '--toast-max': '400px',
    '--topbar-height': '56px',
    '--menubar-height': '32px',
    '--mode-row-height': '40px',
    '--tool-row-height': '48px',
    '--minibar-height': '40px',
    '--canvas-min': '360px',
    '--empty-max-width': '560px',
    '--scrim-height': '24px',
    '--scrim-solid': '8px',
  };

  it.each(Object.entries(widths))('%s is %s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });

  it('Tailwind reaches them by name', () => {
    const mapped = {
      field: '--field-width',
      'slider-min': '--slider-min',
      'popover-min': '--popover-min',
      'popover-max': '--popover-max',
      'tooltip-max': '--tooltip-max',
      splitter: '--splitter-width',
      'tab-min': '--tab-min',
      'tab-max': '--tab-max',
      dialog: '--dialog-width',
      toast: '--toast-height',
      'toast-min': '--toast-min',
      'toast-max': '--toast-max',
      topbar: '--topbar-height',
      menubar: '--menubar-height',
      'mode-row': '--mode-row-height',
      'tool-row': '--tool-row-height',
      minibar: '--minibar-height',
      'canvas-min': '--canvas-min',
      'empty-max': '--empty-max-width',
      scrim: '--scrim-height',
    };
    for (const [name, tokenName] of Object.entries(mapped)) {
      expect(themeStatic.get(`--spacing-${name}`), name).toBe(`var(${tokenName})`);
    }
  });

  it('PANEL and LAYOUT, the numbers JavaScript calculates with, match the tokens', () => {
    expect(`${PANEL.min}px`).toBe(root.get('--panel-min'));
    expect(`${PANEL.default}px`).toBe(root.get('--panel-default'));
    expect(`${PANEL.max}px`).toBe(root.get('--panel-max'));
    expect(`${PANEL.collapseBelow}px`).toBe(root.get('--panel-collapse-below'));
    // The arrow keys move by a spacing step (8) and Shift by five of them (40).
    expect(`${PANEL.step}px`).toBe(root.get('--space-2'));
    expect(`${PANEL.largeStep}px`).toBe(root.get('--space-10'));
    expect(`${PANEL.step}px`).toBe(root.get('--splitter-width'));
    expect(`${LAYOUT.splitter}px`).toBe(root.get('--splitter-width'));
    expect(`${LAYOUT.canvasMin}px`).toBe(root.get('--canvas-min'));
    expect(`${LAYOUT.menubar}px`).toBe(root.get('--menubar-height'));
    expect(`${LAYOUT.modeRow}px`).toBe(root.get('--mode-row-height'));
    expect(`${LAYOUT.toolRow}px`).toBe(root.get('--tool-row-height'));
    expect(`${LAYOUT.minibar}px`).toBe(root.get('--minibar-height'));
    expect(`${LAYOUT.topbar}px`).toBe(root.get('--topbar-height'));
  });

  it('the panel range is ordered: collapse threshold below the minimum, minimum not above the default, default below the maximum', () => {
    expect(PANEL.collapseBelow).toBeLessThan(PANEL.min);
    expect(PANEL.min).toBeLessThanOrEqual(PANEL.default);
    expect(PANEL.default).toBeLessThan(PANEL.max);
  });

  it('the scroll-edge scrim fades from the page-area color to transparent over the scrim height', () => {
    expect(parseInt(root.get('--scrim-height') ?? '', 10) - parseInt(root.get('--scrim-solid') ?? '', 10)).toBe(16);
    const scrim = blockBody('@utility canvas-scrim');
    expect(scrim).toContain('height: var(--scrim-height);');
    expect(norm(scrim)).toContain('linear-gradient(to bottom,var(--color-page-area) var(--scrim-solid),transparent)');
  });

  it('the glyph on the Windows close button is white, and system HighlightText in forced colors', () => {
    expect(themeStatic.get('--color-on-close')).toBe('var(--color-white)');
    expect(css).toMatch(/--color-on-close: HighlightText;/);
  });

  it('the removed layout tokens only exist in the legacy block, which names the release that drops it', () => {
    for (const name of ['--tabs-row-height', '--hub-card-height']) {
      expect(token(name), name).toBeUndefined();
      expect(legacy.has(name), name).toBe(true);
    }
    expect(legacy.get('--toolbar-row-height')).toBe('var(--topbar-height)');
    expect(legacyStart).toBeGreaterThan(-1);
  });
});

describe('type (DESIGN 1.3, 1.5)', () => {
  it('font stacks: Inter first, no @font-face yet', () => {
    const stack = norm('"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif');
    expect(themeStatic.get('--font-sans')).toBe(stack);
    expect(themeStatic.get('--font-display')).toBe(stack);
    expect(css).not.toContain('@font-face');
  });

  it('weights are 400, 500 and 600', () => {
    expect(themeStatic.get('--font-weight-normal')).toBe('400');
    expect(themeStatic.get('--font-weight-medium')).toBe('500');
    expect(themeStatic.get('--font-weight-semibold')).toBe('600');
    expect([...themeStatic.keys()].filter((name) => name.startsWith('--font-weight-'))).toHaveLength(3);
  });

  // size / line height, weight, tracking
  const steps: Record<string, [string, string, string | undefined, string | undefined]> = {
    xs: ['12px', '16px', undefined, undefined],
    sm: ['12px', '16px', undefined, undefined],
    md: ['14px', '20px', undefined, undefined],
    lg: ['16px', '24px', '500', undefined],
    xl: ['20px', '28px', '500', '-0.01em'],
    '2xl': ['32px', '36px', '400', '-0.025em'],
  };

  it.each(Object.entries(steps))('--text-%s', (name, [size, lineHeight, weight, tracking]) => {
    expect(themeStatic.get(`--text-${name}`)).toBe(size);
    expect(themeStatic.get(`--text-${name}--line-height`)).toBe(lineHeight);
    expect(themeStatic.get(`--text-${name}--font-weight`)).toBe(weight);
    expect(themeStatic.get(`--text-${name}--letter-spacing`)).toBe(tracking);
  });

  it('body text is --text-md with tabular numbers and the Inter feature settings', () => {
    const base = css.slice(css.indexOf('@layer base'));
    expect(base).toMatch(/font-size: var\(--text-md\);/);
    expect(base).toMatch(/font-variant-numeric: tabular-nums;/);
    expect(norm(base)).toContain('font-feature-settings: "cv11","ss01";');
    expect(base).toMatch(/background: var\(--surface-canvas\);/);
  });
});

describe('motion (DESIGN 1.2, MOTION 1)', () => {
  it('three durations, exits 40 ms shorter, one curve', () => {
    expect(root.get('--motion-fast')).toBe('120ms');
    expect(root.get('--motion-base')).toBe('160ms');
    expect(root.get('--motion-slow')).toBe('180ms');
    expect(root.get('--motion-fast-exit')).toBe('80ms');
    expect(root.get('--motion-base-exit')).toBe('120ms');
    expect(root.get('--motion-slow-exit')).toBe('140ms');
    expect(themeStatic.get('--ease-out')).toBe('cubic-bezier(0.2,0,0,1)');
    for (const name of ['--ease-spring', '--ease-float', '--ease-in']) expect(css, name).not.toContain(name);
    expect(css).not.toMatch(/linear\(0,/);
  });

  it('the named exceptions and holds (MOTION 1.3), and no other duration token', () => {
    const exceptions: Record<string, string> = {
      '--motion-check': '240ms',
      '--motion-scroll-max': '300ms',
      '--tooltip-delay': '400ms',
      '--stagger': '20ms',
      '--shimmer': '1200ms',
      '--breathe': '2000ms',
      '--drift': '60s',
      '--splash-max': '1500ms',
      '--hold-check': '600ms',
      '--tooltip-leave': '100ms',
      '--hold-outline': '1000ms',
    };
    for (const [name, value] of Object.entries(exceptions)) expect(root.get(name), name).toBe(value);
    const times = [...root.entries()].filter(([, value]) => /^\d+(ms|s)$/.test(value)).map(([name]) => name);
    const allowed = new Set([
      '--motion-fast',
      '--motion-base',
      '--motion-slow',
      '--motion-fast-exit',
      '--motion-base-exit',
      '--motion-slow-exit',
      ...Object.keys(exceptions),
    ]);
    expect(times.filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('Tailwind transitions default to --motion-fast and --ease-out', () => {
    expect(themeStatic.get('--default-transition-duration')).toBe('var(--motion-fast)');
    expect(themeStatic.get('--default-transition-timing-function')).toBe('var(--ease-out)');
  });

  it('transform amounts: press 0.98, enter 0.98, lift 1.02; thumb, pulse and float scales are gone', () => {
    expect(root.get('--scale-press')).toBe('0.98');
    expect(root.get('--scale-enter')).toBe('0.98');
    expect(root.get('--scale-lift')).toBe('1.02');
    expect(root.get('--offset-enter')).toBe('8px');
    expect(root.get('--pulse-opacity')).toBe('0.6');
    expect(root.get('--drag-card-width')).toBe('160px');
    expect(root.get('--drag-card-height')).toBe('208px');
    for (const name of ['--pulse-scale', '--float-distance', '--float-duration']) expect(css, name).not.toContain(name);
    expect(token('--scale-thumb')).toBeUndefined();
    expect(legacy.get('--scale-thumb')).toBe('1');
  });

  it('the glow-less utilities of v1.1 are gone', () => {
    for (const name of ['logo-float', 'logo-ground', 'surface-canvas'])
      expect(css, name).not.toContain(`@utility ${name}`);
  });

  it('the success pulse is a ring pseudo-layer that fades in fast, then out, without growing', () => {
    const keyframes = blockBody('@keyframes pulse-ring');
    expect(keyframes).toContain('var(--pulse-opacity)');
    expect(keyframes).not.toContain('transform');
    expect(blockBody('@utility pulse-target')).toContain('var(--motion-fast) + var(--motion-slow)');
  });

  it('reduced motion: no transforms, opacity-only transitions at --motion-fast, instant scroll', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('@layer base'));
    const tokens = declarations(block.slice(0, block.indexOf('*,')));
    expect(tokens.get('--scale-press')).toBe('1');
    expect(tokens.get('--scale-enter')).toBe('1');
    expect(tokens.get('--scale-lift')).toBe('1');
    expect(tokens.get('--offset-enter')).toBe('0px');
    expect(block).toMatch(/transition-property: opacity !important;/);
    expect(block).toMatch(/transition-duration: var\(--motion-fast\) !important;/);
    expect(block).toMatch(/transition-timing-function: var\(--ease-out\) !important;/);
    expect(block).toMatch(/\[data-pulse\]::after \{\s*animation: pulse-ring/);
    expect(block).toMatch(/scroll-behavior: auto !important;/);
    expect(block).toMatch(/animation: none !important;/);
  });

  it('reduced motion: the left panel collapse takes its tracks away in one step after the panel has faded, and a restore at once', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const block = css.slice(start, css.indexOf('@layer base'));
    const rule =
      /\[data-layout\]\[data-animating="left"\]\[data-left="collapsed"\]\s*\{([^}]*)\}/.exec(block)?.[1] ?? '';
    expect(rule).toMatch(/transition-property: grid-template-columns !important;/);
    expect(rule).toMatch(/transition-duration: 0s !important;/);
    expect(rule).toMatch(/transition-delay: var\(--motion-fast\) !important;/);
    expect(block).not.toMatch(/data-left="open"/);
  });

  it('scrollbars are thin and token-coloured on a transparent track, with a WebKit fallback; forced colors keeps the native ones (DESIGN 1.11)', () => {
    const start = css.indexOf('@layer base');
    const block = css.slice(
      start,
      css.indexOf('The focus ring', start) === -1 ? undefined : css.indexOf(':focus-visible:not', start),
    );
    expect(block).toMatch(/@media not \(forced-colors: active\)/);
    expect(block).toMatch(/@supports not selector\(::-webkit-scrollbar\)\s*\{\s*\*\s*\{\s*scrollbar-width: thin;/);
    expect(block).toMatch(/::-webkit-scrollbar-button \{\s*display: none;\s*width: 0;\s*height: 0;/);
    expect(block).toMatch(/scrollbar-color: var\(--color-scrollbar\) transparent;/);
    expect(block).toMatch(/::-webkit-scrollbar-thumb \{[^}]*var\(--color-scrollbar\)[^}]*background-clip: padding-box/);
    expect(block).toMatch(/::-webkit-scrollbar-thumb:hover \{[^}]*var\(--color-scrollbar-hover\)/);
    expect(block).toMatch(/::-webkit-scrollbar-track,\s*::-webkit-scrollbar-corner \{\s*background: transparent;/);
    expect(root.get('--scrollbar-size')).toBe('8px');
  });
});

describe('forced colors', () => {
  const start = css.indexOf('@media (forced-colors: active) {\n  :root:root');
  const forced = declarations(css.slice(start, css.indexOf('\n}\n', start)));

  it('use system colors throughout and a Highlight focus', () => {
    expect(start).toBeGreaterThan(-1);
    expect(forced.get('--color-focus')).toBe('highlight');
    expect(forced.get('--color-text')).toBe('canvastext');
    expect(forced.get('--surface-canvas')).toBe('canvas');
    expect(forced.get('--surface-panel')).toBe('canvas');
    expect(forced.get('--color-doc-select')).toBe('highlight');
    expect(forced.get('--color-doc-text-select')).toBe('highlight');
    expect(forced.get('--color-doc-hit')).toBe('highlight');
  });

  it('drop the shadows and the ring, so the transparent focus outline carries the state', () => {
    for (const name of [
      '--shadow-standard',
      '--shadow-floating',
      '--shadow-1',
      '--shadow-2',
      '--shadow-3',
      '--page-shadow',
      '--ring-focus',
    ]) {
      expect(forced.get(name), name).toBe('0 0 transparent');
    }
  });

  it('every token it overrides exists outside it', () => {
    for (const name of forced.keys()) expect(token(name) ?? legacy.get(name), name).toBeDefined();
  });
});

describe('elevation (DESIGN 1.7)', () => {
  const layers: Record<string, string> = {
    base: '0',
    'canvas-page': '1',
    'canvas-text': '2',
    'canvas-annotations': '3',
    'canvas-scrim': '4',
    popover: '100',
    toast: '200',
    modal: '300',
    tooltip: '400',
    drag: '500',
  };

  it.each(Object.entries(layers))('--z-%s is %s and has a utility', (name, value) => {
    expect(root.get(`--z-${name}`)).toBe(value);
    expect(blockBody(`@utility z-${name}`)).toContain(`z-index: var(--z-${name});`);
  });

  it('there are no other z-index tokens', () => {
    expect([...root.keys()].filter((name) => name.startsWith('--z-'))).toHaveLength(Object.keys(layers).length);
  });

  it('the modal backdrop is the scrim, rgba(15,15,15,.12) without blur', () => {
    expect(themeStatic.get('--color-backdrop')).toBe('var(--scrim)');
    expect(root.get('--scrim')).toBe('rgba(15,15,15,0.12)');
  });
});

describe('Tailwind theme', () => {
  it('drops the default theme so only the tokens exist as utilities', () => {
    expect(blockBody('@theme')).toMatch(/--\*: initial;/);
  });

  it('does not scan test files or the dev-only showcase for classes, so none of them can become CSS of the app', () => {
    for (const excluded of ['../**/*.test.ts', '../**/*.test.tsx', '../components/showcase']) {
      expect(css, excluded).toContain(`@source not "${excluded}";`);
    }
  });

  it('no palette name becomes a color utility (primitives live in :root)', () => {
    const colors = [...themeStatic.keys()].filter((name) => name.startsWith('--color-'));
    for (const name of colors) {
      expect(name, name).not.toMatch(
        /--color-(iris|ink|gray|red|blue|green|white|black|yellow|sand|mist|stone|danger|canvas)\b/,
      );
    }
  });

  it('the legacy block is marked, is small, and holds no token that is already defined above it', () => {
    expect(raw).toContain(LEGACY_MARKER);
    expect(legacyStart).toBeLessThan(legacyEnd);
    expect(legacy.size).toBeGreaterThan(0);
    for (const name of legacy.keys()) expect(token(name), `${name} is defined twice`).toBeUndefined();
  });

  it('every var(--name) in tokens.css and in src/ is defined', () => {
    const defined = new Set([...themeStatic.keys(), ...root.keys(), ...legacy.keys()]);
    const used = new Set<string>();
    for (const text of [css, ...sources(SRC).map((file) => readFileSync(file, 'utf8'))]) {
      for (const [, name] of text.matchAll(/var\((--[\w-]+)/g)) if (name !== undefined) used.add(name);
    }
    // Set by the components themselves, per element.
    const local = new Set([
      '--page-scale',
      '--pulse-radius',
      '--form-border',
      '--form-fill',
      '--form-tint',
      '--form-text',
      '--canvas-extra-scroll',
    ]);
    const unknown = [...used].filter(
      (name) => !defined.has(name) && !local.has(name) && !/^--(tw|logo-ground)-/.test(name),
    );
    expect(unknown).toEqual([]);
  });
});

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'tokens.css'
      ? [path]
      : [];
  });
}

describe('the rest of src/ uses tokens only', () => {
  const files = sources(SRC);

  it('finds the sources it is supposed to check', () => {
    expect(files.some((file) => file.endsWith('App.tsx'))).toBe(true);
  });

  it('has no hex colors or color functions outside tokens.css', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text, file).not.toMatch(/\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/);
    }
  });

  it('has no gradients outside tokens.css (DESIGN 5: glows are tokens)', () => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/radial-gradient/);
    }
  });

  it('has no bare arbitrary numbers in class names: zero is --spacing-0, a scale is a token', () => {
    for (const file of files.filter((candidate) => candidate.endsWith('.tsx'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/[a-z]-\[-?[\d.]+\]/);
    }
  });

  it('has no arbitrary pixel or color values in class names', () => {
    for (const file of files.filter((candidate) => candidate.endsWith('.tsx'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/-\[[^\]]*\d(px|rem|em)\b[^\]]*\]/);
      // A share of a parent is a token too (max-w-status-name), not max-w-[40%].
      expect(text, file).not.toMatch(/-\[[^\]]*\d%[^\]]*\]/);
      expect(text, file).not.toMatch(/-\[#/);
    }
  });

  it('uses no class or token that DESIGN 1.3 removed: glass, surface-dialog, dark:, text-accent roles, old spacing names', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /(?<![\w-])(glass-[12]|surface-dialog|surface-canvas|bg-canvas|rounded-xs|ease-spring|text-text-accent)(?![\w-])/,
      );
      expect(text, file).not.toMatch(/(?<![\w-])dark:/);
      expect(text, file).not.toMatch(/--(space|spacing)-(0-5|1-5)\b/);
      expect(text, file).not.toMatch(/(?<![\w-])(gap|p[xytblrse]?|m[xytblrse]?)-(0-5|1-5)(?![\w-])/);
    }
  });
});

describe('rotate handle offset (ADR-105)', () => {
  it('matches ROTATE_OFFSET_PT of the selection geometry', async () => {
    const { ROTATE_OFFSET_PT } = await import('../features/annotations/selection/geometry');
    expect(main).toContain(`--annot-rotate-offset: ${ROTATE_OFFSET_PT}px;`);
  });
});
