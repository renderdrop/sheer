import { describe, expect, it } from 'vitest';

import type { Point } from '../../../api/wire';
import { morphOf, recognise, resample, snapFor, snapTo } from './recognise';

/** A small seeded generator, so the sloppy fixtures are the same on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points along a polyline, every `step` points, with the given jitter (points). */
function along(corners: readonly Point[], step: number, jitter: number, rand: () => number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < corners.length; i += 1) {
    const a = corners[i - 1];
    const b = corners[i];
    if (a === undefined || b === undefined) continue;
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k += 1) {
      out.push({
        x: a.x + ((b.x - a.x) * k) / n + (rand() - 0.5) * 2 * jitter,
        y: a.y + ((b.y - a.y) * k) / n + (rand() - 0.5) * 2 * jitter,
      });
    }
  }
  return out;
}

/** An ellipse drawn from `from` to `to` (radians) with a wobbling radius. */
function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  wobble: number,
  rand: () => number,
): Point[] {
  const n = 90;
  const phase = rand() * 6;
  return Array.from({ length: n + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / n;
    const k = 1 + wobble * Math.sin(3 * angle + phase) + (rand() - 0.5) * wobble * 0.5;
    return { x: cx + rx * k * Math.cos(angle), y: cy + ry * k * Math.sin(angle) };
  });
}

const rectCorners = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];

const turn = (points: readonly Point[], degrees: number): Point[] => {
  const a = (degrees * Math.PI) / 180;
  return points.map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
};

describe('resample', () => {
  it('returns equally spaced points with the ends kept', () => {
    const out = resample(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      11,
    );
    expect(out).toHaveLength(11);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[5]?.x).toBeCloseTo(50);
    expect(out[10]?.x).toBeCloseTo(100);
  });

  it('copes with a path that does not move', () => {
    expect(resample([{ x: 3, y: 4 }], 5)).toHaveLength(5);
    expect(resample([], 5)).toEqual([]);
  });
});

describe('recognise: shapes', () => {
  it('takes a clean circle for a circle', () => {
    const shape = recognise(ellipsePath(200, 200, 60, 60, 0, 2 * Math.PI, 0, random(1)));
    expect(shape?.kind).toBe('ellipse');
    if (shape?.kind === 'ellipse') {
      expect(shape.circle).toBe(true);
      expect(shape.box.w).toBeCloseTo(120, -1);
      expect(shape.box.x + shape.box.w / 2).toBeCloseTo(200, -1);
    }
  });

  it.each([2, 3, 4, 5])('takes a sloppy circle (seed %i) that overshoots its start for a circle', (seed) => {
    const rand = random(seed);
    const shape = recognise(ellipsePath(300, 250, 45, 45, 0.5, 0.5 + 2 * Math.PI + 0.35, 0.06, rand));
    expect(shape?.kind).toBe('ellipse');
  });

  it('takes a circle that stops short of closing for a circle', () => {
    const shape = recognise(ellipsePath(100, 100, 50, 50, 0, 2 * Math.PI * 0.93, 0.03, random(7)));
    expect(shape?.kind).toBe('ellipse');
  });

  it('takes a wide ellipse for an ellipse that is not a circle', () => {
    const shape = recognise(ellipsePath(300, 200, 100, 50, 1, 1 + 2 * Math.PI, 0.03, random(8)));
    expect(shape?.kind).toBe('ellipse');
    if (shape?.kind === 'ellipse') {
      expect(shape.circle).toBe(false);
      expect(shape.box.w).toBeGreaterThan(1.7 * shape.box.h);
    }
  });

  it('takes the drawing of a rectangle for an axis-aligned rectangle', () => {
    const shape = recognise(along(rectCorners(100, 100, 160, 90), 6, 0.8, random(9)));
    expect(shape?.kind).toBe('rect');
    if (shape?.kind === 'rect') {
      expect(shape.box.w).toBeCloseTo(160, -1);
      expect(shape.box.h).toBeCloseTo(90, -1);
      expect(shape.box.x).toBeCloseTo(100, -1);
    }
  });

  it.each([11, 12, 13])(
    'takes a sloppy rectangle (seed %i, jitter, a gap and a small tilt) for a rectangle',
    (seed) => {
      const rand = random(seed);
      const corners = turn(rectCorners(0, 0, 140, 100), 6).map((p) => ({ x: p.x + 80, y: p.y + 80 }));
      // The stroke ends 10 pt short of where it began.
      corners[corners.length - 1] = { x: (corners[0]?.x ?? 0) + 6, y: (corners[0]?.y ?? 0) + 14 };
      const shape = recognise(along(corners, 5, 2.2, rand));
      expect(shape?.kind).toBe('rect');
    },
  );

  it('takes a square for a rectangle (not a circle)', () => {
    expect(recognise(along(rectCorners(50, 50, 100, 100), 5, 0.5, random(14)))?.kind).toBe('rect');
  });

  it('takes a straight stroke for a line, from its first to its last point', () => {
    const shape = recognise(
      along(
        [
          { x: 20, y: 30 },
          { x: 220, y: 90 },
        ],
        4,
        1.2,
        random(15),
      ),
    );
    expect(shape?.kind).toBe('line');
    if (shape?.kind === 'line') {
      expect(shape.from.x).toBeCloseTo(20, -1);
      expect(shape.to.x).toBeCloseTo(220, -1);
    }
  });

  it('takes a slightly bowed stroke for a line', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({ x: 10 + i * 5, y: 100 + Math.sin((i / 39) * Math.PI) * 6 }));
    expect(recognise(points)?.kind).toBe('line');
  });

  it('takes a line with a short hook at its end for an arrow with the tip at the end', () => {
    const shaft = along(
      [
        { x: 20, y: 100 },
        { x: 220, y: 100 },
      ],
      4,
      0.8,
      random(16),
    );
    // Back to 25 pt up-left, back to the tip, back to 25 pt down-left.
    const hook = along(
      [
        { x: 220, y: 100 },
        { x: 196, y: 88 },
        { x: 220, y: 100 },
        { x: 196, y: 112 },
      ],
      4,
      0.5,
      random(17),
    );
    const shape = recognise([...shaft, ...hook.slice(1)]);
    expect(shape?.kind).toBe('arrow');
    if (shape?.kind === 'arrow') {
      expect(shape.to.x).toBeCloseTo(220, -1);
      expect(shape.from.x).toBeCloseTo(20, -1);
    }
  });

  it('takes a hook drawn first for an arrow with the tip at the start', () => {
    const shaft = along(
      [
        { x: 20, y: 100 },
        { x: 220, y: 100 },
      ],
      4,
      0.8,
      random(18),
    );
    const hook = along(
      [
        { x: 44, y: 88 },
        { x: 20, y: 100 },
        { x: 44, y: 112 },
      ],
      4,
      0.5,
      random(19),
    );
    const shape = recognise([...hook, ...shaft.slice(1)]);
    expect(shape?.kind).toBe('arrow');
    if (shape?.kind === 'arrow') {
      expect(shape.to.x).toBeCloseTo(20, -1);
      expect(shape.from.x).toBeCloseTo(220, -1);
    }
  });
});

describe('recognise: it stays ink when unsure', () => {
  it('rejects a scribble, a zigzag, a wave and a spiral', () => {
    const rand = random(21);
    const scribble = Array.from({ length: 80 }, () => ({ x: rand() * 150, y: rand() * 150 }));
    const zigzag = along(
      [
        { x: 0, y: 0 },
        { x: 40, y: 60 },
        { x: 80, y: 0 },
        { x: 120, y: 60 },
        { x: 160, y: 0 },
      ],
      4,
      0.5,
      rand,
    );
    const wave = Array.from({ length: 80 }, (_, i) => ({ x: i * 3, y: Math.sin(i / 6) * 30 }));
    const spiral = Array.from({ length: 120 }, (_, i) => ({
      x: 100 + (10 + i * 0.5) * Math.cos(i / 8),
      y: 100 + (10 + i * 0.5) * Math.sin(i / 8),
    }));
    for (const stroke of [scribble, zigzag, wave, spiral]) expect(recognise(stroke)).toBeNull();
  });

  it('rejects a triangle, a half circle and an L', () => {
    const triangle = along(
      [
        { x: 100, y: 20 },
        { x: 180, y: 160 },
        { x: 20, y: 160 },
        { x: 100, y: 20 },
      ],
      5,
      0.5,
      random(22),
    );
    const half = ellipsePath(100, 100, 60, 60, 0, Math.PI, 0, random(23));
    const ell = along(
      [
        { x: 20, y: 20 },
        { x: 20, y: 120 },
        { x: 120, y: 120 },
      ],
      5,
      0.5,
      random(24),
    );
    for (const stroke of [triangle, half, ell]) expect(recognise(stroke)).toBeNull();
  });

  it('rejects a rectangle turned by 30 degrees and a very flat ellipse', () => {
    const turned = turn(along(rectCorners(0, 0, 140, 90), 5, 0.5, random(25)), 30).map((p) => ({
      x: p.x + 200,
      y: p.y + 100,
    }));
    expect(recognise(turned)).toBeNull();
    expect(recognise(ellipsePath(100, 100, 120, 5, 0, 2 * Math.PI, 0, random(26)))).toBeNull();
  });

  it('rejects an arrow whose hook is as long as its shaft, and a hook that goes on past the tip', () => {
    const shaft = along(
      [
        { x: 20, y: 100 },
        { x: 120, y: 100 },
      ],
      4,
      0.5,
      random(27),
    );
    const long = along(
      [
        { x: 120, y: 100 },
        { x: 60, y: 40 },
      ],
      4,
      0.5,
      random(28),
    );
    expect(recognise([...shaft, ...long.slice(1)])).toBeNull();
  });

  it('rejects a tap, a few points and a stroke that is too short', () => {
    expect(recognise([{ x: 5, y: 5 }])).toBeNull();
    expect(recognise(Array.from({ length: 20 }, (_, i) => ({ x: i * 0.3, y: 0 })))).toBeNull();
    expect(recognise(Array.from({ length: 5 }, (_, i) => ({ x: i * 50, y: 0 })))).toBeNull();
    expect(
      recognise([{ x: Number.NaN, y: 0 }, ...Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: 0 }))]),
    ).toBeNull();
  });
});

describe('recognise: an arrow drawn as shaft, arm out and back, other arm', () => {
  it('is an arrow whose tip is where the arms meet', () => {
    const shaft = Array.from({ length: 31 }, (_, i) => ({ x: 100 + i * 6, y: 500 }));
    const hook = [
      { x: 264, y: 484 },
      { x: 280, y: 500 },
      { x: 264, y: 516 },
    ];
    const shape = recognise([...shaft, ...hook]);
    expect(shape?.kind).toBe('arrow');
    if (shape?.kind === 'arrow') expect(shape.to.x).toBeGreaterThan(270);
  });
});

describe('snapFor and snapTo', () => {
  it('moves the end of a line that is nearer the pointer, and keeps the other', () => {
    const snap = snapFor({ kind: 'line', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }, { x: 99, y: 1 });
    expect(snapTo(snap, { x: 99, y: 1 }, { x: 150, y: 41 })).toEqual({
      kind: 'line',
      from: { x: 0, y: 0 },
      to: { x: 151, y: 40 },
    });
    // The pointer at the start: the start follows (an arrow drawn with its tip first).
    const back = snapFor({ kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }, { x: 2, y: 0 });
    expect(snapTo(back, { x: 2, y: 0 }, { x: -18, y: 0 })).toEqual({
      kind: 'arrow',
      from: { x: -20, y: 0 },
      to: { x: 100, y: 0 },
    });
  });

  it('moves the corner of a box that is nearest the pointer and keeps the opposite one', () => {
    const snap = snapFor({ kind: 'rect', box: { x: 10, y: 20, w: 100, h: 50 } }, { x: 108, y: 72 });
    expect(snapTo(snap, { x: 108, y: 72 }, { x: 208, y: 22 })).toEqual({
      kind: 'rect',
      box: { x: 10, y: 20, w: 200, h: 0 },
    });
    // Past the opposite corner the box turns over.
    expect(snapTo(snap, { x: 108, y: 72 }, { x: 0, y: 0 })).toEqual({
      kind: 'rect',
      box: { x: 2, y: -2, w: 8, h: 22 },
    });
  });
});

describe('recognise: F17.5 sample strokes', () => {
  const at = (points: Point[], dx: number, dy: number): Point[] => points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  const kindOf = (points: Point[]): string | null => {
    const shape = recognise(points);
    if (shape === null) return null;
    if (shape.kind === 'rect') return 'rectangle';
    return shape.kind === 'ellipse' ? (shape.circle ? 'circle' : 'ellipse') : shape.kind;
  };

  const positives: [string, string, Point[]][] = [
    ['circle', 'circle', ellipsePath(150, 150, 50, 50, 0, 2 * Math.PI, 0.02, random(101))],
    ['circle', 'circle slow sampling', ellipsePath(150, 150, 30, 30, 1, 1 + 2 * Math.PI + 0.2, 0.04, random(102))],
    ['circle', 'circle big', ellipsePath(400, 300, 140, 140, 2, 2 + 2 * Math.PI, 0.03, random(103))],
    ['ellipse', 'wide ellipse', ellipsePath(200, 150, 90, 45, 0, 2 * Math.PI, 0.02, random(104))],
    ['ellipse', 'tall ellipse', ellipsePath(200, 150, 40, 80, 3, 3 + 2 * Math.PI, 0.02, random(105))],
    ['ellipse', 'ellipse overshoot', ellipsePath(200, 150, 100, 60, 0, 2 * Math.PI + 0.3, 0.03, random(106))],
    ['rectangle', 'rect clean', along(rectCorners(50, 50, 150, 80), 4, 0.3, random(107))],
    ['rectangle', 'rect fast sampling', along(rectCorners(50, 50, 150, 80), 25, 1, random(108))],
    ['rectangle', 'rect tilt 5', at(turn(along(rectCorners(0, 0, 140, 90), 5, 1, random(109)), 5), 150, 40)],
    ['rectangle', 'rect tilt -9', at(turn(along(rectCorners(0, 0, 140, 90), 5, 1, random(110)), -9), 150, 100)],
    ['rectangle', 'rect tilt 11', at(turn(along(rectCorners(0, 0, 200, 60), 5, 1, random(111)), 11), 100, 40)],
    ['rectangle', 'square', along(rectCorners(20, 20, 90, 90), 5, 1, random(112))],
    [
      'line',
      'line horizontal',
      along(
        [
          { x: 10, y: 50 },
          { x: 210, y: 50 },
        ],
        3,
        1,
        random(113),
      ),
    ],
    [
      'line',
      'line diagonal',
      along(
        [
          { x: 10, y: 10 },
          { x: 190, y: 160 },
        ],
        6,
        1.5,
        random(114),
      ),
    ],
    [
      'line',
      'line fast',
      along(
        [
          { x: 300, y: 20 },
          { x: 40, y: 120 },
        ],
        40,
        1,
        random(115),
      ),
    ],
    [
      'line',
      'line vertical',
      along(
        [
          { x: 90, y: 10 },
          { x: 95, y: 220 },
        ],
        5,
        1,
        random(116),
      ),
    ],
    [
      'arrow',
      'arrow right',
      [
        ...along(
          [
            { x: 20, y: 100 },
            { x: 220, y: 100 },
          ],
          4,
          0.6,
          random(117),
        ),
        ...along(
          [
            { x: 220, y: 100 },
            { x: 196, y: 88 },
            { x: 220, y: 100 },
            { x: 196, y: 112 },
          ],
          4,
          0.4,
          random(118),
        ).slice(1),
      ],
    ],
    [
      'arrow',
      'arrow down',
      [
        ...along(
          [
            { x: 100, y: 20 },
            { x: 100, y: 200 },
          ],
          4,
          0.6,
          random(119),
        ),
        ...along(
          [
            { x: 100, y: 200 },
            { x: 88, y: 176 },
            { x: 100, y: 200 },
            { x: 112, y: 176 },
          ],
          4,
          0.4,
          random(120),
        ).slice(1),
      ],
    ],
    [
      'arrow',
      'arrow diagonal',
      (() => {
        const base = [
          ...along(
            [
              { x: 0, y: 0 },
              { x: 200, y: 0 },
            ],
            4,
            0.6,
            random(121),
          ),
          ...along(
            [
              { x: 200, y: 0 },
              { x: 176, y: -12 },
              { x: 200, y: 0 },
              { x: 176, y: 12 },
            ],
            4,
            0.4,
            random(122),
          ).slice(1),
        ];
        return at(turn(base, 35), 60, 40);
      })(),
    ],
  ];
  it.each(positives)('takes a %s: %s', (kind, _name, stroke) => {
    expect(kindOf(stroke)).toBe(kind);
  });

  const handwriting: Point[] = Array.from({ length: 160 }, (_, i) => {
    const t = i / 8;
    return { x: 10 + i * 1.6 + 8 * Math.cos(t * 2), y: 60 + 14 * Math.sin(t * 2.0) + 6 * Math.sin(t * 5.3) };
  });
  const negatives: [string, Point[]][] = [
    [
      'scribble',
      (() => {
        const r = random(131);
        return Array.from({ length: 90 }, () => ({ x: r() * 160, y: r() * 120 }));
      })(),
    ],
    [
      'zigzag',
      along(
        [
          { x: 0, y: 0 },
          { x: 30, y: 70 },
          { x: 60, y: 0 },
          { x: 90, y: 70 },
          { x: 120, y: 0 },
        ],
        4,
        0.5,
        random(132),
      ),
    ],
    ['open arc', ellipsePath(100, 100, 60, 60, 0, Math.PI * 1.3, 0.01, random(133))],
    [
      'spiral',
      Array.from({ length: 140 }, (_, i) => ({
        x: 100 + (6 + i * 0.5) * Math.cos(i / 9),
        y: 100 + (6 + i * 0.5) * Math.sin(i / 9),
      })),
    ],
    ['handwriting', handwriting],
    ['rect turned 25', at(turn(along(rectCorners(0, 0, 140, 90), 5, 0.5, random(134)), 25), 200, 100)],
  ];
  it.each(negatives)('leaves %s as ink', (_name, stroke) => {
    expect(recognise(stroke)).toBeNull();
  });

  it('is deterministic and gives morph data from the resampled stroke to the shape', () => {
    const stroke = ellipsePath(150, 150, 50, 50, 0, 2 * Math.PI, 0.02, random(101));
    const shape = recognise(stroke);
    expect(recognise(stroke)).toEqual(shape);
    if (shape === null) throw new Error('expected a shape');
    const morph = morphOf(stroke, shape);
    expect(morph.from).toHaveLength(64);
    expect(morph.to).toBe(shape);
  });
});

describe('recognise: F17 acceptance, direction and tilt', () => {
  const shaftTo = (x0: number, x1: number, seed: number): Point[] =>
    along(
      [
        { x: x0, y: 100 },
        { x: x1, y: 100 },
      ],
      4,
      0.5,
      random(seed),
    );
  const tilted = (degrees: number): Point[] =>
    turn(rectCorners(0, 0, 160, 90), degrees).map((p) => ({ x: p.x + 100, y: p.y + 100 }));

  it('takes an arrow drawn right to left for an arrow whose tip is on the left', () => {
    const hook = along(
      [
        { x: 20, y: 100 },
        { x: 44, y: 88 },
        { x: 20, y: 100 },
        { x: 44, y: 112 },
      ],
      4,
      0.4,
      random(202),
    );
    const shape = recognise([...shaftTo(220, 20, 201), ...hook.slice(1)]);
    expect(shape?.kind).toBe('arrow');
    if (shape?.kind === 'arrow') {
      expect(shape.to.x).toBeCloseTo(20, -1);
      expect(shape.from.x).toBeCloseTo(220, -1);
    }
  });

  it('takes a plain stroke drawn right to left for a line, not an arrow', () => {
    const shape = recognise(shaftTo(220, 20, 203));
    expect(shape?.kind).toBe('line');
    if (shape?.kind === 'line') expect(shape.from.x).toBeGreaterThan(shape.to.x);
  });

  it('does not take a right-to-left arrow whose hook is as long as the shaft for an arrow', () => {
    const hook = along(
      [
        { x: 20, y: 100 },
        { x: 120, y: 40 },
        { x: 20, y: 100 },
        { x: 120, y: 160 },
      ],
      4,
      0.4,
      random(205),
    );
    expect(recognise([...shaftTo(220, 20, 204), ...hook.slice(1)])?.kind).not.toBe('arrow');
  });

  it('takes a rectangle turned by 10 degrees for a rectangle of about its size', () => {
    const shape = recognise(along(tilted(10), 5, 0.6, random(206)));
    expect(shape?.kind).toBe('rect');
    if (shape?.kind === 'rect') {
      expect(shape.box.w).toBeGreaterThan(150);
      expect(shape.box.h).toBeGreaterThan(80);
    }
  });

  it('takes the same rectangle turned the other way (-10 degrees) for a rectangle too', () => {
    expect(recognise(along(tilted(-10), 5, 0.6, random(207)))?.kind).toBe('rect');
  });

  it('does not take a rectangle turned by 35 degrees for an axis-aligned rectangle', () => {
    expect(recognise(along(tilted(35), 5, 0.6, random(208)))?.kind).not.toBe('rect');
  });
});
