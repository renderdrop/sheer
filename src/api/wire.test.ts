import { describe, expect, it } from 'vitest';

import { MAX_COORDINATE_PT, isCoordinate, isExtent, isUint, parsePoint, parseQuad, parseRect } from './wire';

describe('number checks', () => {
  it('takes whole numbers from 0 to the bound and nothing else as an id or a count', () => {
    for (const good of [0, 1, 42, 0xffff_ffff]) expect(isUint(good), String(good)).toBe(true);
    for (const bad of [-1, 1.5, 0xffff_ffff + 1, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined, [], {}]) {
      expect(isUint(bad), String(bad)).toBe(false);
    }
    expect(isUint(10, 10)).toBe(true);
    expect(isUint(11, 10)).toBe(false);
  });

  it('takes finite numbers within +-14 400 pt as coordinates, and not negative ones as sizes', () => {
    for (const good of [0, -0.5, 612, MAX_COORDINATE_PT, -MAX_COORDINATE_PT]) expect(isCoordinate(good)).toBe(true);
    for (const bad of [MAX_COORDINATE_PT + 0.01, Number.NaN, Number.NEGATIVE_INFINITY, '5', null]) {
      expect(isCoordinate(bad), String(bad)).toBe(false);
    }
    expect(isExtent(0)).toBe(true);
    expect(isExtent(-0.01)).toBe(false);
  });
});

describe('page space shapes', () => {
  it('reads a point and drops what is not part of it', () => {
    expect(parsePoint({ x: 1, y: 2.5 })).toStrictEqual({ x: 1, y: 2.5 });
    expect(parsePoint({ x: 1, y: 2, z: 3, path: 'C:\\x' })).toStrictEqual({ x: 1, y: 2 });
    for (const bad of [null, [], 'p', { x: 1 }, { x: '1', y: 2 }, { x: Number.NaN, y: 0 }, { x: 0, y: 20_000 }]) {
      expect(parsePoint(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads a rectangle whose size is not negative', () => {
    expect(parseRect({ x: 1, y: 2, w: 3, h: 4 })).toStrictEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(parseRect({ x: 1, y: 2, w: 0, h: 0 })).not.toBeNull();
    for (const bad of [null, { x: 1, y: 2, w: -1, h: 4 }, { x: 1, y: 2, w: 3 }, { x: 1, y: 2, w: 3, h: Number.NaN }]) {
      expect(parseRect(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads a quad of four points, in order', () => {
    const point = (x: number, y: number) => ({ x, y });
    const quad = [point(1, 2), point(3, 2), point(1, 4), point(3, 4)];
    expect(parseQuad(quad)).toStrictEqual(quad);
    for (const bad of [null, [], quad.slice(0, 3), [...quad, point(0, 0)], [...quad.slice(0, 3), { x: 1 }], 'quad']) {
      expect(parseQuad(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
