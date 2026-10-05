// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MorphStroke } from './MorphStroke';
import { easeOut, morphAt, shapePoints } from './morph';
import type { Morph } from './recognise';

const stroke = Array.from({ length: 64 }, (_, i) => ({ x: i, y: i % 2 }));
const morph: Morph = { from: stroke, to: { kind: 'line', from: { x: 0, y: 0 }, to: { x: 63, y: 0 } } };

describe('morph geometry', () => {
  it('samples a line, a rectangle and an ellipse with as many points as the stroke', () => {
    const near = { x: 0, y: 0 };
    expect(shapePoints(morph.to, 64, near)).toHaveLength(64);
    const rect = shapePoints({ kind: 'rect', box: { x: 0, y: 0, w: 10, h: 10 } }, 64, near);
    expect(rect).toHaveLength(64);
    expect(rect[0]).toEqual({ x: 0, y: 0 });
    expect(shapePoints({ kind: 'ellipse', box: { x: 0, y: 0, w: 10, h: 10 }, circle: true }, 64, near)).toHaveLength(
      64,
    );
  });

  it('runs from the stroke (0) to the shape (1) and eases out', () => {
    const target = shapePoints(morph.to, 64, { x: 0, y: 0 });
    expect(morphAt(stroke, target, 0)).toEqual(stroke);
    expect(morphAt(stroke, target, 1)[5]).toEqual(target[5]);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

describe('MorphStroke (DESIGN 3.9 Q5)', () => {
  beforeEach(() => {
    let now = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb((now += 100)), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const reduced = (on: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: on && query.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    }));

  it('interpolates and finishes exactly once', async () => {
    reduced(false);
    const onDone = vi.fn();
    const { container } = render(
      <svg>
        <MorphStroke morph={morph} color={[0, 0, 0]} width={2} onDone={onDone} />
      </svg>,
    );
    expect(container.querySelector('[data-morph]')).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is skipped with reduced motion: nothing drawn, done at once', () => {
    reduced(true);
    const onDone = vi.fn();
    const { container } = render(
      <svg>
        <MorphStroke morph={morph} color={[0, 0, 0]} width={2} onDone={onDone} />
      </svg>,
    );
    expect(container.querySelector('[data-morph]')).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
