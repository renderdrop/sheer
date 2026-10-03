import { describe, expect, it } from 'vitest';

import {
  ROTATIONS,
  addRotation,
  boxToPage,
  boxToView,
  normalizeRotation,
  overlayBox,
  pageToView,
  quadBox,
  rotateSize,
  rotatedSizes,
  totalRotation,
  unrotatedSize,
  viewToPage,
} from './transform';

const PAGE: readonly [number, number] = [100, 200];

describe('rotations', () => {
  it('normalizes any angle to a quarter turn', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-360)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('adds file and view rotation', () => {
    expect(totalRotation(90, 270)).toBe(0);
    expect(totalRotation(180, 90)).toBe(270);
    expect(addRotation(270, 90)).toBe(0);
    expect(addRotation(0, -90)).toBe(270);
  });

  it('swaps the sides of a page for a quarter turn only', () => {
    expect(rotateSize([100, 200], 90)).toEqual([200, 100]);
    expect(rotateSize([100, 200], 180)).toEqual([100, 200]);
    expect(unrotatedSize([200, 100], 270)).toEqual([100, 200]);
  });

  it('remembers the rotated list, and hands back the list itself when nothing swaps', () => {
    const sizes: readonly (readonly [number, number])[] = [
      [100, 200],
      [300, 100],
    ];
    expect(rotatedSizes(sizes, 0)).toBe(sizes);
    expect(rotatedSizes(sizes, 180)).toBe(sizes);
    const turned = rotatedSizes(sizes, 90);
    expect(turned).toEqual([
      [200, 100],
      [100, 300],
    ]);
    expect(rotatedSizes(sizes, 90)).toBe(turned);
    expect(rotatedSizes(sizes, 270)).not.toBe(turned);
  });
});

describe('page space to view space', () => {
  it('moves the corners of a page 100 x 200 as a clockwise turn does', () => {
    const topLeft = { x: 0, y: 0 };
    const bottomRight = { x: 100, y: 200 };
    expect(pageToView(topLeft, PAGE, 0)).toEqual({ x: 0, y: 0 });
    expect(pageToView(topLeft, PAGE, 90)).toEqual({ x: 200, y: 0 });
    expect(pageToView(topLeft, PAGE, 180)).toEqual({ x: 100, y: 200 });
    expect(pageToView(topLeft, PAGE, 270)).toEqual({ x: 0, y: 100 });
    expect(pageToView(bottomRight, PAGE, 90)).toEqual({ x: 0, y: 100 });
    expect(pageToView(bottomRight, PAGE, 270)).toEqual({ x: 200, y: 0 });
  });

  it('stays inside the rotated page', () => {
    for (const rotation of ROTATIONS) {
      const [w, h] = rotateSize(PAGE, rotation);
      for (const point of [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 200 },
        { x: 100, y: 200 },
        { x: 30, y: 70 },
      ]) {
        const view = pageToView(point, PAGE, rotation);
        expect(view.x).toBeGreaterThanOrEqual(0);
        expect(view.x).toBeLessThanOrEqual(w);
        expect(view.y).toBeGreaterThanOrEqual(0);
        expect(view.y).toBeLessThanOrEqual(h);
      }
    }
  });

  it('is undone by the inverse, for every rotation', () => {
    for (const rotation of ROTATIONS) {
      const point = { x: 30, y: 70 };
      expect(viewToPage(pageToView(point, PAGE, rotation), PAGE, rotation)).toEqual(point);
    }
  });

  it('rotates a box and keeps it a box', () => {
    const box = { x: 10, y: 20, w: 30, h: 5 };
    expect(boxToView(box, PAGE, 0)).toEqual(box);
    // A quarter turn: the box is now tall, and its top is where its left was.
    expect(boxToView(box, PAGE, 90)).toEqual({ x: 175, y: 10, w: 5, h: 30 });
    expect(boxToView(box, PAGE, 180)).toEqual({ x: 60, y: 175, w: 30, h: 5 });
    for (const rotation of ROTATIONS) {
      expect(boxToPage(boxToView(box, PAGE, rotation), PAGE, rotation)).toEqual(box);
    }
  });

  it('takes the box of a quad', () => {
    const quad = [
      { x: 10, y: 20 },
      { x: 40, y: 21 },
      { x: 10, y: 30 },
      { x: 40, y: 31 },
    ];
    expect(quadBox(quad)).toEqual({ x: 10, y: 20, w: 30, h: 11 });
    expect(quadBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('overlayBox', () => {
  it('centres the unrotated page in the rotated element and scales it', () => {
    // The page is drawn at 2 px per point and turned: the element is 400 x 200 px.
    const box = overlayBox(400, 200, PAGE, 2, 90);
    expect(box).toEqual({ left: 150, top: 0, width: 100, height: 200, transform: 'rotate(90deg) scale(2)' });
  });

  it('has no rotate() at rest', () => {
    expect(overlayBox(200, 400, PAGE, 2, 0).transform).toBe('scale(2)');
  });
});
