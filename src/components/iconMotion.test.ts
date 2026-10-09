// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import * as Lucide from 'lucide-react';
import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOGUE,
  DOT_PX,
  EASE_DRAW,
  FAMILY_FACTOR,
  MOTION_ICON_MS,
  STROKE_PX,
  TRACE,
  motionFor,
  playMotion,
  type Family,
} from './iconMotion';

// jsdom gives import.meta.url no file scheme; vitest runs from the repo root.
const SRC = join(process.cwd(), 'src');
const GEOMETRY = 'path, line, circle, rect, polyline, polygon, ellipse';

/** The Lucide components a source file imports (`type` imports skipped, `X as Y` read as X). */
function lucideImports(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  const names: string[] = [];
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name =
        raw
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? '';
      if (name === '' || name.startsWith('type ')) continue;
      names.push(name);
    }
  }
  return names;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(SRC, dir))) {
    const path = join(dir, entry);
    if (statSync(join(SRC, path)).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** The rendered svg of a Lucide component. */
function svgOf(name: string): SVGSVGElement {
  const component = (Lucide as unknown as Record<string, ComponentType>)[name];
  if (component === undefined) throw new Error(`no Lucide icon ${name}`);
  const { container } = render(createElement(component));
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error(`${name} renders no svg`);
  return svg;
}

/** The canonical id: the first `lucide-<id>` class. */
const idOf = (svg: Element): string =>
  (Array.from(svg.classList).find((name) => name.startsWith('lucide-')) ?? '').slice('lucide-'.length);

/** Tool strip, sidebars, home and menus: every icon there must have an explicit entry. */
const EXPLICIT = [
  'features/modes/useSlots.tsx',
  'features/shell/LeftPanel.tsx',
  'features/outline/Outline.tsx',
  'features/comments/Comments.tsx',
  'features/comments/CommentsFilter.tsx',
  'features/historyList/HistoryPanel.tsx',
  'features/topbar/RightCluster.tsx',
  'components/Menu.tsx',
  'components/Toolbar.tsx',
  'actions/registry.ts',
  ...sources('features/home'),
];

const appIcons = [...new Set(sources('.').flatMap(lucideImports))].filter(
  (name) => /^[A-Z]/.test(name) && name !== 'LucideIcon',
);

afterEach(() => cleanup());

describe('icon motion catalogue', () => {
  it('gives every icon the app renders an explicit entry (trace stays the fallback for new ones)', () => {
    const fallback = appIcons.filter((name) => CATALOGUE[idOf(svgOf(name))] === undefined);
    expect(fallback).toEqual([]);
  });

  it('has an explicit entry for every icon of the tool strip, the sidebars, the home and the menus', () => {
    const strip = lucideImports('features/modes/useSlots.tsx');
    expect(strip.length).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const name of new Set(EXPLICIT.flatMap(lucideImports))) {
      const id = idOf(svgOf(name));
      if (CATALOGUE[id] === undefined) missing.push(`${name} (${id})`);
    }
    expect(missing).toEqual([]);
  });

  it('only names elements the icons have, and every family is used', () => {
    const wrong: string[] = [];
    const used = new Set<Family>();
    for (const name of appIcons) {
      const svg = svgOf(name);
      const motion = CATALOGUE[idOf(svg)];
      if (motion === undefined) continue;
      used.add(motion.family);
      const count = svg.querySelectorAll(GEOMETRY).length;
      for (const track of motion.tracks) {
        const indexes = track.el === 'all' || track.el === 'longest' ? [] : track.el;
        for (const index of indexes) if (index >= count) wrong.push(`${name}[${index}]`);
      }
    }
    expect(wrong).toEqual([]);
    // Trace is the fallback for icons without an entry.
    used.add('trace');
    expect([...used].sort()).toEqual(Object.keys(FAMILY_FACTOR).sort());
  });

  it('keeps every family between 0.8 and 1.1 s', () => {
    for (const factor of Object.values(FAMILY_FACTOR)) {
      expect(MOTION_ICON_MS * factor).toBeGreaterThanOrEqual(800);
      expect(MOTION_ICON_MS * factor).toBeLessThanOrEqual(1100);
    }
  });

  it('finds an entry by an alias class and falls back to trace', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lucide lucide-not-in-the-catalogue lucide-house');
    expect(motionFor(svg)).toBe(CATALOGUE.house);
    svg.setAttribute('class', 'lucide lucide-not-in-the-catalogue');
    expect(motionFor(svg)).toBe(TRACE);
  });
});

describe('icon motion player', () => {
  type Call = { el: Element; frames: Keyframe[]; options: KeyframeAnimationOptions };
  let made: Call[];
  let lengths: Map<Element, number>;

  beforeEach(() => {
    made = [];
    lengths = new Map();
    Object.defineProperty(SVGElement.prototype, 'getTotalLength', {
      configurable: true,
      value(this: SVGElement) {
        return lengths.get(this) ?? 20;
      },
    });
    Object.defineProperty(SVGElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
        made.push({ el: this, frames, options });
        return { cancel: vi.fn() };
      }),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength');
    Reflect.deleteProperty(SVGElement.prototype, 'animate');
  });

  const REST = /^translate\(0px, 0px\) rotate\((-?\d+)deg\)$/;

  it('starts every move and ends every animation exactly in the rest state, inside the total, never filled forwards', () => {
    for (const name of appIcons) {
      made = [];
      const svg = svgOf(name);
      const { total } = playMotion(svg, 16);
      expect(made.length, name).toBeGreaterThan(0);
      for (const { frames, options } of made) {
        const first = frames[0] ?? {};
        const last = frames[frames.length - 1] ?? {};
        expect(options.fill, name).toBe('backwards');
        expect(Number(options.delay) + Number(options.duration), name).toBeLessThanOrEqual(total + 1e-6);
        if ('transform' in last) {
          const turn = REST.exec(String(last.transform));
          expect(turn, `${name} ${String(last.transform)}`).not.toBeNull();
          expect(Math.abs(Number(turn?.[1]) % 360), name).toBe(0);
          expect(last.transformBox, name).toBeDefined();
          if (!('opacity' in first))
            expect(String(first.transform), name).toMatch(/^translate\(0px, 0px\) rotate\(0deg\)$/);
          if ('opacity' in last) expect(last.opacity, name).toBe(1);
        } else if ('strokeDashoffset' in last) {
          expect(last.strokeDashoffset, name).toBe('0');
        } else {
          expect(last.opacity, name).toBe(1);
        }
      }
    }
  });

  it('draws each stroke completely with a dash longer than the path and hides the caps before the pen', () => {
    const svg = svgOf('Check');
    const sw = (STROKE_PX * 24) / 16;
    playMotion(svg, 16);
    const [call] = made;
    const [dash, gap] = String(call?.frames[0]?.strokeDasharray).split(' ').map(Number);
    expect(dash).toBeGreaterThan(20);
    expect(gap).toBeGreaterThanOrEqual(20 + 3 * sw);
    expect(Number(call?.frames[0]?.strokeDashoffset)).toBeGreaterThanOrEqual(20 + 1.5 * sw);
    expect(call?.options.easing).toBe(EASE_DRAW);
  });

  it('draws a reversed line from its end', () => {
    playMotion(svgOf('FileText'), 16);
    const offsets = made.map((call) => Number(call.frames[0]?.strokeDashoffset));
    expect(offsets).toHaveLength(3);
    for (const offset of offsets) expect(offset).toBeLessThan(0);
  });

  it('plays a sequence in its order, one element after the other', () => {
    const svg = svgOf('Type');
    const shapes = Array.from(svg.querySelectorAll(GEOMETRY));
    playMotion(svg, 20);
    expect(made.map((call) => shapes.indexOf(call.el))).toEqual([1, 0, 2]);
    for (let at = 1; at < made.length; at += 1) {
      expect(Number(made[at]?.options.delay)).toBeGreaterThan(Number(made[at - 1]?.options.delay));
    }
  });

  it('traces the fallback longest first and fades dots in their turn', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lucide lucide-unknown');
    const shapes = [10, 30, 0.01, 20].map((length) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      lengths.set(path, length);
      svg.appendChild(path);
      return path;
    });
    const { total } = playMotion(svg, 16);
    expect(total).toBeCloseTo(MOTION_ICON_MS * FAMILY_FACTOR.trace);
    expect(made.map((call) => shapes.indexOf(call.el as SVGPathElement))).toEqual([1, 3, 0, 2]);
    const dot = made[3];
    expect(dot?.frames[0]).toEqual({ opacity: 0 });
    expect(0.01 * (16 / 24)).toBeLessThan(DOT_PX);
    const ends = made.map((call) => Number(call.options.delay) + Number(call.options.duration));
    expect(Math.max(...ends)).toBeCloseTo(total);
  });

  it('turns about the view box centre or a fill-box origin', () => {
    playMotion(svgOf('RotateCw'), 16);
    expect(made[0]?.frames[0]?.transformBox).toBe('view-box');
    expect(made[0]?.frames[0]?.transformOrigin).toBe('12px 12px');
    made = [];
    playMotion(svgOf('Lock'), 16);
    expect(made[0]?.frames[0]?.transformBox).toBe('fill-box');
  });
});
