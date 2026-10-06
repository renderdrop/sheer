import { describe, expect, it } from 'vitest';

import type { TextLineInfo } from '../../api/textEdit';
import { alignOf, distinctChars, familyFor, faceOf, growthOf, hitLine, overflowOf, textSpan } from './lines';

function line(i: number, box: [number, number, number, number], paragraph = 0): TextLineInfo {
  return {
    key: { rev: 0, line: i },
    text: `line ${i}`,
    box: { x: box[0], y: box[1], w: box[2], h: box[3] },
    paragraph,
    justified: false,
    font: { name: 'Helvetica', size: 10, embedded: true },
    editable: { type: 'same' },
  };
}

describe('hitLine', () => {
  const lines = [line(0, [50, 100, 100, 8]), line(1, [50, 112, 100, 8])];
  it('hits inside a box and gives small lines a padded hit area', () => {
    expect(hitLine(lines, { x: 60, y: 104 }, 1)?.key.line).toBe(0);
    // 24 px at scale 1 is 24 pt: 8 pt tall boxes grow by 8 pt on each side; the nearer centre wins
    expect(hitLine(lines, { x: 60, y: 109 }, 1)?.key.line).toBe(0);
    expect(hitLine(lines, { x: 60, y: 111 }, 1)?.key.line).toBe(1);
  });
  it('misses far away', () => {
    expect(hitLine(lines, { x: 400, y: 104 }, 1)).toBeNull();
    expect(hitLine(lines, { x: 60, y: 300 }, 1)).toBeNull();
  });
  it('does not pad at high zoom', () => {
    expect(hitLine(lines, { x: 60, y: 96 }, 10)).toBeNull();
  });
});

describe('growth', () => {
  it('lets a single line grow to the page edge less 12 pt', () => {
    const only = [line(0, [50, 100, 100, 8])];
    const g = growthOf(only, only[0] as TextLineInfo, 612);
    expect(g.align).toBe('left');
    expect(g.left).toBe(50);
    expect(g.right).toBe(600);
    expect(g.rule).toBeNull();
  });
  it('stops 4 pt before the next object on the baseline', () => {
    const lines = [line(0, [50, 100, 100, 8], 0), line(1, [300, 101, 50, 8], 1)];
    expect(growthOf(lines, lines[0] as TextLineInfo, 612).right).toBe(296);
  });
  it('caps a paragraph line at its widest line and draws a rule', () => {
    const lines = [line(0, [50, 100, 200, 8]), line(1, [50, 112, 120, 8])];
    const g = growthOf(lines, lines[1] as TextLineInfo, 612);
    expect(g.right).toBe(250);
    expect(g.rule).toEqual({ x: 44, y: 100, w: 2, h: 20 });
  });
  it('detects right and centred paragraphs', () => {
    const right = [line(0, [100, 100, 100, 8]), line(1, [140, 112, 60, 8])];
    expect(alignOf(right, right[1] as TextLineInfo)).toBe('right');
    const centre = [line(0, [100, 100, 100, 8]), line(1, [130, 112, 40, 8])];
    expect(alignOf(centre, centre[1] as TextLineInfo)).toBe('center');
  });
  it('measures overflow and the span of the text', () => {
    const only = [line(0, [50, 100, 100, 8])];
    const g = growthOf(only, only[0] as TextLineInfo, 200);
    expect(overflowOf(g, 120)).toBe(0);
    expect(overflowOf(g, 150)).toBe(12);
    expect(textSpan(g, (only[0] as TextLineInfo).box, 130)).toEqual({ left: 50, right: 180 });
  });
});

describe('fonts and characters', () => {
  it('maps names to the nearest family', () => {
    expect(familyFor('Times-Roman')).toBe('serif');
    expect(familyFor('CourierNew')).toBe('monospace');
    expect(familyFor('Helvetica-Bold')).toBe('sans-serif');
    expect(familyFor('Unknown')).toBe('sans-serif');
    expect(faceOf('Georgia')).toBe('serif');
    expect(faceOf('Consolas')).toBe('mono');
  });
  it('lists distinct non-space characters', () => {
    expect(distinctChars('a b a€')).toEqual(['a', 'b', '€']);
  });
});
