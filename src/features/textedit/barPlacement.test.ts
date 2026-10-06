import { describe, expect, it } from 'vitest';

import type { TextLineInfo } from '../../api/textEdit';
import { coverage, obstaclesOf, placeEditBar } from './barPlacement';

const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
const bar = { width: 200, height: 40 };
const sel = { left: 300, top: 300, right: 420, bottom: 316 };

describe('placeEditBar', () => {
  it('aligns the bar to the box start, above, clear of the box', () => {
    const p = placeEditBar(sel, bar, bounds, []);
    expect(p).toEqual({ mode: 'above', left: 300, top: 300 - 8 - 40 });
  });
  it('clamps to the canvas', () => {
    const p = placeEditBar({ ...sel, left: 700, right: 760 }, bar, bounds, []);
    expect(p.mode === 'dock' ? 0 : p.left).toBe(800 - 8 - 200);
  });
  it('goes below when the text above is dense and below is freer', () => {
    const dense = [{ left: 0, top: 240, right: 800, bottom: 290 }];
    const p = placeEditBar(sel, bar, bounds, dense);
    expect(p).toMatchObject({ mode: 'below', top: 316 + 8 });
  });
  it('stays above when both sides are equally dense', () => {
    const both = [{ left: 0, top: 0, right: 800, bottom: 600 }];
    expect(placeEditBar(sel, bar, bounds, both).mode).toBe('above');
  });
  it('goes below when above does not fit, docks when nothing fits', () => {
    expect(placeEditBar({ ...sel, top: 20, bottom: 36 }, bar, bounds, []).mode).toBe('below');
    expect(placeEditBar(sel, bar, { ...bounds, top: 290, bottom: 330 }, []).mode).toBe('dock');
  });
  it('measures coverage', () => {
    expect(coverage({ left: 0, top: 0, right: 10, bottom: 10 }, [{ left: 0, top: 0, right: 5, bottom: 10 }])).toBe(0.5);
  });
});

describe('obstaclesOf', () => {
  const mk = (i: number, y: number): TextLineInfo => ({
    key: { rev: 0, line: i },
    text: 'x',
    box: { x: 10, y, w: 100, h: 10 },
    paragraph: i,
    justified: false,
    font: { name: 'A', size: 10, embedded: true },
    editable: { type: 'same' },
  });
  it('maps the other lines to client pixels by the box itself', () => {
    const lines = [mk(0, 0), mk(1, 20)];
    const out = obstaclesOf(lines, lines[1] as TextLineInfo, { x: 50, y: 220, w: 200, h: 20 }, 'left');
    expect(out).toEqual([{ left: 50, top: 180, right: 250, bottom: 200 }]);
  });
});
