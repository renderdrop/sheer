// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { inkOutline, inkPaths, pathToD, type InkSample } from '../ink';
import { DrawPad } from './DrawPad';
import { PAD_WIDTH_PX, strokesToOutlines } from './model';

type Strokes = readonly (readonly InkSample[])[];

const seen: { strokes: Strokes } = { strokes: [] };

function Harness() {
  const [strokes, setStrokes] = useState<Strokes>([]);
  const update = (next: Strokes) => {
    seen.strokes = next;
    setStrokes(next);
  };
  return <DrawPad strokes={strokes} onStrokes={update} colour="black" initials={false} />;
}

const line = (y: number): [number, number][] => [
  [10, y],
  [60, y + 5],
  [120, y],
];

function draw(pad: HTMLElement, points: [number, number][], up = true) {
  const [first, ...rest] = points;
  if (first === undefined) return;
  fireEvent.pointerDown(pad, { pointerId: 1, button: 0, clientX: first[0], clientY: first[1] });
  for (const [x, y] of rest) fireEvent.pointerMove(pad, { pointerId: 1, clientX: x, clientY: y });
  if (up) fireEvent.pointerUp(pad, { pointerId: 1 });
}

describe('the draw pad', () => {
  it('keeps separate strokes separate, also when a pen-up never arrives', () => {
    render(<Harness />);
    const pad = screen.getByRole('img', { name: 'Signature pad' });
    draw(pad, line(10));
    draw(pad, line(100), false);
    // The second pen-up is lost; the next pen-down must close that stroke, not extend it.
    draw(pad, line(150));
    expect(seen.strokes).toHaveLength(3);
    expect(seen.strokes.map((stroke) => stroke.length)).toEqual([3, 3, 3]);
    const ys = seen.strokes.map((stroke) => stroke.map((sample) => sample.y));
    expect(Math.max(...(ys[0] ?? []))).toBeLessThan(20);
    expect(Math.min(...(ys[1] ?? []))).toBeGreaterThan(90);
  });

  it('renders the live stroke with the same outline function as the saved art', () => {
    const { container } = render(<Harness />);
    const pad = screen.getByRole('img', { name: 'Signature pad' });
    draw(pad, line(10), false);
    const paths = container.querySelectorAll('svg path');
    const liveD = paths[1]?.getAttribute('d') ?? '';
    expect(liveD).toContain('C');
    expect(liveD.startsWith('M')).toBe(true);
  });

  it('keeps the baseline guide out of the ink paths', () => {
    const { container } = render(<Harness />);
    const pad = screen.getByRole('img', { name: 'Signature pad' });
    draw(pad, line(10));
    const guide = container.querySelector('span[aria-hidden="true"].border-t');
    expect(guide).not.toBeNull();
    expect(guide?.closest('svg')).toBeNull();
    const [done, live] = Array.from(container.querySelectorAll('svg path'));
    expect(live?.getAttribute('d')).toBe('');
    // One filled outline for the one stroke, exactly what the exporter makes, and nothing else.
    expect(done?.getAttribute('d')).toBe(pathToD(strokesToOutlines(seen.strokes)));
    expect((done?.getAttribute('d') ?? '').match(/M/g)).toHaveLength(1);
  });
});

describe('the stroke model', () => {
  const stroke = (y: number): InkSample[] => line(y).map(([x, yy], i) => ({ x, y: yy, t: i * 16, pressure: 0.5 }));

  it('gives one subpath per stroke and none across the gap between them', () => {
    const paths = inkPaths([stroke(10), stroke(150)], PAD_WIDTH_PX);
    expect(paths).toHaveLength(2);
    for (const path of paths) expect(path.filter((cmd) => cmd[0] === 'M')).toHaveLength(1);
    const reach = (path: (typeof paths)[number]) =>
      path.flatMap((cmd) => (cmd.length === 1 ? [] : cmd.slice(1).filter((_, i) => i % 2 === 1))) as number[];
    expect(Math.max(...reach(paths[0] ?? []))).toBeLessThan(40);
    expect(Math.min(...reach(paths[1] ?? []))).toBeGreaterThan(120);
  });

  it('smooths with Béziers rather than straight segments', () => {
    const outline = inkOutline(stroke(10), PAD_WIDTH_PX);
    expect(outline.some((cmd) => cmd[0] === 'C')).toBe(true);
    expect(outline.some((cmd) => cmd[0] === 'L')).toBe(false);
  });
});
