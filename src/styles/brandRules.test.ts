import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The sheer. brand hard rules (docs/REDESIGN_BRIEF.md section 4, ADR-100) as a gate over src/ (tests excluded).
 * Colors and gradients outside tokens.css are also checked by tokens.test.ts. Every rule has a self-test below that proves it
 * catches a violation, so a loosened regex fails here.
 */

type Kind = 'css' | 'ts';
interface Rule {
  name: string;
  /** Which files the rule reads. */
  applies: (kind: Kind, file: string) => boolean;
  /** Returns the offending snippets of a comment-free source. */
  find: (text: string, kind: Kind) => string[];
}

const anywhere = (): boolean => true;
const notTokens = (_kind: Kind, file: string): boolean => file !== 'styles/tokens.css';
const cssOnly = (kind: Kind, file: string): boolean => kind === 'css' && file !== 'styles/tokens.css';
const tsNotMotion = (kind: Kind, file: string): boolean => kind === 'ts' && file !== 'lib/motion.ts';

const grep =
  (pattern: RegExp) =>
  (text: string): string[] =>
    [
      ...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)),
    ].map((match) => match[0]);

/** Every `box-shadow` that is not a sanctioned token, and every shadow utility that is not one. */
const SHADOW_OK = /^(var\(--(shadow-standard|shadow-floating|ring-focus)\)|none|inherit|initial|unset)$/;
const badShadows = (text: string): string[] => [
  ...[...text.matchAll(/box-shadow\s*:\s*([^;}]+)/g)]
    .filter((match) => !SHADOW_OK.test((match[1] ?? '').trim()))
    .map((match) => match[0]),
  ...grep(/\bboxShadow\s*:\s*['"`]/)(text),
  ...grep(/(?<![\w-])shadow-\[[^\]]*\]/)(text),
  ...[...text.matchAll(/(?<![\w-])(?:shadow|inset-shadow|drop-shadow)-([a-z0-9-]+)/g)]
    .filter((match) => !['standard', 'floating', 'none'].includes(match[1] ?? ''))
    .map((match) => match[0]),
];

/** `border-radius: <literal>`: only var(), 0, inherit. */
const RADIUS_OK = /^(var\(--[\w-]+\)|0|0px|inherit|initial|unset)$/;
const badRadii = (text: string, kind: Kind): string[] => [
  ...[...text.matchAll(/border-(?:[a-z]+-){0,2}radius\s*:\s*([^;}]+)/g)]
    .filter(
      (match) =>
        !(match[1] ?? '')
          .trim()
          .split(/\s+/)
          .every((part) => RADIUS_OK.test(part)),
    )
    .map((match) => match[0]),
  ...(kind === 'ts' ? grep(/\bborder(?:[A-Z][a-z]+){0,2}Radius\s*:\s*['"`\d]/)(text) : []),
  ...grep(/(?<![\w-])rounded(?:-[a-z]+)?-\[[^\]]*\]/)(text),
];

const isHeavy = (value: string): boolean =>
  /^(bold|bolder)$/.test(value) || (/^\d+$/.test(value) && Number(value) > 600);
const badWeights = (text: string, kind: Kind): string[] => {
  // @font-face declares the weight range of the file (100 900); that is not a use.
  const body = text.replace(/@font-face\s*\{[^}]*\}/g, '');
  const found = [...body.matchAll(/font-weight\s*:\s*([^;}]+)/g)]
    .filter((match) => isHeavy((match[1] ?? '').trim()))
    .map((match) => match[0]);
  if (kind === 'ts') {
    found.push(
      ...[...body.matchAll(/\bfontWeight\s*:\s*['"]?(\w+)/g)]
        .filter((match) => isHeavy(match[1] ?? ''))
        .map((match) => match[0]),
    );
  }
  found.push(...grep(/(?<![\w-])font-(?:bold|extrabold|black|\[[^\]]*\])(?![\w-])/)(body));
  return found;
};

export const RULES: Rule[] = [
  { name: 'no backdrop-filter (no glass)', applies: anywhere, find: grep(/backdrop-(?:filter|blur)|backdropFilter/) },
  { name: 'no prefers-color-scheme (light only)', applies: anywhere, find: grep(/prefers-color-scheme/) },
  { name: 'no dark: classes or data-theme', applies: anywhere, find: grep(/(?<![\w-])dark:|data-theme/) },
  { name: 'no radial-gradient outside tokens.css', applies: notTokens, find: grep(/radial-gradient/) },
  { name: 'box-shadow only the shadow and ring tokens', applies: anywhere, find: badShadows },
  { name: 'no literal border-radius', applies: notTokens, find: badRadii },
  {
    name: 'no literal duration in CSS outside tokens.css',
    applies: cssOnly,
    find: (text) =>
      [...text.matchAll(/(?:transition|animation)[\w-]*\s*:\s*([^;}]+)/g)]
        .filter((match) => /(?<![\w.-])(?:\d*\.\d+|[1-9]\d*)m?s\b/.test(match[1] ?? ''))
        .map((match) => match[0]),
  },
  {
    name: 'no numeric duration or delay in TS outside lib/motion.ts',
    applies: tsNotMotion,
    find: grep(/\b(?:duration|delay|transitionDuration|transitionDelay)\s*[:=]\s*\{?\s*['"`]?\d/),
  },
  { name: 'no font-weight above 600', applies: anywhere, find: badWeights },
];

const SRC = fileURLToPath(new URL('..', import.meta.url));

const strip = (text: string, kind: Kind): string => {
  const block = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return kind === 'ts' ? block.replace(/(^|[^:])\/\/.*$/gm, '$1') : block;
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Temporary exceptions of packages still being rebuilt, as `rule name|file` (path below src/, forward slashes).
 * Each names its owner; remove the entry when the owner lands.
 */
const ALLOWLIST = new Set<string>([]);

describe('brand hard rules over src/', () => {
  const files = sources(SRC).map((path) => ({
    path,
    file: relative(SRC, path).split(sep).join('/'),
    kind: (path.endsWith('.css') ? 'css' : 'ts') as Kind,
  }));

  it('finds the sources it is supposed to check', () => {
    expect(files.some((entry) => entry.file === 'App.tsx')).toBe(true);
    expect(files.some((entry) => entry.file === 'styles/tokens.css')).toBe(true);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      const violations: string[] = [];
      for (const { path, file, kind } of files) {
        if (!rule.applies(kind, file) || ALLOWLIST.has(`${rule.name}|${file}`)) continue;
        for (const hit of rule.find(strip(readFileSync(path, 'utf8'), kind), kind))
          violations.push(`${file}: ${hit.trim()}`);
      }
      expect(violations).toEqual([]);
    });
  }
});

describe('every rule catches a violation and accepts the sanctioned form', () => {
  const rule = (name: string): Rule => {
    const found = RULES.find((candidate) => candidate.name.includes(name));
    if (found === undefined) throw new Error(name);
    return found;
  };
  const hits = (name: string, text: string, kind: Kind = 'css'): number => rule(name).find(text, kind).length;

  it('backdrop-filter', () => {
    expect(hits('backdrop-filter', '.a { backdrop-filter: blur(4px); }')).toBe(1);
    expect(hits('backdrop-filter', 'className="backdrop-blur-md"', 'ts')).toBe(1);
    expect(hits('backdrop-filter', '.a { filter: none; }')).toBe(0);
  });

  it('prefers-color-scheme', () => {
    expect(hits('prefers-color-scheme', '@media (prefers-color-scheme: dark) {}')).toBe(1);
    expect(hits('prefers-color-scheme', '@media (prefers-reduced-motion: reduce) {}')).toBe(0);
  });

  it('dark: and data-theme', () => {
    expect(hits('dark:', 'className="bg-panel dark:bg-app"', 'ts')).toBe(1);
    expect(hits('dark:', '[data-theme="dark"] {}')).toBe(1);
    expect(hits('dark:', 'className="bg-panel"', 'ts')).toBe(0);
  });

  it('radial-gradient', () => {
    expect(hits('radial-gradient', '.a { background: radial-gradient(red, blue); }')).toBe(1);
    expect(hits('radial-gradient', '.a { background: var(--glow-hero); }')).toBe(0);
  });

  it('box-shadow', () => {
    expect(hits('box-shadow', '.a { box-shadow: 0 1px 2px black; }')).toBe(1);
    expect(hits('box-shadow', "style={{ boxShadow: '0 0 4px black' }}", 'ts')).toBe(1);
    expect(hits('box-shadow', 'className="shadow-[0_1px_2px_black]"', 'ts')).toBe(1);
    expect(hits('box-shadow', 'className="shadow-md"', 'ts')).toBe(1);
    expect(hits('box-shadow', '.a { box-shadow: var(--shadow-floating); }')).toBe(0);
    expect(hits('box-shadow', '.a { box-shadow: var(--ring-focus); }')).toBe(0);
    expect(hits('box-shadow', 'className="shadow-standard shadow-floating"', 'ts')).toBe(0);
  });

  it('border-radius', () => {
    expect(hits('border-radius', '.a { border-radius: 8px; }')).toBe(1);
    expect(hits('border-radius', '.a { border-top-left-radius: 50%; }')).toBe(1);
    expect(hits('border-radius', "style={{ borderRadius: '4px' }}", 'ts')).toBe(1);
    expect(hits('border-radius', 'className="rounded-[3px]"', 'ts')).toBe(1);
    expect(hits('border-radius', '.a { border-radius: var(--radius-md); }')).toBe(0);
    expect(hits('border-radius', 'className="rounded-md"', 'ts')).toBe(0);
  });

  it('literal duration in CSS', () => {
    expect(hits('duration in CSS', '.a { transition: opacity 120ms ease; }')).toBe(1);
    expect(hits('duration in CSS', '.a { animation: x 0.3s linear; }')).toBe(1);
    expect(hits('duration in CSS', '.a { transition-delay: 1s; }')).toBe(1);
    expect(hits('duration in CSS', '.a { transition: opacity var(--motion-fast) var(--ease-out); }')).toBe(0);
    expect(hits('duration in CSS', '.a { transition-duration: 0s; }')).toBe(0);
  });

  it('numeric duration in TS', () => {
    expect(hits('duration or delay in TS', 'animate(x, { duration: 0.2 })', 'ts')).toBe(1);
    expect(hits('duration or delay in TS', '<M transition={{ delay: 1 }} />', 'ts')).toBe(1);
    expect(hits('duration or delay in TS', '<M duration={0.3} />', 'ts')).toBe(1);
    expect(hits('duration or delay in TS', 'animate(x, { duration: DURATION.fast })', 'ts')).toBe(0);
    expect(rule('duration or delay in TS').applies('ts', 'lib/motion.ts')).toBe(false);
  });

  it('font-weight above 600', () => {
    expect(hits('font-weight', '.a { font-weight: 700; }')).toBe(1);
    expect(hits('font-weight', '.a { font-weight: bold; }')).toBe(1);
    expect(hits('font-weight', 'className="font-bold"', 'ts')).toBe(1);
    expect(hits('font-weight', 'className="font-[800]"', 'ts')).toBe(1);
    expect(hits('font-weight', 'style={{ fontWeight: 700 }}', 'ts')).toBe(1);
    expect(hits('font-weight', '.a { font-weight: 600; }')).toBe(0);
    expect(hits('font-weight', '@font-face { font-weight: 100 900; }')).toBe(0);
    expect(hits('font-weight', 'className="font-semibold font-medium"', 'ts')).toBe(0);
  });
});
