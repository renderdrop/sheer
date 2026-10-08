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

  it('flags a label wider than its button (ellipsis)', () => {
    const b = { name: 'Save', rect: r(20, 20, 80, 50), clips: [], label: { scrollWidth: 70, clientWidth: 50 } };
    expect(c.checkClipped([b], vp)).toEqual(['Save label is cut (70 > 50)']);
    expect(c.checkClipped([{ ...b, label: { scrollWidth: 51, clientWidth: 50 } }], vp)).toEqual([]);
  });

  it('a row scrolled out of a visible list is no cut-off; a cut list is', () => {
    // the page measures the row without the list's clip and adds the list as a control of its own
    const row = { name: 'row 40', rect: r(20, 20, 80, 50), clips: [r(0, 0, 400, 400)] };
    const list = { name: 'ul', rect: r(10, 10, 300, 300), clips: [r(0, 0, 400, 400)] };
    expect(c.checkClipped([row, list], vp)).toEqual([]);
    expect(c.checkClipped([{ ...list, rect: r(10, 10, 300, 500) }], vp)).toEqual(['ul is clipped']);
  });

  it('allows internal scroll in lists only, and only for overflow auto/scroll', () => {
    const items = [
      { name: 'div.body', scrollHeight: 500, clientHeight: 300, overflowY: 'auto', isList: false },
      { name: 'ul.items', scrollHeight: 500, clientHeight: 300, overflowY: 'auto', isList: true },
      { name: 'div.fit', scrollHeight: 301, clientHeight: 300, overflowY: 'scroll', isList: false },
      { name: 'label', scrollHeight: 16, clientHeight: 1, overflowY: 'hidden', isList: false },
    ];
    expect(c.checkScroll(items)).toEqual(['div.body scrolls inside (500 > 300)']);
  });

  it('flags sideways overflow of non-lists and descendants leaving the surface', () => {
    const els = [
      { name: 'div.row', scrollWidth: 400, clientWidth: 300, isList: false },
      { name: 'ul', scrollWidth: 400, clientWidth: 300, isList: true },
    ];
    expect(c.checkHScroll(els)).toEqual(['div.row overflows sideways (400 > 300)']);
    const d = [{ name: 'btn', rect: r(90, 90, 120, 120) }];
    expect(c.checkDescendants(r(0, 0, 100, 100), d)).toEqual(['btn leaves the surface']);
    expect(c.checkDescendants(r(0, 0, 100, 100), [{ name: 'in', rect: r(0, 0, 100, 100) }])).toEqual([]);
  });

  it('flags two non-nested interactive elements that intersect', () => {
    const a = { id: 0, name: 'a', rect: r(0, 0, 100, 40), parents: [] };
    const inner = { id: 1, name: 'inner', rect: r(10, 10, 50, 30), parents: [0] };
    const b = { id: 2, name: 'b', rect: r(90, 10, 140, 30), parents: [] };
    expect(c.checkControlOverlap([a, inner])).toEqual([]);
    expect(c.checkControlOverlap([a, inner, b])).toEqual(['a overlaps b']);
  });

  it('lets a menu or popover cover toolbar buttons below it, but not its anchor, the active tool or the focused input', () => {
    const menu = r(100, 40, 300, 240);
    const below = { name: 'Zoom', rect: r(120, 100, 180, 130), role: 'other' };
    expect(c.checkOverlap('popover', menu, [], [below])).toEqual([]);
    const anchor = { name: 'Options', rect: r(150, 30, 200, 60), role: 'anchor' };
    const active = { name: 'Draw', rect: r(210, 100, 260, 130), role: 'active' };
    const focus = { name: 'input', rect: r(110, 200, 190, 230), role: 'focus' };
    expect(c.checkOverlap('popover', menu, [], [anchor, active, focus])).toEqual([
      'covers anchor Options',
      'covers active Draw',
      'covers focus input',
    ]);
  });

  it('exempts a modal over its scrim but not floating layers; surfaces may not intersect each other', () => {
    const modal = r(100, 100, 500, 400);
    const below = { name: 'Zoom', rect: r(120, 120, 180, 150), role: 'anchor' };
    expect(c.checkOverlap('modal', modal, [], [below])).toEqual([]);
    expect(c.checkOverlap('modal', modal, [{ name: 'tip', rect: r(450, 350, 600, 450) }], [])).toEqual([
      'overlaps tip',
    ]);
    expect(c.checkOverlap('popover', r(0, 0, 50, 50), [{ name: 'tooltip', rect: r(60, 0, 90, 20) }], [])).toEqual([]);
  });

  it('flags a notice that covers an input or any other protected rect', () => {
    const tip = { name: 'tip', rect: r(100, 100, 300, 160) };
    const input = { name: 'input "Name"', rect: r(120, 140, 280, 172), role: 'other' };
    const far = { name: 'button', rect: r(400, 100, 460, 130), role: 'other' };
    expect(c.checkNotice(tip, [input, far])).toEqual(['tip covers input "Name"']);
    expect(c.checkNotice(tip, [far])).toEqual([]);
  });

  it('builds one row per check', () => {
    const rows = c.rowsFor('about', { inside: [], scroll: ['a', 'b', 'c', 'd'] });
    expect(rows[0]).toEqual({ surface: 'about', check: 'inside', result: 'PASS' });
    expect(rows[1].result).toBe('FAIL a; b; c (+1)');
  });

  it('ignores visually hidden (sr-only) text, not visible text (ADR-124 addendum 1 a)', () => {
    const box = { width: 80, height: 20 };
    expect(c.isVisuallyHidden({ ...box, clip: 'rect(0px, 0px, 0px, 0px)' })).toBe(true);
    expect(c.isVisuallyHidden({ ...box, clipPath: 'inset(50%)' })).toBe(true);
    expect(c.isVisuallyHidden({ width: 1, height: 1 })).toBe(true);
    expect(c.isVisuallyHidden({ ...box, clip: 'auto', clipPath: 'none' })).toBe(false);
    expect(c.isVisuallyHidden({ ...box })).toBe(false);
  });

  it('an in-field adornment overlapping its own field is no overlap; another control still is', () => {
    const input = { id: 0, name: 'input', rect: r(10, 10, 200, 42), parents: [], field: 7 };
    const eye = { id: 1, name: 'eye', rect: r(170, 14, 196, 38), parents: [], adornment: 7 };
    const other = { id: 2, name: 'other', rect: r(180, 20, 240, 50), parents: [] };
    expect(c.checkControlOverlap([input, eye])).toEqual([]);
    expect(c.checkControlOverlap([input, eye, other])).toEqual(['input overlaps other', 'eye overlaps other']);
    expect(c.checkControlOverlap([{ ...input, field: 8 }, eye])).toEqual(['input overlaps eye']);
  });

  it('a menu-bar menu may cover the toolbar and the active tool but never its anchor (ADR-124 addendum 1 c)', () => {
    const menu = r(10, 40, 200, 600);
    const active = { name: 'Select', rect: r(20, 60, 80, 90), role: 'active' };
    const anchor = { name: 'File', rect: r(0, 20, 50, 50), role: 'anchor' };
    expect(c.checkOverlap('menubar', menu, [], [active])).toEqual([]);
    expect(c.checkOverlap('menubar', menu, [], [active, anchor])).toEqual(['covers anchor File']);
    expect(c.checkOverlap('menubar', menu, [{ name: 'tip', rect: r(20, 100, 60, 120) }], [])).toEqual(['overlaps tip']);
  });
});

describe('checkLabelWrap (control label wraps)', () => {
  it('passes one-line labels, also at exactly 1.5 lines', () => {
    expect(c.checkLabelWrap([{ name: 'button "Apply"', height: 16, lineHeight: 16 }])).toEqual([]);
    expect(c.checkLabelWrap([{ name: 'button "Edge"', height: 24, lineHeight: 16 }])).toEqual([]);
  });

  it('flags a label whose text box is taller than 1.5 lines', () => {
    const wrapped = { name: 'button "Diese Seite"', height: 32, lineHeight: 16 };
    expect(c.checkLabelWrap([wrapped])).toEqual(['button "Diese Seite" label wraps (32.0 > 1.5 x 16.0)']);
  });

  it('measures control labels only, never a paragraph', () => {
    expect(c.isControlLabel('BUTTON', null)).toBe(true);
    expect(c.isControlLabel('div', 'radio')).toBe(true);
    expect(c.isControlLabel('div', 'tab')).toBe(true);
    expect(c.isControlLabel('li', 'menuitem')).toBe(true);
    expect(c.isControlLabel('p', null)).toBe(false);
    expect(c.isControlLabel('span', 'note')).toBe(false);
    expect(c.LABEL_SELECTOR).not.toContain('t-label');
    expect(c.LABEL_SELECTOR).not.toMatch(/(^|,)p[,[]/);
  });

  it('ignores a label without a line height', () => {
    expect(c.checkLabelWrap([{ name: 'x', height: 40, lineHeight: 0 }])).toEqual([]);
  });
});

describe('split button check', () => {
  const rest = r(10, 10, 110, 46);
  const ok = {
    state: 'hover',
    rect: r(10, 10, 110, 46),
    painted: [
      { name: 'main', rect: r(10, 10, 90, 46) },
      { name: 'chevron', rect: r(90, 10, 110, 46) },
    ],
  };
  it('passes a button whose painted parts stay inside and whose size is constant', () => {
    expect(c.checkSplitButtons([{ name: 'Strike', rest, states: [ok] }])).toEqual([]);
  });
  it('flags a part that spills past the outline and a size change', () => {
    const spill = { ...ok, painted: [{ name: 'chevron', rect: r(90, 10, 112, 46) }] };
    expect(c.checkSplitButtons([{ name: 'Strike', rest, states: [spill] }])).toEqual([
      'Strike on hover: chevron spills past the outline',
    ]);
    const grown = { state: 'pressed', rect: r(10, 10, 112, 46), painted: [] };
    expect(c.checkSplitButtons([{ name: 'Strike', rest, states: [grown] }])[0]).toMatch(/changes size on pressed/);
  });
  it('allows half a pixel of slack', () => {
    const near = { ...ok, painted: [{ name: 'main', rect: r(9.6, 10, 90, 46) }] };
    expect(c.checkSplitButtons([{ name: 'x', rest, states: [near] }])).toEqual([]);
  });
});

describe('hover geometry check (F19.2)', () => {
  const box = r(10, 10, 46, 46);
  const container = r(0, 0, 200, 56);
  const item = (paints: { name: string; rect: ReturnType<typeof r> }[], hover = box) => ({
    name: 'Highlight',
    box,
    container,
    hover: { box: hover, paints },
  });
  it('passes paints that equal the button box', () => {
    expect(c.checkHoverGeometry([item([{ name: 'button', rect: box }])])).toEqual([]);
  });
  it('allows no slack: a 0.5 px pseudo element or shadow spread fails', () => {
    expect(c.checkHoverGeometry([item([{ name: '::before', rect: r(9.5, 10, 46, 46) }])])).toEqual([
      'Highlight: hover ::before spills past the button',
    ]);
    expect(c.checkHoverGeometry([item([{ name: 'box-shadow spread', rect: r(9, 9, 47, 47) }])]).length).toBe(1);
  });
  it('flags a hover box that grew and a button outside its toolbar', () => {
    expect(c.checkHoverGeometry([item([], r(10, 10, 48, 46))])[0]).toMatch(/hover box differs/);
    expect(c.checkHoverGeometry([{ ...item([]), container: r(0, 0, 40, 56) }])[0]).toMatch(/outside its toolbar/);
  });
});
