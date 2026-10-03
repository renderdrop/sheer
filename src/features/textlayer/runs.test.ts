import { describe, expect, it } from 'vitest';

import { MAX_RUN_UNITS, buildRuns, runsOf } from './runs';

/** A layer of the given lines: 6 pt wide characters, 12 pt high, lines 14 pt apart, `\r\n` after each but the last. */
function layerOf(lines: readonly string[], gaps: Readonly<Record<string, number>> = {}) {
  let text = '';
  const boxes: number[] = [];
  lines.forEach((line, row) => {
    let x = 10;
    for (const char of line) {
      for (let unit = 0; unit < char.length; unit += 1) boxes.push(x, 20 + row * 14, 6, 12);
      x += 6 + (gaps[char] ?? 0);
      text += char;
    }
    if (row < lines.length - 1) {
      text += '\r\n';
      boxes.push(x, 20 + row * 14, 0, 0, x, 20 + row * 14, 0, 0);
    }
  });
  return { text, boxes: Float32Array.from(boxes) };
}

describe('buildRuns', () => {
  it('makes one run of a line, with its extent in page space', () => {
    const runs = buildRuns(layerOf(['Hello']));
    expect(runs).toEqual([{ start: 0, end: 5, text: 'Hello', x: 10, y: 20, w: 30, h: 12 }]);
  });

  it('breaks at a line break and leaves the break out of every run', () => {
    const runs = buildRuns(layerOf(['One', 'Two']));
    expect(runs.map((run) => [run.start, run.end, run.text])).toEqual([
      [0, 3, 'One'],
      [5, 8, 'Two'],
    ]);
    expect(runs[1]?.y).toBe(34);
  });

  it('starts a new run after a wide gap (a column) and where the line goes back', () => {
    const wide = buildRuns(layerOf(['ab-cd'], { '-': 40 }));
    expect(wide.map((run) => run.text)).toEqual(['ab-', 'cd']);
    // Same text, but the third character sits far to the left of the second.
    const back = { text: 'abc', boxes: Float32Array.from([50, 0, 6, 12, 56, 0, 6, 12, 10, 0, 6, 12]) };
    expect(buildRuns(back).map((run) => run.text)).toEqual(['ab', 'c']);
  });

  it('keeps the two code units of an emoji together', () => {
    const runs = buildRuns(layerOf(['a\u{1F600}b']));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.text).toBe('a\u{1F600}b');
    expect(runs[0]?.w).toBe(18);
  });

  it('drops runs of white space only, and gives a degenerate box a size', () => {
    expect(buildRuns(layerOf(['   ']))).toEqual([]);
    const flat = buildRuns({ text: 'x', boxes: Float32Array.from([5, 5, 0, 0]) });
    expect(flat[0]).toMatchObject({ w: 1, h: 1 });
  });

  it('cuts a very long line into runs of a bounded size', () => {
    const runs = buildRuns(layerOf(['x'.repeat(MAX_RUN_UNITS * 2 + 10)]));
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.end - run.start <= MAX_RUN_UNITS)).toBe(true);
  });

  it('remembers the runs of a layer', () => {
    const layer = { ...layerOf(['abc']), truncated: false };
    expect(runsOf(layer)).toBe(runsOf(layer));
  });
});
