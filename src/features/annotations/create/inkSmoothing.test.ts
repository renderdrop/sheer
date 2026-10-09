import { mkdirSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { capSamples, catmullRom, movingAverage, smoothStroke, thinSamples, type Sample } from './ink';
import { endDirection } from './drawVariants';

/** A deterministic pseudo random generator, so the jitter is the same on every run. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

function jitter(path: (t: number) => [number, number], count: number, amount: number, seed: number): Sample[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const [x, y] = path(i / (count - 1));
    return { x: x + r() * amount, y: y + r() * amount, pressure: 0.5 };
  });
}

const CURVE = (t: number): [number, number] => [200 * t, 60 * Math.sin(t * Math.PI)];
const LOOP = (t: number): [number, number] => [
  50 + 40 * Math.cos(t * 2 * Math.PI),
  50 + 40 * Math.sin(t * 2 * Math.PI),
];
const ZIGZAG = (t: number): [number, number] => [
  200 * t,
  20 * Math.sin(t * 6 * Math.PI) + 10 * Math.sin(t * 17 * Math.PI),
];

const STROKES: Record<string, Sample[]> = {
  curve: jitter(CURVE, 300, 3, 1),
  loop: jitter(LOOP, 300, 3, 2),
  zigzag: jitter(ZIGZAG, 400, 3, 3),
};

/** The old pipeline (before F20.4): average of 3, spline with 2 steps. */
const before = (raw: Sample[]): Sample[] => capSamples(catmullRom(movingAverage(raw, 1), 2), 3000);

/** The sum of the absolute turning angles along the path, in radians. */
function turning(line: readonly Sample[]): number {
  let sum = 0;
  for (let i = 2; i < line.length; i += 1) {
    const a = line[i - 2];
    const b = line[i - 1];
    const c = line[i];
    if (a === undefined || b === undefined || c === undefined) continue;
    const d = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    sum += Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  }
  return sum;
}

describe('freehand smoothing (F20.4)', () => {
  for (const [name, raw] of Object.entries(STROKES)) {
    it(`${name}: fewer points per length, smoother, same ends`, () => {
      const out = smoothStroke(raw);
      const old = before(raw);
      expect(out.length).toBeLessThan(old.length);
      expect(turning(out)).toBeLessThan(turning(old) / 2);
      expect(out[0]).toEqual(raw[0]);
      expect(out[out.length - 1]).toEqual(raw[raw.length - 1]);
    });
  }

  it('thins by distance and keeps the first and last sample', () => {
    const raw: Sample[] = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.4, y: 0, pressure: 0.5 }));
    const out = thinSamples(raw, 2);
    expect(out.length).toBeLessThan(15);
    expect(out[0]).toEqual(raw[0]);
    expect(out[out.length - 1]).toEqual(raw[49]);
  });

  it('the end direction follows the end of the stroke', () => {
    const line: Sample[] = jitter((t) => [100 * t, 0], 200, 2, 5);
    for (let i = 0; i < 40; i += 1) line.push({ x: 100, y: i * 2, pressure: 0.5 });
    const dir = endDirection(smoothStroke(line));
    expect(dir?.y).toBeGreaterThan(0.8);
  });

  it.runIf(process.env.INK_COMPARE === '1')('writes the before and after SVGs to review/ink-compare', () => {
    mkdirSync('review/ink-compare', { recursive: true });
    const path = (line: readonly Sample[]) =>
      line.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    for (const [name, raw] of Object.entries(STROKES)) {
      const row = (title: string, line: readonly Sample[], colour: string) =>
        `<g><text x="4" y="12" font-size="10">${title} (${line.length} points)</text><path d="${path(line)}" fill="none" stroke="${colour}" stroke-width="1.5"/></g>`;
      const svg = (title: string, line: readonly Sample[], colour: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -30 230 160" width="460" height="320">${row(title, line, colour)}</svg>`;
      writeFileSync(`review/ink-compare/${name}-raw.svg`, svg('raw', raw, '#999'));
      writeFileSync(`review/ink-compare/${name}-before.svg`, svg('before', before(raw), '#c33'));
      writeFileSync(`review/ink-compare/${name}-after.svg`, svg('after', smoothStroke(raw), '#36c'));
    }
  });
});
