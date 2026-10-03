import { describe, expect, it } from 'vitest';

import type { Quad } from '../../api/wire';
import { CONTEXT_CHARS, MAX_MATCH_CHARS, hitRange, snippetFor } from './snippet';

/** Lines of 6 pt wide characters, 12 pt high, lines 14 pt apart; `\r\n` between lines has no area. */
function layerOf(lines: readonly string[]) {
  let text = '';
  const boxes: number[] = [];
  lines.forEach((line, row) => {
    for (let i = 0; i < line.length; i += 1) boxes.push(10 + 6 * i, 20 + 14 * row, 6, 12);
    text += line;
    if (row < lines.length - 1) {
      text += '\r\n';
      boxes.push(10 + 6 * line.length, 20 + 14 * row, 0, 0, 10 + 6 * line.length, 20 + 14 * row, 0, 0);
    }
  });
  return { text, boxes: Float32Array.from(boxes) };
}

/** The quad around characters `from..to` (exclusive) of line `row`. */
function quadOf(row: number, from: number, to: number): Quad {
  const x0 = 10 + 6 * from;
  const x1 = 10 + 6 * to;
  const y0 = 20 + 14 * row;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y0 + 12 },
    { x: x1, y: y0 + 12 },
  ];
}

describe('hitRange', () => {
  it('finds the characters whose centre is inside the quad', () => {
    const layer = layerOf(['the quick brown fox']);
    expect(hitRange(layer, [quadOf(0, 4, 9)])).toEqual([4, 9]);
  });

  it('follows a hit over two lines and skips the break between them', () => {
    const layer = layerOf(['over the', 'lazy dog']);
    const range = hitRange(layer, [quadOf(0, 5, 8), quadOf(1, 0, 4)]);
    expect(layer.text.slice(...(range as [number, number]))).toBe('the\r\nlazy');
  });

  it('is null for a quad that covers no character', () => {
    expect(hitRange(layerOf(['abc']), [quadOf(5, 0, 3)])).toBeNull();
    expect(hitRange({ text: '', boxes: new Float32Array(0) }, [quadOf(0, 0, 1)])).toBeNull();
  });
});

describe('snippetFor', () => {
  it('splits the line around the match', () => {
    const layer = layerOf(['the quick brown fox']);
    expect(snippetFor(layer, [quadOf(0, 4, 9)])).toEqual({ before: 'the ', match: 'quick', after: ' brown fox' });
  });

  it('keeps at most the context on each side and flattens white space', () => {
    const long = `${'a'.repeat(100)}   NEEDLE   ${'b'.repeat(100)}`;
    const layer = layerOf([long]);
    const at = long.indexOf('NEEDLE');
    const snippet = snippetFor(layer, [quadOf(0, at, at + 6)]);
    expect(snippet?.match).toBe('NEEDLE');
    expect(snippet?.before.length).toBeLessThanOrEqual(CONTEXT_CHARS);
    expect(snippet?.after.length).toBeLessThanOrEqual(CONTEXT_CHARS);
    expect(snippet?.before.endsWith('a ')).toBe(true);
    expect(snippet?.before).not.toContain('  ');
  });

  it('cuts a very long match, and returns null when the hit cannot be placed', () => {
    const layer = layerOf(['x'.repeat(400)]);
    expect(snippetFor(layer, [quadOf(0, 0, 400)])?.match.length).toBeLessThanOrEqual(MAX_MATCH_CHARS);
    expect(snippetFor(layer, [quadOf(9, 0, 4)])).toBeNull();
  });

  it("keeps markup as text: it is the document's string, never HTML", () => {
    const layer = layerOf(['<img src=x onerror=1>']);
    expect(snippetFor(layer, [quadOf(0, 0, 4)])?.match).toBe('<img');
  });
});
