import { describe, expect, it } from 'vitest';

// @ts-expect-error plain .mjs without types: the gate script is not part of the TS program
import * as c from './surface-checks.mjs';

const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const vp = { w: 960, h: 640 };

describe('surface gate checks', () => {
  it('accepts a surface inside the viewport and flags each overflowing edge', () => {
    expect(c.checkInViewport(r(10, 10, 400, 300), vp)).toEqual([]);
    expect(c.checkInViewport(r(0, 0, 960, 640), vp)).toEqual([]);
    expect(c.checkInViewport(r(-5, -5, 970, 650), vp)).toHaveLength(4);
  });

  it('flags a control cut by an ancestor or by the viewport', () => {
    const ok = { name: 'OK', rect: r(20, 20, 80, 50), clips: [r(0, 0, 100, 100)] };
    const cut = { name: 'Save', rect: r(20, 90, 80, 120), clips: [r(0, 0, 100, 100)] };
    const off = { name: 'Close', rect: r(900, 600, 1000, 660), clips: [] };
    expect(c.checkClipped([ok, cut, off], vp)).toEqual(['Save is clipped', 'Close is clipped']);
  });

  it('allows internal scroll in lists only', () => {
    const items = [
      { name: 'div.body', scrollHeight: 500, clientHeight: 300, isList: false },
      { name: 'ul.items', scrollHeight: 500, clientHeight: 300, isList: true },
      { name: 'div.fit', scrollHeight: 301, clientHeight: 300, isList: false },
    ];
    expect(c.checkScroll(items)).toEqual(['div.body scrolls inside (500 > 300)']);
  });

  it('flags overlap with layers and outside controls, not a mere touch', () => {
    const s = r(100, 100, 300, 300);
    expect(c.checkOverlap(s, [{ name: 'tip', rect: r(250, 250, 400, 400) }], [])).toEqual(['overlaps tip']);
    expect(c.checkOverlap(s, [], [{ name: 'Zoom', rect: r(300, 100, 340, 130) }])).toEqual([]);
    expect(c.checkOverlap(s, [], [{ name: 'Zoom', rect: r(280, 120, 340, 150) }])).toEqual(['covers Zoom']);
  });

  it('builds one row per check', () => {
    const rows = c.rowsFor('about', { inside: [], scroll: ['a', 'b', 'c', 'd'] });
    expect(rows[0]).toEqual({ surface: 'about', check: 'inside', result: 'PASS' });
    expect(rows[1].result).toBe('FAIL a; b; c (+1)');
  });
});
