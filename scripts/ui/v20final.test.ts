import { describe, expect, it } from 'vitest';

// @ts-expect-error plain .mjs without types
import * as v from './accept/v20final-pure.mjs';

describe('v2.0.0 final acceptance helpers', () => {
  it('compares computed colours', () => {
    expect(v.rgbIs('rgb(250, 250, 248)', v.CHROME_RGB)).toBe(true);
    expect(v.rgbIs('rgba(250, 250, 248, 1)', v.CHROME_RGB)).toBe(true);
    expect(v.rgbIs('rgba(250, 250, 248, 0.5)', v.CHROME_RGB)).toBe(false);
    expect(v.rgbIs('rgb(255, 255, 255)', v.CHROME_RGB)).toBe(false);
    expect(v.colourClose([250, 250, 248], [244, 252, 250])).toBe(true);
    expect(v.colourClose([250, 250, 248], [200, 200, 200])).toBe(false);
  });

  it('checks containment and tile grids', () => {
    const box = { l: 0, t: 0, r: 100, b: 100 };
    expect(v.insideRect({ l: 0, t: 0, r: 100, b: 101 }, box)).toBe(true);
    expect(v.insideRect({ l: 0, t: 0, r: 104, b: 90 }, box)).toBe(false);
    expect(v.expectedTileGrid(1000)).toEqual({ cols: 4, rows: 2 });
    expect(v.expectedTileGrid(700)).toEqual({ cols: 2, rows: 4 });
    expect(v.columnsOf([{ l: 10 }, { l: 11 }, { l: 200 }])).toBe(2);
  });

  it('detects split words in titles', () => {
    const chars = (s: string, top: number) => [...s].map((ch) => ({ ch, top }));
    const ok = v.linesOfChars([...chars('Compress', 0), ...chars('PDF', 20)]);
    expect(v.titleNeverSplit(ok, 'Compress PDF')).toBe(true);
    const bad = v.linesOfChars([...chars('Compre', 0), ...chars('ss', 20)]);
    expect(v.titleNeverSplit(bad, 'Compress')).toBe(false);
  });

  it('judges thumbnail sharpness', () => {
    expect(v.thumbSharp(400, 520, 200, 260, 2)).toBe(true);
    expect(v.thumbSharp(200, 260, 200, 260, 2)).toBe(false);
    expect(v.thumbSharp(0, 0, 200, 260, 1)).toBe(false);
  });

  it('judges stroke smoothness', () => {
    const line = Array.from({ length: 10 }, (_, i) => ({ x: i, y: i * 0.1 }));
    expect(v.strokeSmooth(line, 50).ok).toBe(true);
    expect(v.strokeSmooth(line, 10).ok).toBe(false);
    const zig = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(v.strokeSmooth(zig, 50).ok).toBe(false);
    expect(v.strokePoints({ points: [[1, 2]] })).toEqual([{ x: 1, y: 2 }]);
  });

  it('judges smooth following', () => {
    expect(v.followsSmoothly([0, 10, 25, 40], 30).ok).toBe(true);
    expect(v.followsSmoothly([0, 10, 400], 30).ok).toBe(false);
    expect(v.followsSmoothly([0, 20, 5], 30).monotonic).toBe(false);
    expect(v.followsSmoothly([5, 5, 5], 30).ok).toBe(false);
  });

  it('clamps, validates and normalises', () => {
    expect(v.clampInspector(100)).toBe(240);
    expect(v.clampInspector(900)).toBe(480);
    expect(v.validHex('#1F9E6A')).toBe(true);
    expect(v.validHex('12')).toBe(false);
    expect(v.zoomText('1600 %')).toBe('1600 %');
  });
});
