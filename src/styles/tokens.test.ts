import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GLASS_MODES, THEME_MODES } from '../api/app';
import { LAYOUT, PANEL } from '../components/tokens';
import { themeAttribute, transparencyAttribute } from '../stores/settings';

/**
 * tokens.css against docs/DESIGN.md section 1, and the "tokens only" rule for the rest of src/.
 * The expected values below are transcribed from the spec tables, so a change on either side fails here.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
/** The file without comments. A comment starts at a line start or after a space, so the glob in `@source not` stays. */
const css = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8').replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1');

/** Lowercase, single spaces, no space after commas: Prettier's spelling of a value does not matter. */
const norm = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').replace(/,\s*/g, ',').trim();

/** The body of the block whose header matches `header` (a regular expression source, anchored at a line start). */
function blockBody(header: string): string {
  const match = new RegExp(`^\\s*${header}\\s*\\{`, 'm').exec(css);
  if (match === null) throw new Error(`no block matching ${header}`);
  let depth = 1;
  let index = match.index + match[0].length;
  const start = index;
  while (depth > 0 && index < css.length) {
    const char = css[index++];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  return css.slice(start, index - 1);
}

/** Custom property declarations of a block body, in order. Nested blocks are not parsed. */
function declarations(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    if (name !== undefined && value !== undefined) result.set(name, norm(value));
  }
  return result;
}

const themeStatic = declarations(blockBody('@theme static'));
const root = declarations(blockBody(':root'));
const darkByOs = declarations(blockBody(':root:not\\(\\[data-theme="light"\\]\\)'));
const darkByChoice = declarations(blockBody(':root\\[data-theme="dark"\\]'));

function light(name: string): string | undefined {
  return themeStatic.get(name) ?? root.get(name);
}

function dark(name: string): string | undefined {
  return darkByChoice.get(name) ?? light(name);
}

describe('palette (DESIGN 1.1)', () => {
  const palette: Record<string, string> = {
    '--iris-50': '#f4f5ff',
    '--iris-100': '#e1e2ff',
    '--iris-200': '#c9caff',
    '--iris-300': '#8e8ef2',
    '--iris-400': '#7b7cf0',
    '--iris-500': '#5b5bd6',
    '--iris-600': '#4a4ac4',
    '--iris-700': '#3a3aab',
    '--ink': '#1c1c2e',
    '--ink-60': '#5f6072',
    '--ink-50': '#7f8094',
    '--ink-40': '#a3a4b8',
    '--ink-30': '#b4b5c4',
    '--success': '#2e9e6b',
    '--warning': '#d98a1f',
    '--error': '#d64b4b',
  };

  it.each(Object.entries(palette))('%s is %s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });
});

describe('color roles (DESIGN 1.2)', () => {
  /** [light, dark]. A dark value equal to the light one is not repeated in the dark blocks. */
  const roles: Record<string, [string, string]> = {
    '--color-bg': ['linear-gradient(135deg,#f4f5ff,#fafaff)', 'linear-gradient(135deg,#0f1020,#15162b)'],
    '--color-canvas': ['#e8e9f6', '#0b0c18'],
    '--color-text': ['var(--ink)', '#ffffff'],
    '--color-text-muted': ['var(--ink-60)', 'var(--ink-40)'],
    '--color-text-accent': ['var(--iris-700)', 'var(--iris-200)'],
    '--color-text-disabled': ['var(--ink-50)', 'var(--ink-60)'],
    '--color-accent': ['var(--iris-500)', 'var(--iris-300)'],
    '--color-accent-hover': ['var(--iris-600)', 'var(--iris-200)'],
    '--color-accent-pressed': ['var(--iris-700)', 'var(--iris-400)'],
    '--color-on-accent': ['#ffffff', 'var(--ink)'],
    '--color-focus': ['var(--iris-500)', 'var(--iris-300)'],
    '--color-control-border': ['var(--ink-50)', 'var(--ink-50)'],
    '--color-control-hover': ['var(--iris-100)', 'rgba(255,255,255,0.08)'],
    '--color-control-pressed': ['var(--iris-200)', 'rgba(255,255,255,0.14)'],
    '--color-selected': ['var(--iris-100)', 'rgba(142,142,242,0.2)'],
    '--color-fill-disabled': ['rgba(28,28,46,0.06)', 'rgba(255,255,255,0.06)'],
    '--color-track': ['var(--iris-200)', 'rgba(255,255,255,0.2)'],
    '--color-divider': ['var(--ink-30)', 'rgba(255,255,255,0.12)'],
    '--color-tile': ['var(--iris-100)', 'rgba(142,142,242,0.16)'],
    '--color-tile-icon': ['var(--iris-700)', 'var(--iris-200)'],
    '--color-tooltip-bg': ['var(--ink)', '#2b2c42'],
    '--color-tooltip-text': ['#ffffff', '#ffffff'],
    '--color-tooltip-key': ['var(--ink-40)', 'var(--ink-40)'],
    '--color-success-icon': ['#2e9e6b', '#2e9e6b'],
    '--color-warning-icon': ['#b5700f', '#d98a1f'],
    '--color-error-icon': ['#d64b4b', '#d64b4b'],
    '--color-success-text': ['#1b7049', '#7fd8aa'],
    '--color-warning-text': ['#8a5a0e', '#f5c26b'],
    '--color-error-text': ['#b03535', '#ff9a9a'],
    '--win-close-hover': ['#c42b1c', '#c42b1c'],
    // Document layer: white pages and iris selection in both themes.
    '--color-page': ['#ffffff', '#ffffff'],
    '--color-doc-select': ['var(--iris-500)', 'var(--iris-500)'],
    '--color-doc-text-select': ['rgba(91,91,214,0.3)', 'rgba(91,91,214,0.3)'],
    '--color-doc-hit': ['rgba(91,91,214,0.28)', 'rgba(91,91,214,0.28)'],
  };

  it.each(Object.entries(roles))('%s', (name, [lightValue, darkValue]) => {
    expect(light(name)).toBe(lightValue);
    expect(dark(name)).toBe(darkValue);
  });

  it('the two dark blocks are identical, so the OS and the override can never disagree', () => {
    expect([...darkByOs]).toEqual([...darkByChoice]);
    expect(darkByChoice.size).toBeGreaterThan(20);
  });

  it('every token a dark block sets already has a light value', () => {
    for (const name of darkByChoice.keys()) {
      expect(light(name), name).toBeDefined();
    }
  });

  it('the dark theme follows the OS unless html[data-theme="light"] is set, and html[data-theme] sets color-scheme', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(declarations(blockBody(':root')).has('--color-bg')).toBe(true);
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{\s*color-scheme: light;/);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
    expect(blockBody(':root')).toMatch(/color-scheme: light dark;/);
  });
});

describe('glass (DESIGN 1.3)', () => {
  const glass: Record<string, [string, string]> = {
    '--surface': ['rgba(255,255,255,0.72)', 'rgba(28,28,46,0.62)'],
    '--surface-strong': ['rgba(255,255,255,0.9)', 'rgba(28,28,46,0.9)'],
    '--surface-solid': ['#ffffff', '#1c1c2e'],
    '--glass-filter': ['blur(24px) saturate(140%)', 'blur(24px) saturate(140%)'],
    '--glass-edge': ['inset 0 0 0 1px rgba(255,255,255,0.6)', 'inset 0 0 0 1px rgba(255,255,255,0.12)'],
    '--shadow-1': [
      '0 1px 2px rgba(28,28,46,0.06),0 8px 32px rgba(28,28,46,0.08)',
      '0 1px 2px rgba(0,0,0,0.24),0 8px 32px rgba(0,0,0,0.32)',
    ],
    '--shadow-2': [
      '0 2px 6px rgba(28,28,46,0.08),0 12px 40px rgba(28,28,46,0.16)',
      '0 2px 6px rgba(0,0,0,0.32),0 12px 40px rgba(0,0,0,0.48)',
    ],
    '--shadow-3': ['0 24px 64px rgba(28,28,46,0.24)', '0 24px 64px rgba(0,0,0,0.56)'],
  };

  it.each(Object.entries(glass))('%s', (name, [lightValue, darkValue]) => {
    expect(light(name)).toBe(lightValue);
    expect(dark(name)).toBe(darkValue);
  });

  it('G1 and G2 are utilities built from the glass tokens: surface, filter, edge, shadow', () => {
    const body1 = blockBody('@utility glass-1');
    expect(body1).toMatch(/background: var\(--surface\);/);
    expect(body1).toMatch(/backdrop-filter: var\(--glass-filter\);/);
    expect(body1).toMatch(/var\(--glass-edge\),\s*var\(--shadow-1\)/);
    const body2 = blockBody('@utility glass-2');
    expect(body2).toMatch(/background: var\(--surface-strong\);/);
    expect(body2).toMatch(/backdrop-filter: var\(--glass-filter\);/);
    expect(body2).toMatch(/var\(--glass-edge\),\s*var\(--shadow-2\)/);
    // Dialogs and submenus: solid + shadow-3.
    expect(blockBody('@utility surface-dialog')).toMatch(/var\(--surface-solid\)[\s\S]*var\(--shadow-3\)/);
  });
});

describe('solid mode (DESIGN 1.1, 1.3)', () => {
  const expected = [
    ['--surface', 'var(--surface-solid)'],
    ['--surface-strong', 'var(--surface-solid)'],
    ['--glass-filter', 'none'],
    ['--glass-edge', 'inset 0 0 0 var(--hairline) var(--color-divider)'],
  ] as const;

  const triggers: Record<string, string> = {
    'no backdrop-filter support':
      '@supports not \\(\\(backdrop-filter: blur\\(1px\\)\\) or \\(-webkit-backdrop-filter: blur\\(1px\\)\\)\\)\\s*\\{\\s*:root:root',
    'prefers-reduced-transparency: reduce': '@media \\(prefers-reduced-transparency: reduce\\)\\s*\\{\\s*:root:root',
    'html[data-transparency="reduced"]': ':root\\[data-transparency="reduced"\\]',
    'forced-colors: active': '@media \\(forced-colors: active\\)\\s*\\{\\s*:root:root',
  };

  it.each(Object.entries(triggers))('%s swaps to the opaque surface, no filter, divider edge', (_name, header) => {
    // Nested headers span two lines (the at-rule, then the selector); the selector's block is what matters.
    const match = new RegExp(`${header}\\s*\\{`).exec(css);
    expect(match, header).not.toBeNull();
    const body = css.slice((match?.index ?? 0) + (match?.[0].length ?? 0)).split('}')[0] ?? '';
    const decls = declarations(body);
    for (const [name, value] of expected) {
      expect(decls.get(name), name).toBe(value);
    }
  });

  it('comes after the dark blocks and outranks them, so it wins in both themes', () => {
    const darkAt = css.indexOf(':root[data-theme="dark"] {');
    for (const header of [
      '@supports not',
      '@media (prefers-reduced-transparency: reduce)',
      ':root[data-transparency="reduced"]',
    ]) {
      expect(css.indexOf(header), header).toBeGreaterThan(darkAt);
    }
    expect(css).not.toMatch(/prefers-reduced-transparency: reduce\)\s*\{\s*:root \{/);
  });

  it('forced colors use system colors and a Highlight focus ring', () => {
    const start = css.indexOf('@media (forced-colors: active) {\n  :root:root');
    const body = declarations(css.slice(start, css.indexOf('\n}\n', start)));
    expect(body.get('--color-focus')).toBe('highlight');
    expect(body.get('--color-text')).toBe('canvastext');
    expect(body.get('--color-bg')).toBe('canvas');
    expect(body.get('--surface-solid')).toBe('canvas');
    // The document layer's translucent iris fills would be replaced or dropped: selection and search hits are Highlight.
    expect(body.get('--color-doc-select')).toBe('highlight');
    expect(body.get('--color-doc-text-select')).toBe('highlight');
    expect(body.get('--color-doc-hit')).toBe('highlight');
    // A glass surface keeps a visible edge when box-shadow is dropped.
    expect(blockBody('@utility glass-1')).toMatch(
      /forced-colors: active[\s\S]*outline: var\(--hairline\) solid transparent/,
    );
  });
});

describe('radii, spacing, sizes (DESIGN 1.4, 1.8)', () => {
  it('radii', () => {
    const radii = { xs: '4px', sm: '8px', button: '12px', panel: '16px', card: '20px', pill: '999px' };
    for (const [name, value] of Object.entries(radii)) {
      expect(themeStatic.get(`--radius-${name}`), name).toBe(value);
    }
  });

  it('spacing is the 8-pt scale and Tailwind maps to it', () => {
    const space = { '0-5': 4, '1': 8, '1-5': 12, '2': 16, '3': 24, '4': 32, '5': 40, '6': 48, '8': 64 };
    for (const [name, px] of Object.entries(space)) {
      expect(root.get(`--space-${name}`), name).toBe(`${px}px`);
      expect(themeStatic.get(`--spacing-${name}`), name).toBe(`var(--space-${name})`);
    }
  });

  it('control and target sizes, hairline, focus ring', () => {
    expect(root.get('--control-sm')).toBe('24px');
    expect(root.get('--control-md')).toBe('32px');
    expect(root.get('--control-lg')).toBe('40px');
    expect(root.get('--target-min')).toBe('24px');
    expect(root.get('--target-default')).toBe('var(--control-md)');
    expect(root.get('--hairline')).toBe('1px');
    expect(root.get('--focus-width')).toBe('2px');
    expect(root.get('--focus-offset')).toBe('2px');
  });

  it('icon sizes and stroke', () => {
    for (const size of [12, 16, 20, 24]) expect(root.get(`--icon-${size}`)).toBe(`${size}px`);
    expect(root.get('--icon-stroke')).toBe('1.5px');
    expect(root.get('--icon-stroke-sm')).toBe('2px');
  });

  it('the focus outline uses the focus tokens', () => {
    expect(css).toMatch(
      /:focus-visible\s*\{\s*outline: var\(--focus-width\) solid var\(--color-focus\);\s*outline-offset: var\(--focus-offset\);/,
    );
  });
});

describe('widths and the left panel (DESIGN 2, 3.3 to 3.8)', () => {
  const widths: Record<string, string> = {
    '--field-width': '56px', // slider number field and zoom readout (3.3, 3.7)
    '--slider-min': '120px', // slider track (3.7)
    '--popover-min': '200px', // 3.5
    '--popover-max': '320px',
    '--tooltip-max': '240px', // 3.4
    '--panel-min': '192px', // left panel range, default and collapse threshold (2, 3.8)
    '--panel-default': '248px',
    '--panel-max': '400px',
    '--panel-collapse-below': '144px',
    '--splitter-width': '8px',
  };

  it.each(Object.entries(widths))('%s is %s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });

  it('Tailwind reaches them as w-field, min-w-slider-min, min-w-popover-min, max-w-popover-max, max-w-tooltip-max, w-splitter', () => {
    const mapped = {
      field: '--field-width',
      'slider-min': '--slider-min',
      'popover-min': '--popover-min',
      'popover-max': '--popover-max',
      'tooltip-max': '--tooltip-max',
      splitter: '--splitter-width',
    };
    for (const [name, token] of Object.entries(mapped)) {
      expect(themeStatic.get(`--spacing-${name}`), name).toBe(`var(${token})`);
    }
  });

  it('zero is a spacing token, so components never write min-w-[0]', () => {
    expect(themeStatic.get('--spacing-0')).toBe('0px');
  });

  it('PANEL, the numbers the splitter calculates with, matches the tokens', () => {
    expect(`${PANEL.min}px`).toBe(root.get('--panel-min'));
    expect(`${PANEL.default}px`).toBe(root.get('--panel-default'));
    expect(`${PANEL.max}px`).toBe(root.get('--panel-max'));
    expect(`${PANEL.collapseBelow}px`).toBe(root.get('--panel-collapse-below'));
    // The arrow keys move by a spacing step (8) and Shift by five of them (40).
    expect(`${PANEL.step}px`).toBe(root.get('--space-1'));
    expect(`${PANEL.largeStep}px`).toBe(root.get('--space-5'));
    expect(`${PANEL.step}px`).toBe(root.get('--splitter-width'));
  });

  it('the panel range is ordered: collapse threshold, minimum, default, maximum', () => {
    expect(PANEL.collapseBelow).toBeLessThan(PANEL.min);
    expect(PANEL.min).toBeLessThan(PANEL.default);
    expect(PANEL.default).toBeLessThan(PANEL.max);
  });
});

describe('layout slots (DESIGN 2, 2.2, 3.11)', () => {
  const slots: Record<string, string> = {
    '--caption-height': '32px', // Windows caption row
    '--toolbar-row-height': '56px', // toolbar 40 + 8 above and below
    '--banner-min-height': '48px',
    '--status-height': '32px',
    '--status-name-max': '40%', // the file name's share of the status bar (3.10)
    '--caption-button-width': '46px',
    '--chrome-inset-mac': '80px', // traffic lights
    '--inspector-width': '288px',
    '--canvas-min': '360px',
    '--empty-max-width': '560px',
    '--scrim-height': '24px', // scroll-edge scrim: 8 solid + 16 fade
    '--scrim-solid': '8px',
  };

  it.each(Object.entries(slots))('%s is %s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });

  it('Tailwind reaches them as h-caption, h-toolbar-row, min-h-banner-min, h-status, max-w-status-name, w-caption-button, ps-chrome-inset, w-inspector, min-w-canvas-min, max-w-empty-max, h-scrim', () => {
    const mapped = {
      caption: '--caption-height',
      'toolbar-row': '--toolbar-row-height',
      'banner-min': '--banner-min-height',
      status: '--status-height',
      'status-name': '--status-name-max',
      'caption-button': '--caption-button-width',
      'chrome-inset': '--chrome-inset-mac',
      inspector: '--inspector-width',
      'canvas-min': '--canvas-min',
      'empty-max': '--empty-max-width',
      scrim: '--scrim-height',
    };
    for (const [name, token] of Object.entries(mapped)) {
      expect(themeStatic.get(`--spacing-${name}`), name).toBe(`var(${token})`);
    }
  });

  it('the toolbar row is the toolbar plus 8 above and below, and the scrim is 8 solid plus 16 fade', () => {
    expect(root.get('--toolbar-row-height')).toBe(`${40 + 2 * 8}px`);
    expect(parseInt(root.get('--scrim-height') ?? '', 10) - parseInt(root.get('--scrim-solid') ?? '', 10)).toBe(16);
  });

  it('the scroll-edge scrim fades from the solid canvas color to transparent over the scrim height', () => {
    const scrim = blockBody('@utility canvas-scrim');
    expect(scrim).toContain('height: var(--scrim-height);');
    expect(scrim).toContain('linear-gradient(to bottom, var(--color-canvas) var(--scrim-solid), transparent)');
  });

  it('the glyph on the Windows close button is white, and system HighlightText in forced colors', () => {
    expect(themeStatic.get('--color-on-close')).toBe('#ffffff');
    expect(css).toMatch(/--color-on-close: HighlightText;/);
  });

  it('LAYOUT, the numbers the collapse rules calculate with, matches the tokens', () => {
    expect(`${LAYOUT.gutter}px`).toBe(root.get('--space-1'));
    expect(`${LAYOUT.splitter}px`).toBe(root.get('--splitter-width'));
    expect(`${LAYOUT.canvasMin}px`).toBe(root.get('--canvas-min'));
    expect(`${LAYOUT.inspector}px`).toBe(root.get('--inspector-width'));
  });
});

describe('type (DESIGN 1.5)', () => {
  it('font stacks', () => {
    expect(themeStatic.get('--font-sans')).toBe(
      norm('-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'),
    );
    expect(themeStatic.get('--font-display')).toContain('"segoe ui variable display"');
  });

  it('weights are 400 and 600 only', () => {
    expect(themeStatic.get('--font-weight-normal')).toBe('400');
    expect(themeStatic.get('--font-weight-semibold')).toBe('600');
    expect([...themeStatic.keys()].filter((name) => name.startsWith('--font-weight-'))).toHaveLength(2);
  });

  // size / line height, weight, tracking
  const steps: Record<string, [string, string, string | undefined, string | undefined]> = {
    xs: ['11px', '16px', '600', undefined],
    sm: ['12px', '16px', undefined, undefined],
    md: ['14px', '20px', undefined, undefined],
    lg: ['16px', '24px', '600', undefined],
    xl: ['20px', '28px', '600', '-0.01em'],
    '2xl': ['28px', '36px', '600', '-0.01em'],
  };

  it.each(Object.entries(steps))('--text-%s', (name, [size, lineHeight, weight, tracking]) => {
    expect(themeStatic.get(`--text-${name}`)).toBe(size);
    expect(themeStatic.get(`--text-${name}--line-height`)).toBe(lineHeight);
    expect(themeStatic.get(`--text-${name}--font-weight`)).toBe(weight);
    expect(themeStatic.get(`--text-${name}--letter-spacing`)).toBe(tracking);
  });

  it('body text is --text-md with tabular numbers', () => {
    const base = css.slice(css.indexOf('@layer base'));
    expect(base).toMatch(/font-size: var\(--text-md\);/);
    expect(base).toMatch(/font-variant-numeric: tabular-nums;/);
  });
});

describe('motion (DESIGN 1.6)', () => {
  it('durations and easings', () => {
    expect(root.get('--motion-fast')).toBe('150ms');
    expect(root.get('--motion-base')).toBe('200ms');
    expect(root.get('--motion-slow')).toBe('250ms');
    expect(themeStatic.get('--ease-out')).toBe('cubic-bezier(0.22,1,0.36,1)');
    expect(themeStatic.get('--ease-in')).toBe('cubic-bezier(0.4,0,1,1)');
    expect(themeStatic.get('--ease-spring')).toBe('cubic-bezier(0.34,1.56,0.64,1)');
  });

  it('Tailwind transitions default to --motion-fast and --ease-out', () => {
    expect(themeStatic.get('--default-transition-duration')).toBe('var(--motion-fast)');
    expect(themeStatic.get('--default-transition-timing-function')).toBe('var(--ease-out)');
  });

  it('reduced motion: no transforms, opacity-only 150 ms ease-out transitions, instant scroll', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('@layer base'));
    const tokens = declarations(block.slice(0, block.indexOf('*,')));
    expect(tokens.get('--scale-press')).toBe('1');
    expect(tokens.get('--scale-enter')).toBe('1');
    expect(tokens.get('--scale-thumb')).toBe('1');
    expect(tokens.get('--offset-enter')).toBe('0px');
    expect(block).toMatch(/transition-property: opacity !important;/);
    expect(block).toMatch(/transition-duration: var\(--motion-fast\) !important;/);
    expect(block).toMatch(/transition-timing-function: var\(--ease-out\) !important;/);
    expect(block).toMatch(/scroll-behavior: auto !important;/);
    expect(block).toMatch(/animation: none !important;/);
  });

  it('reduced motion: the left panel collapse takes its tracks away in one step after the panel has faded, and a restore at once', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const block = css.slice(start, css.indexOf('@layer base'));
    // The rule applies while the grid animates and has been collapsed: a transition of no duration that starts when the 150 ms
    // fade of the panel is over. A grid that was restored matches nothing here, so the global rule leaves it no transition
    // of its columns: they change at once and the panel fades in on them.
    const rule = /\[data-layout\]\[data-animating\]\[data-left="collapsed"\]\s*\{([^}]*)\}/.exec(block)?.[1] ?? '';
    expect(rule).toMatch(/transition-property: grid-template-columns !important;/);
    expect(rule).toMatch(/transition-duration: 0s !important;/);
    expect(rule).toMatch(/transition-delay: var\(--motion-fast\) !important;/);
    expect(block).not.toMatch(/data-left="open"/);
  });

  it('outside reduced motion the transform amounts are the spec ones', () => {
    expect(root.get('--scale-press')).toBe('0.97');
    expect(root.get('--scale-enter')).toBe('0.96');
    expect(root.get('--scale-thumb')).toBe('1.125');
    expect(root.get('--offset-enter')).toBe('8px');
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

  it('the modal backdrop is rgba(15,16,32,.32)', () => {
    expect(themeStatic.get('--color-backdrop')).toBe('rgba(15,16,32,0.32)');
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

  it('every namespaced token that Tailwind turns into a utility is a spec token', () => {
    const colors = [...themeStatic.keys()].filter((name) => name.startsWith('--color-'));
    // Colors are roles (DESIGN 1.2), glass surfaces as colors, the modal backdrop and the document layer. No palette.
    for (const name of colors) {
      expect(name, name).not.toMatch(/--color-(iris|ink|gray|red|blue|green|white|black)/);
    }
  });
});

describe('the rest of src/ uses tokens only', () => {
  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && entry.name !== 'tokens.css'
        ? [path]
        : [];
    });
  }

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
});
describe('the spec tables themselves (docs/DESIGN.md 1.2, 1.3)', () => {
  const design = readFileSync(join(SRC, '..', 'docs', 'DESIGN.md'), 'utf8').replace(/\r\n/g, '\n');

  interface Row {
    tokens: string[];
    light: string;
    dark: string;
  }

  const isDefined = (name: string): boolean => themeStatic.has(name) || root.has(name);

  /** `--color-accent / -hover / -pressed`, `--color-tile / -tile-icon`, `--shadow-1 / -2 / -3` and `{a,b,c}` lists. */
  function expandTokens(cell: string): string[] {
    const names: string[] = [];
    let base = '';
    for (const [, span = ''] of cell.matchAll(/`([^`]+)`/g)) {
      const braces = /^(.*)\{([^}]+)\}(.*)$/.exec(span);
      const spans = braces === null ? [span] : (braces[2] ?? '').split(',').map((v) => `${braces[1]}${v}${braces[3]}`);
      for (const expanded of spans) {
        for (const part of expanded.split(' / ')) {
          if (part.startsWith('--')) {
            names.push(part);
            base = part;
            continue;
          }
          // A suffix of the last full token: appended (-hover) or replacing its last word (-tile-icon, -2).
          const appended = `${base}${part}`;
          const replaced = `${base.slice(0, base.lastIndexOf('-'))}${part}`;
          names.push(isDefined(appended) || !isDefined(replaced) ? appended : replaced);
        }
      }
    }
    return names;
  }

  function rows(from: string, to: string): Row[] {
    const start = design.indexOf(from);
    const end = design.indexOf(to, start);
    if (start === -1 || end === -1) throw new Error(`DESIGN.md has no section ${from}`);
    return design
      .slice(start, end)
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
      .slice(1) // the header row
      .map((line) => {
        const [role = '', lightCell = '', darkCell = ''] = line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim());
        return { tokens: expandTokens(role), light: lightCell, dark: darkCell };
      });
  }

  const roleRows = rows('### 1.2 Color roles', '### 1.3 Glass');
  const glassRows = rows('### 1.3 Glass', '### 1.4');

  it('finds the tables it is supposed to check', () => {
    expect(roleRows.length).toBeGreaterThanOrEqual(20);
    expect(glassRows.length).toBeGreaterThanOrEqual(5);
    const listed = roleRows.flatMap((row) => row.tokens);
    for (const name of [
      '--color-bg',
      '--color-accent-pressed',
      '--color-tile-icon',
      '--color-warning-text',
      '--win-close-hover',
    ]) {
      expect(listed, name).toContain(name);
    }
  });

  it('tokens.css defines every role and glass token the spec lists', () => {
    const missing = [...roleRows, ...glassRows].flatMap((row) => row.tokens).filter((name) => !isDefined(name));
    expect(missing).toEqual([]);
  });

  it('every role whose light and dark columns differ is overridden in both dark blocks', () => {
    const differing = [...roleRows, ...glassRows].filter((row) => row.light !== row.dark);
    expect(differing.length).toBeGreaterThan(10);
    for (const row of differing) {
      for (const [label, block] of [
        ['OS dark', darkByOs],
        ['data-theme=dark', darkByChoice],
      ] as const) {
        expect(
          row.tokens.some((name) => block.has(name)),
          `${row.tokens.join(', ')} is not overridden for ${label}`,
        ).toBe(true);
      }
    }
  });
});

describe('solid mode overrides are the same in every trigger (DESIGN 1.1)', () => {
  /** The declarations of the first rule after `header` (the selector's block, also for a nested at-rule). */
  function bodyAfter(header: string): Map<string, string> {
    const match = new RegExp(`${header}\\s*\\{`).exec(css);
    if (match === null) throw new Error(`no block matching ${header}`);
    return declarations(css.slice(match.index + match[0].length).split('}')[0] ?? '');
  }

  const supports = bodyAfter(
    '@supports not \\(\\(backdrop-filter: blur\\(1px\\)\\) or \\(-webkit-backdrop-filter: blur\\(1px\\)\\)\\)\\s*\\{\\s*:root:root',
  );
  const media = bodyAfter('@media \\(prefers-reduced-transparency: reduce\\)\\s*\\{\\s*:root:root');
  const attribute = bodyAfter(':root\\[data-transparency="reduced"\\]');

  it('the two media triggers and the attribute set the same four tokens to the same values', () => {
    expect([...attribute.keys()].sort()).toEqual(['--glass-edge', '--glass-filter', '--surface', '--surface-strong']);
    expect([...supports]).toEqual([...attribute]);
    expect([...media]).toEqual([...attribute]);
  });

  it('forced colors keep the same four overrides and add system colors', () => {
    const start = css.indexOf('@media (forced-colors: active) {\n  :root:root');
    const forced = declarations(css.slice(start, css.indexOf('\n}\n', start)));
    for (const [name, value] of attribute) expect(forced.get(name), name).toBe(value);
    expect(forced.size).toBeGreaterThan(attribute.size);
  });

  it('the three non-forced triggers touch surfaces only, no color role', () => {
    for (const body of [supports, media, attribute]) {
      expect([...body.keys()].filter((name) => name.startsWith('--color-'))).toEqual([]);
    }
  });
});

describe('contract with the settings store', () => {
  it('every html[data-theme] value the store can write has a matching theme block', () => {
    const written = new Set(THEME_MODES.map((theme) => themeAttribute({ theme })).filter((value) => value !== null));
    expect([...written].sort()).toEqual(['dark', 'light']);
    for (const value of written) {
      expect(css, value ?? '').toContain(`:root[data-theme="${value}"]`);
    }
    // "system" removes the attribute, so the OS block must not require one.
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\)/);
  });

  it('the one html[data-transparency] value the store can write has a solid-mode block', () => {
    const written = new Set<string>();
    for (const glass of GLASS_MODES) {
      for (const osReducedTransparency of [false, true]) {
        const value = transparencyAttribute({ glass, osReducedTransparency });
        if (value !== null) written.add(value);
      }
    }
    expect([...written]).toEqual(['reduced']);
    expect(css).toContain(':root[data-transparency="reduced"]');
  });

  it('tokens.css reacts to no other data-theme or data-transparency value', () => {
    const themes = new Set([...css.matchAll(/\[data-theme="([^"]*)"\]/g)].map((match) => match[1]));
    expect([...themes].sort()).toEqual(['dark', 'light']);
    const transparencies = new Set([...css.matchAll(/\[data-transparency="([^"]*)"\]/g)].map((match) => match[1]));
    expect([...transparencies]).toEqual(['reduced']);
  });
});
