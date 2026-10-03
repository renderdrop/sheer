import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXT_WIDTH_PT,
  defaultImageRect,
  handleAt,
  handlesFor,
  imageRectFromDrag,
  LINE_HEIGHT,
  movedRect,
  newTextBoxRect,
  resizedRect,
  viewDeltaToPage,
} from './geometry';

const page = [200, 400] as const;

describe('text box placement', () => {
  it('a click makes a 160 pt box with one line of height at the point', () => {
    const box = newTextBoxRect({ x: 20, y: 30 }, { x: 20, y: 30 }, 10, page);
    expect(box).toEqual({ x: 20, y: 30, w: DEFAULT_TEXT_WIDTH_PT, h: 10 * LINE_HEIGHT });
  });

  it('keeps the box on the page', () => {
    const box = newTextBoxRect({ x: 190, y: 399 }, { x: 190, y: 399 }, 10, page);
    expect(box.x + box.w).toBeLessThanOrEqual(200);
    expect(box.y + box.h).toBeLessThanOrEqual(400);
  });

  it('a drag sets the width, from either side', () => {
    expect(newTextBoxRect({ x: 100, y: 50 }, { x: 40, y: 80 }, 12, page)).toMatchObject({ x: 40, y: 50, w: 60 });
  });
});

describe('image placement', () => {
  it('is half the page wide at its natural aspect, centred on the point', () => {
    expect(defaultImageRect(2, { x: 100, y: 200 }, page)).toEqual({ x: 50, y: 175, w: 100, h: 50 });
  });

  it('a tall picture is limited by the page height', () => {
    const box = defaultImageRect(0.1, { x: 100, y: 200 }, page);
    expect(box.h).toBe(400);
    expect(box.w).toBeCloseTo(40);
  });

  it('is clamped into the page', () => {
    expect(defaultImageRect(1, { x: 0, y: 0 }, page)).toMatchObject({ x: 0, y: 0 });
  });

  it('a drag keeps the aspect or draws freely', () => {
    expect(imageRectFromDrag({ x: 10, y: 10 }, { x: 110, y: 20 }, 2, true, page)).toEqual({
      x: 10,
      y: 10,
      w: 100,
      h: 50,
    });
    expect(imageRectFromDrag({ x: 10, y: 10 }, { x: 110, y: 40 }, 2, false, page)).toEqual({
      x: 10,
      y: 10,
      w: 100,
      h: 30,
    });
  });
});

describe('moving and resizing', () => {
  const box = { x: 10, y: 10, w: 100, h: 50 };

  it('a move stays on the page', () => {
    expect(movedRect(box, -50, 500, page)).toEqual({ x: 0, y: 350, w: 100, h: 50 });
  });

  it('a text box only changes its width', () => {
    expect(resizedRect('textBox', box, 'e', 30, 99, true, page)).toEqual({ x: 10, y: 10, w: 130, h: 50 });
    expect(resizedRect('textBox', box, 'se', 30, 30, true, page)).toBe(box);
  });

  it('a corner of an image keeps its aspect when locked', () => {
    const next = resizedRect('image', box, 'se', 50, 0, true, page);
    expect(next.w / next.h).toBeCloseTo(2);
  });

  it('a side of an unlocked image is free', () => {
    expect(resizedRect('image', box, 's', 0, 20, false, page)).toEqual({ x: 10, y: 10, w: 100, h: 70 });
  });

  it('offers corners when locked and all eight handles when not', () => {
    expect(handlesFor('textBox', true)).toEqual(['w', 'e']);
    expect(handlesFor('image', true)).toHaveLength(4);
    expect(handlesFor('image', false)).toHaveLength(8);
  });

  it('places handles on the box', () => {
    expect(handleAt(box, 'nw')).toEqual({ x: 10, y: 10 });
    expect(handleAt(box, 'e')).toEqual({ x: 110, y: 35 });
  });
});

describe('arrow keys on rotated pages', () => {
  it('go the way they point on screen', () => {
    expect(viewDeltaToPage(1, 0, page, 0)).toEqual({ x: 1, y: 0 });
    // A quarter turn clockwise: screen right is page-space up.
    const turned = viewDeltaToPage(1, 0, page, 90);
    expect(turned.x).toBeCloseTo(0);
    expect(turned.y).toBeCloseTo(-1);
  });
});
