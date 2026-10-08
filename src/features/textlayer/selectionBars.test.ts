import { describe, expect, it } from 'vitest';

import { closeLineGaps, selectionBars } from './selectionBars';

/** A layer of single-character words laid out as `lines`, each `[y, height, x of the first char, count]`, 10 pt per char. */
function layerOf(lines: [number, number, number, number][]) {
  let text = '';
  const boxes: number[] = [];
  for (const [y, h, x0, n] of lines) {
    for (let i = 0; i < n; i += 1) {
      text += 'a';
      boxes.push(x0 + i * 10, y, 10, h);
    }
  }
  return { text, boxes: Float32Array.from(boxes) };
}

describe('selectionBars', () => {
  it('draws one bar per line, merged across word gaps', () => {
    const layer = layerOf([
      [0, 10, 0, 3],
      [12, 10, 0, 3],
    ]);
    const bars = selectionBars(layer, 0, 6);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ x: 0, w: 30 });
  });

  it('closes the gap and the overlap between adjacent lines', () => {
    const bars = selectionBars(
      layerOf([
        [0, 10, 0, 3],
        [12, 10, 0, 3],
        [20, 10, 0, 3],
      ]),
      0,
      9,
    );
    expect(bars).toHaveLength(3);
    for (let i = 0; i + 1 < bars.length; i += 1) {
      const a = bars[i];
      const b = bars[i + 1];
      expect((a?.y ?? 0) + (a?.h ?? 0)).toBeCloseTo(b?.y ?? -1);
    }
  });

  it('keeps mixed font sizes on their lines and leaves a paragraph break open', () => {
    const bars = selectionBars(
      layerOf([
        [0, 20, 0, 3],
        [22, 8, 0, 3],
        [80, 8, 0, 3],
      ]),
      0,
      9,
    );
    expect(bars).toHaveLength(3);
    expect(bars[0]?.h).toBeGreaterThan(bars[1]?.h ?? 100);
    expect(bars[2]).toMatchObject({ y: 80, h: 8 });
  });

  it('covers only the selected part of a line', () => {
    const bars = selectionBars(layerOf([[0, 10, 0, 6]]), 2, 4);
    expect(bars).toEqual([{ x: 20, y: 0, w: 20, h: 10 }]);
  });

  it('does not join bars side by side (columns)', () => {
    expect(
      closeLineGaps([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 50, y: 12, w: 10, h: 10 },
      ])[1]?.y,
    ).toBe(12);
  });
});
