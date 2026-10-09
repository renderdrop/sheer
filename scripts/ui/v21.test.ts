import { describe, expect, it } from 'vitest';

// @ts-expect-error plain .mjs without types
import * as v from './accept/v21-pure.mjs';

const grey = (n: number): [number, number, number] => [n, n, n];

describe('v2.1 acceptance helpers', () => {
  it('compares rects and finds the client origin', () => {
    const a = { l: 0, t: 0, r: 100, b: 50 };
    expect(v.rectsEqual(a, { l: 1, t: 0, r: 99, b: 51 })).toBe(true);
    expect(v.rectsEqual(a, { l: 3, t: 0, r: 100, b: 50 })).toBe(false);
    expect(v.rectsEqual(null, a)).toBe(false);
    expect(v.clientOrigin({ w: 1296, h: 839 }, 1280, 800, 1)).toEqual({ x: 8, y: 31 });
  });

  it('detects stripes and hard edges along a line', () => {
    const smooth = Array.from({ length: 50 }, (_, i) => grey(240 + Math.floor(i / 10)));
    expect(v.maxNeighbourDelta(smooth)).toBe(1);
    expect(v.glowLinesVerdict([{ name: 'top', samples: smooth }]).ok).toBe(true);
    const striped = [...smooth.slice(0, 25), ...smooth.slice(25).map(() => grey(200))];
    const verdict = v.glowLinesVerdict([{ name: 'right', samples: striped }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.worst).toBeGreaterThan(30);
    expect(v.glowLinesVerdict([]).ok).toBe(false);
  });

  it('reads the mode of a tools group and judges a tile', () => {
    expect(v.modeOfGroupId('tools-group-comment')).toBe('comment');
    expect(v.modeOfGroupId('other')).toBeNull();
    expect(v.toolReady('draw', { doc: true, modeSelected: true, pressed: true }).ok).toBe(true);
    expect(v.toolReady('draw', { doc: true, modeSelected: false, pressed: true }).ok).toBe(false);
    expect(v.toolReady('draw', { doc: false, modeSelected: true, pressed: true }).ok).toBe(false);
    expect(v.toolReady('crop', { doc: true, modeSelected: true }).ok).toBe(false);
    expect(v.toolReady('redact', { doc: true, modeSelected: true, inspector: true }).ok).toBe(true);
    expect(v.toolReady('pages', { doc: true, modeSelected: true }).ok).toBe(true);
    expect(v.toolReady('pages', { doc: true, modeSelected: false }).ok).toBe(false);
    expect(v.toolReady('images', { dialog: true }).ok).toBe(true);
    expect(v.toolReady('merge', { dialog: true }).ok).toBe(true);
  });

  it('builds the footer test document and judges the pixels', () => {
    const pdf = v.footedPdf() as Buffer;
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain(v.OLD_FOOTER);
    expect(text).toContain('1 0 0 rg');
    expect(v.isRed([220, 20, 20])).toBe(true);
    expect(v.isRed([20, 20, 20])).toBe(false);
    expect(v.isDark([20, 20, 20])).toBe(true);
    const rgbAt = (x: number) => (x < 2 ? [255, 0, 0] : [255, 255, 255]);
    expect(v.countPixels(rgbAt, { x0: 0, y0: 0, x1: 4, y1: 3 }, v.isRed)).toBe(6);
    const region = v.pdfRegion({ l: 10, t: 20 }, 2, 24, 54, 24, 33);
    expect(region).toEqual({ x0: 68, x1: 128, y0: 20 * 2 + (792 - 33) * 2, y1: 20 * 2 + (792 - 24) * 2 });
    expect(v.footerVerdict({ redUnder: 0, redOutside: 80, darkUnder: 60 }).ok).toBe(true);
    expect(v.footerVerdict({ redUnder: 3, redOutside: 80, darkUnder: 60 }).ok).toBe(false);
    expect(v.footerVerdict({ redUnder: 0, redOutside: 0, darkUnder: 60 }).ok).toBe(false);
  });

  it('measures the seam of a closed stroke', () => {
    const n = 60;
    const circle = Array.from({ length: n + 1 }, (_, i) => ({
      x: 100 + 40 * Math.cos((i / n) * 2 * Math.PI),
      y: 100 + 40 * Math.sin((i / n) * 2 * Math.PI),
    }));
    const ok = v.seamVerdict(circle);
    expect(ok.closed).toBe(true);
    expect(ok.turn).toBeLessThan(15);
    expect(ok.ok).toBe(true);
    // a stroke with a blunt join: the end leads back to the start at a right angle
    const kinked = [...circle.slice(0, 45), { x: 100, y: 100 }, { x: 140, y: 100 }];
    expect(v.seamVerdict(kinked).ok).toBe(false);
    const open = circle.slice(0, 30);
    expect(v.seamVerdict(open).closed).toBe(false);
    // closed but with a sharp corner at the seam
    const corner = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
      { x: 0, y: 0 },
    ];
    expect(v.seamVerdict(corner).turn).toBeCloseTo(90, 0);
    expect(v.seamVerdict(corner).ok).toBe(false);
  });

  it('generates the five hand-drawn shapes', () => {
    for (const kind of ['circle', 'ellipse', 'rectangle', 'triangle', 'overlap']) {
      const pts = v.shapeStroke(kind, 300, 300, 120, 2);
      expect(pts.length).toBeGreaterThan(40);
      expect(pts.every((p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    }
    // the open loops end near, not at, the start
    const circle = v.shapeStroke('circle', 300, 300, 120, 2);
    expect(v.endGap(circle)).toBeGreaterThan(0);
    expect(v.endGap(circle)).toBeLessThan(0.25 * v.pathLength(circle));
  });

  it('tells a clogged heading from anti-aliased text', () => {
    const W = 60;
    const H = 30;
    const block = (x: number, y: number) => (y < 12 && x < 50 ? 10 : 255);
    const clogged = v.darkBlockStats(block, { x0: 0, y0: 0, x1: W, y1: H });
    expect(v.thumbVerdict(clogged).ok).toBe(false);
    // thin grey strokes: ink everywhere, never a solid cell
    const text = (x: number, y: number) => (x % 4 === 0 && y < 12 ? 90 : 255);
    const fine = v.darkBlockStats(text, { x0: 0, y0: 0, x1: W, y1: H });
    expect(fine.inked).toBeGreaterThan(0);
    expect(v.thumbVerdict(fine).ok).toBe(true);
    // an empty rect is no proof
    expect(v.thumbVerdict(v.darkBlockStats(() => 255, { x0: 0, y0: 0, x1: W, y1: H })).ok).toBe(false);
  });

  it('judges tooltip timing and the toolbar card', () => {
    expect(v.tooltipTimingOk(false, true)).toBe(true);
    expect(v.tooltipTimingOk(true, true)).toBe(false);
    expect(v.tooltipTimingOk(false, false)).toBe(false);
    expect(v.iconOnly(['', ' ', ''])).toBe(true);
    expect(v.iconOnly(['', 'Draw'])).toBe(false);
    expect(v.iconOnly([])).toBe(false);
    expect(v.heightIs(98, v.CARD_HEIGHT.icons)).toBe(true);
    expect(v.heightIs(106, v.CARD_HEIGHT.icons)).toBe(false);
    expect(v.heightIs(106, v.CARD_HEIGHT.labels)).toBe(true);
  });
});
