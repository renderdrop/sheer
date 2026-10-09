/**
 * The hover motion of every icon (F22.6, ADR-146 addendum 2): a catalogue keyed by the Lucide icon id, built from a few
 * families, and the player that turns an entry into Web Animations on the svg's own elements.
 *
 * Geometry: the stroke width is set in user units per icon size (tokens `--icon-stroke-<size>`), so `getTotalLength()` and
 * the dash lengths are exact in every engine. Transforms are in the 24-unit view box (CSS px on an svg element are user
 * units). Every animation starts and ends in the rest state; nothing is filled forwards or left inline.
 */
import { tokenMs } from './glide';

/** `--ease-draw`, the pen (ease-in-out); tokens.test.ts watches the token. */
export const EASE_DRAW = 'cubic-bezier(0.65, 0, 0.35, 1)';
/** `--motion-icon` without the stylesheet. */
export const MOTION_ICON_MS = 900;
/** `--icon-stroke`: the stroke on screen, at every size. */
export const STROKE_PX = 1.75;
/** Strokes shorter than this on screen (px) are dots: they fade in their turn instead of drawing. */
export const DOT_PX = 3;
/** Lucide's view box. */
const VIEW = 24;
/** Inside one draw track each element starts when the one before is this share drawn. */
const OVERLAP = 0.85;
/** The least weight an element of a draw track gets (against its length share). */
const FLOOR = 0.3;

export type Family =
  'spin' | 'nudge' | 'swing' | 'lid' | 'snip' | 'orbit' | 'press' | 'part' | 'rise' | 'sequence' | 'trace';

/** Per-family duration factor on `--motion-icon` (0.8–1.1 s at the 900 ms base). */
export const FAMILY_FACTOR: Record<Family, number> = {
  spin: 1.15,
  nudge: 0.9,
  swing: 1.2,
  lid: 1.05,
  snip: 1.1,
  orbit: 1.2,
  press: 0.95,
  part: 1,
  rise: 1.05,
  sequence: 1.1,
  trace: 1.2,
};

/** Element indexes in document order of the svg's geometry (path, line, circle, rect, …). */
type Targets = readonly number[] | 'all';
/** A transform origin: a point of the view box, or a CSS position inside the element's own box (`transform-box: fill-box`). */
export type Origin = readonly [number, number] | string;

/** One pose of a move: translation in view-box units, rotation in degrees, opacity. Missing values are the rest values. */
export interface Pose {
  at: number;
  x?: number;
  y?: number;
  r?: number;
  o?: number;
}

export interface MoveTrack {
  kind: 'move';
  el: Targets;
  poses: readonly Pose[];
  origin?: Origin;
  /** Share of the total when the track starts and ends. */
  from?: number;
  to?: number;
  /** One curve over the whole track instead of the pen between every pose (a round orbit). */
  smooth?: boolean;
}

export interface DrawTrack {
  kind: 'draw';
  /** Drawn completely one after the other in this order; `longest` is every element, longest first. */
  el: readonly number[] | 'longest';
  /** Elements drawn from their end (a line whose path runs against the writing direction). */
  reverse?: readonly number[];
  from?: number;
  to?: number;
}

export type Track = MoveTrack | DrawTrack;

export interface Motion {
  family: Family;
  tracks: readonly Track[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Primitives

const CENTRE: Origin = [12, 12];
const span = (track: Track, from: number, to: number): Track => ({ ...track, from, to });
const scaled = (poses: readonly Pose[], x: number, y: number): Pose[] =>
  poses.map(({ at, x: px = 0, y: py = 0 }) => ({ at, x: px * x, y: py * y }));

/** A full turn (a multiple of 360°) with a small wind-up, or with `back` a turn to `deg` and home again. */
export function spinTrack(deg: number, opts: { el?: Targets; origin?: Origin; back?: boolean } = {}): MoveTrack {
  const { el = 'all', origin = CENTRE, back = false } = opts;
  const sign = Math.sign(deg) || 1;
  const poses: Pose[] = back
    ? [
        { at: 0.45, r: deg },
        { at: 0.75, r: -deg * 0.12 },
        { at: 1, r: 0 },
      ]
    : [
        { at: 0.12, r: -sign * 10 },
        { at: 1, r: deg },
      ];
  return { kind: 'move', el, poses, origin };
}

/** A push along (x, y) and back with a small rebound. */
export function nudgeTrack(el: Targets, x: number, y: number): MoveTrack {
  const poses = scaled(
    [
      { at: 0.4, x: 1, y: 1 },
      { at: 0.68, x: -0.18, y: -0.18 },
      { at: 0.86, x: 0.08, y: 0.08 },
    ],
    x,
    y,
  );
  return { kind: 'move', el, poses };
}

/** A damped swing about `origin`; `shift` adds a sideways write-wiggle. */
export function swingTrack(el: Targets, origin: Origin, deg: number, shift = 0): MoveTrack {
  const poses: Pose[] = [
    { at: 0.2, r: deg, x: shift },
    { at: 0.44, r: -deg * 0.7, x: -shift },
    { at: 0.66, r: deg * 0.4, x: shift * 0.5 },
    { at: 0.84, r: -deg * 0.15 },
  ];
  return { kind: 'move', el, poses, origin };
}

/** A lid lifts by `lift`, tilts by `tilt` about its hinge, and settles with a small bounce. */
export function lidTrack(el: Targets, hinge: Origin, lift: number, tilt: number): MoveTrack {
  const poses: Pose[] = [
    { at: 0.3, y: -lift, r: tilt },
    { at: 0.55, y: -lift, r: tilt * 0.6 },
    { at: 0.8, y: 0.3, r: 0 },
    { at: 0.9, y: -0.15 },
  ];
  return { kind: 'move', el, poses, origin: hinge };
}

/** Two blades close twice about the pivot. */
export function snipTracks(a: Targets, b: Targets, pivot: Origin, deg: number): MoveTrack[] {
  const close = (sign: number): Pose[] => [
    { at: 0.2, r: sign * deg },
    { at: 0.4, r: 0 },
    { at: 0.62, r: sign * deg },
    { at: 0.84, r: 0 },
  ];
  return [
    { kind: 'move', el: a, poses: close(1), origin: pivot },
    { kind: 'move', el: b, poses: close(-1), origin: pivot },
  ];
}

/** One round of a small circle (a lens looking about); `dir` -1 runs counter-clockwise. */
export function orbitTrack(el: Targets, radius: number, dir: 1 | -1 = 1): MoveTrack {
  const steps = 16;
  const poses: Pose[] = [];
  for (let k = 1; k < steps; k += 1) {
    const angle = (2 * Math.PI * k) / steps;
    poses.push({ at: k / steps, x: dir * radius * Math.sin(angle), y: radius * (Math.cos(angle) - 1) });
  }
  return { kind: 'move', el, poses, smooth: true };
}

/** A push down (or along (x, y)), a short hold, back with a tiny lift. */
export function pressTrack(el: Targets, x: number, y: number): MoveTrack {
  const poses = scaled(
    [
      { at: 0.3, x: 1, y: 1 },
      { at: 0.55, x: 1, y: 1 },
      { at: 0.78, x: -0.15, y: -0.15 },
    ],
    x,
    y,
  );
  return { kind: 'move', el, poses };
}

/** Elements move apart along their own vectors, hold, and come back. */
export function partTracks(moves: readonly (readonly [Targets, number, number])[]): MoveTrack[] {
  return moves.map(([el, x, y]) => ({
    kind: 'move',
    el,
    poses: scaled(
      [
        { at: 0.35, x: 1, y: 1 },
        { at: 0.62, x: 1, y: 1 },
      ],
      x,
      y,
    ),
  }));
}

/** Elements rise into place from below, one after the other (`stagger` share apart). */
export function riseTracks(
  els: readonly number[],
  opts: { depth?: number; stagger?: number; from?: number } = {},
): MoveTrack[] {
  const { depth = 4, stagger = 0.15, from = 0 } = opts;
  const length = Math.max(0.4, 1 - from - stagger * (els.length - 1));
  return els.map((el, at) => ({
    kind: 'move',
    el: [el],
    poses: [
      { at: 0, y: depth, o: 0 },
      { at: 0.7, y: -0.5, o: 1 },
    ],
    from: from + at * stagger,
    to: Math.min(1, from + at * stagger + length),
  }));
}

export function drawTrack(el: readonly number[] | 'longest', reverse?: readonly number[]): DrawTrack {
  return reverse === undefined ? { kind: 'draw', el } : { kind: 'draw', el, reverse };
}

// Entry builders, one per family. Owner F22: motions must read at 16-20 px, so moves and turns get a common gain.
const MOVE_GAIN = 1.6;
const TURN_GAIN = 1.6;
const spin = (deg: number, opts?: Parameters<typeof spinTrack>[1]): Motion => ({
  family: 'spin',
  tracks: [spinTrack(deg, opts)],
});
const nudge = (...moves: (readonly [Targets, number, number])[]): Motion => ({
  family: 'nudge',
  tracks: moves.map(([el, x, y]) => nudgeTrack(el, x * MOVE_GAIN, y * MOVE_GAIN)),
});
const swing = (el: Targets, origin: Origin, deg: number, shift = 0, ...extra: Track[]): Motion => ({
  family: 'swing',
  tracks: [swingTrack(el, origin, deg * TURN_GAIN, shift * MOVE_GAIN), ...extra],
});
const press = (el: Targets, x: number, y: number): Motion => ({
  family: 'press',
  tracks: [pressTrack(el, x * MOVE_GAIN, y * MOVE_GAIN)],
});
const part = (...moves: (readonly [Targets, number, number])[]): Motion => ({
  family: 'part',
  tracks: partTracks(moves.map(([el, x, y]) => [el, x * MOVE_GAIN, y * MOVE_GAIN] as const)),
});
const orbit = (el: Targets, radius = 1.5, dir: 1 | -1 = 1): Motion => ({
  family: 'orbit',
  tracks: [orbitTrack(el, radius * MOVE_GAIN, dir)],
});
const rise = (els: readonly number[], ...extra: Track[]): Motion => ({
  family: 'rise',
  tracks: [...riseTracks(els), ...extra],
});
const sequence = (order: readonly number[], reverse?: readonly number[]): Motion => ({
  family: 'sequence',
  tracks: [drawTrack(order, reverse)],
});

/** The fallback: every element drawn completely, one after the other, longest first. */
export const TRACE: Motion = { family: 'trace', tracks: [drawTrack('longest')] };

const CORNERS_OUT: (readonly [Targets, number, number])[] = [
  [[0], -1, -1],
  [[1], 1, -1],
  [[2], 1, 1],
  [[3], -1, 1],
];

// ---------------------------------------------------------------------------------------------------------------------
// The catalogue, keyed by the canonical Lucide id (the first `lucide-<id>` class on the svg). Indexes follow the elements
// in Lucide's order (lucide-react 1.50).

export const CATALOGUE: Readonly<Record<string, Motion>> = {
  // Arrows and chevrons: a push along their direction.
  'arrow-down-up': nudge([[0, 1], 0, 2.5], [[2, 3], 0, -2.5]),
  'arrow-left': nudge(['all', -2.5, 0]),
  'arrow-right-left': nudge([[0, 1], 2.5, 0], [[2, 3], -2.5, 0]),
  'chevron-down': nudge(['all', 0, 2.5]),
  'chevron-left': nudge(['all', -2.5, 0]),
  'chevron-right': nudge(['all', 2.5, 0]),
  'chevron-up': nudge(['all', 0, -2.5]),
  'chevrons-down-up': nudge([[0], 0, -2], [[1], 0, 2]),
  download: nudge([[0, 2], 0, 2.5]),
  'external-link': nudge([[0, 1], 2, -2]),
  'file-down': nudge([[2, 3], 0, 2.5]),
  'file-output': nudge([[2, 3], -2.5, 0]),
  'file-up': nudge([[2, 3], 0, -2.5]),
  'move-up-right': nudge(['all', 2, -2]),
  printer: nudge([[2], 0, 2.5]),
  'grip-vertical': nudge(['all', 0, -2]),
  'gallery-vertical': nudge([[1], 0, -2]),
  'book-bookmark': nudge([[0], 0, 2.5]),
  'settings-2': nudge([[2], -4, 0], [[3], 4, 0]),
  'text-cursor-input': nudge([[0, 3, 4], 2.5, 0]),

  // Turning things.
  'rotate-cw': spin(360),
  'rotate-ccw': spin(-360),
  'rotate-ccw-clock': spin(-360),
  'undo-2': spin(-40, { origin: [14.5, 14.5], back: true }),
  'redo-2': spin(40, { origin: [9.5, 14.5], back: true }),
  settings: spin(360),
  'life-buoy': spin(360),
  'loader-circle': spin(360),
  clock: spin(360, { el: [1] }),

  // Swings: hands, bells, pens writing.
  hand: swing('all', [12, 22], 12),
  highlighter: swing('all', [4, 20], 8, 1),
  pencil: swing('all', [2.5, 21.5], 8, 1),
  'pen-line': swing([1], [2.5, 21.5], 9, 0.8, span(drawTrack([0]), 0.35, 1)),
  'pen-tool': swing('all', [2.5, 2.5], 10),
  'square-pen': swing([1], [9, 15], 12, 0.6),
  'file-pen-line': swing([0], [13.5, 17.5], 12, 0.6, span(drawTrack([3]), 0.5, 1)),
  eraser: swing('all', [12, 21], 6, 1.5),
  'sticky-note': swing('all', [12, 3], 6),
  'message-square': swing('all', [2, 21], 7),
  wrench: swing('all', [4, 20], 18),
  star: swing('all', CENTRE, 15),
  tag: swing('all', [7.5, 7.5], 12),
  'thumbs-up': swing('all', [4, 22], -12),
  compass: swing([1], CENTRE, 40),
  'key-round': swing('all', [16.5, 7.5], 25),
  'file-key': swing([1, 2, 4], [4, 20], 25),
  lightbulb: swing('all', [12, 2], 6, 0, span(drawTrack([1, 2]), 0.3, 0.9)),
  'paint-bucket': swing([0, 1, 3], [6, 2], -12, 0, ...riseTracks([2], { depth: -3, from: 0.35 })),
  wand: swing([7], [3, 21], 14, 0, span(drawTrack([0, 6, 3, 4, 1, 2, 8, 5]), 0.25, 1)),

  // Lids.
  trash: { family: 'lid', tracks: [lidTrack([3, 4], [3, 6], 2.5, -14)] },
  'folder-open': { family: 'lid', tracks: [lidTrack('all', [2, 20], 1, -8)] },

  // Scissors.
  scissors: { family: 'snip', tracks: snipTracks([0, 1, 4], [2, 3], [12, 12], 9) },

  // Lenses looking about.
  search: orbit('all'),
  'zoom-in': orbit('all'),
  'zoom-out': orbit('all', 1.5, -1),
  'scan-search': orbit([4, 5]),
  eye: orbit([1], 1.5),

  // Presses.
  stamp: press([0, 1], 0, 2.5),
  'mouse-pointer-2': press('all', -1.5, -1.5),
  save: press('all', 0, 2),
  'save-all': press([1, 3], -1.5, 1.5),

  // Parting.
  lock: part([[1], 0, -2.5]),
  crop: part([[0], -1.5, 1.5], [[1], 1.5, -1.5]),
  copy: part([[0], 1.5, 1.5], [[1], -1, -1]),
  files: part([[0, 1], 1, -1], [[2], -1, 1]),
  combine: part([[4], -1.5, -1.5], [[5], 1.5, 1.5]),
  'layout-grid': part(...CORNERS_OUT),
  'scan-eye': part(...CORNERS_OUT),
  'maximize-2': part([[0, 1], 1.5, -1.5], [[2, 3], -1.5, 1.5]),
  'messages-square': part([[0], -1, -1], [[1], 1, 1]),
  shapes: part([[0], 0, -1.5], [[1], -1.5, 1.5], [[2], 1.5, 1.5]),
  percent: part([[1], -1.5, -1.5], [[2], 1.5, 1.5]),
  pause: part([[0], 1.5, 0], [[1], -1.5, 0]),
  'stretch-horizontal': part([[0], 0, -1.5], [[1], 0, 1.5]),
  'rows-2': part([[1], 0, 3]),
  'panel-left': part([[1], -2.5, 0]),
  'panel-right': part([[1], 2.5, 0]),
  'panel-top': part([[1], 0, -2.5]),
  calendar: part([[0, 1], 0, -2]),

  // Rising.
  image: rise([1], span(drawTrack([2]), 0, 0.6)),
  'image-plus': rise([4], span(drawTrack([1, 0]), 0.3, 1)),
  'file-image': rise([2], span(drawTrack([3]), 0, 0.6)),
  images: rise([2], ...partTracks([[[1], -1, 1]])),
  house: rise([0]),
  quote: rise([1, 0]),
  'message-square-quote': rise([2, 0]),
  ellipsis: { family: 'rise', tracks: riseTracks([2, 0, 1], { depth: 3, stagger: 0.18 }) },
  palette: { family: 'rise', tracks: riseTracks([4, 3, 1, 2], { depth: 2, stagger: 0.12 }) },
  user: rise([1]),
  'user-round': rise([0]),
  dot: rise([0]),

  // Strokes in writing order.
  check: sequence([0]),
  x: sequence([0, 1]),
  plus: sequence([0, 1]),
  minus: sequence([0]),
  circle: sequence([0]),
  square: sequence([0]),
  type: sequence([1, 0, 2]),
  underline: sequence([0, 1]),
  strikethrough: sequence([2]),
  'square-slash': sequence([1]),
  'circle-plus': sequence([1, 2]),
  'circle-check': sequence([1]),
  'circle-x': sequence([1, 2]),
  'circle-alert': sequence([1, 2]),
  'triangle-alert': sequence([1, 2]),
  'shield-alert': sequence([1, 2]),
  'shield-check': sequence([1]),
  'shield-x': sequence([1, 2]),
  'badge-check': sequence([1]),
  'badge-x': sequence([1, 2]),
  'file-exclamation-point': sequence([1, 2]),
  'file-plus': sequence([2, 3]),
  'file-x': sequence([2, 3]),
  file: sequence([0, 1]),
  'file-text': sequence([2, 3, 4], [2, 3, 4]),
  'file-archive': sequence([4, 2, 3, 5]),
  info: sequence([2, 1], [1]),
  'text-align-start': sequence([0, 1, 2], [0, 1, 2]),
  'text-align-center': sequence([0, 1, 2], [0, 1, 2]),
  'text-align-end': sequence([0, 1, 2], [0, 1, 2]),
  'list-filter': sequence([0, 1, 2]),
  'list-ordered': sequence([3, 4, 0, 5, 1, 2]),
  'list-tree': sequence([0, 4, 3, 1, 2]),
  'message-square-text': sequence([3, 1, 2]),
  'square-dashed-text': sequence([12, 10, 11]),
  'scan-text': sequence([4, 5, 6]),
  'text-cursor': sequence([0, 2, 1]),
  'case-sensitive': sequence([0, 2, 3, 1]),
  'whole-word': sequence([0, 1, 2, 3, 4]),
  'book-open': sequence([0, 1]),
  signature: sequence([0, 1], [0]),
  spline: sequence([1, 2, 0]),
  lasso: sequence([0, 2, 1]),
  sticker: sequence([2, 3, 4]),
  'eye-off': sequence([3]),
  'image-off': sequence([0]),
};

// ---------------------------------------------------------------------------------------------------------------------
// Player

/** The catalogue entry of a rendered Lucide svg: its `lucide-<id>` classes in order (canonical id first, then aliases). */
export function motionFor(svg: Element): Motion {
  for (const name of Array.from(svg.classList)) {
    if (!name.startsWith('lucide-')) continue;
    const motion = CATALOGUE[name.slice('lucide-'.length)];
    if (motion !== undefined) return motion;
  }
  return TRACE;
}

const GEOMETRY = 'path, line, circle, rect, polyline, polygon, ellipse';

const animatable = (shape: Element): shape is SVGGeometryElement =>
  typeof (shape as SVGGeometryElement).animate === 'function';

function originCss(origin: Origin | undefined): { transformBox: string; transformOrigin: string } {
  if (origin === undefined) return { transformBox: 'fill-box', transformOrigin: '50% 50%' };
  if (typeof origin === 'string') return { transformBox: 'fill-box', transformOrigin: origin };
  return { transformBox: 'view-box', transformOrigin: `${origin[0]}px ${origin[1]}px` };
}

/** The poses of a track with the rest pose added at both ends where the track does not set its own. */
export function fullPoses(poses: readonly Pose[]): Pose[] {
  const all = [...poses];
  if (all[0]?.at !== 0) all.unshift({ at: 0 });
  if (all[all.length - 1]?.at !== 1) all.push({ at: 1 });
  return all;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function moveFrames(track: MoveTrack): Keyframe[] {
  const box = originCss(track.origin);
  const poses = fullPoses(track.poses);
  const fades = poses.some((pose) => pose.o !== undefined);
  return poses.map(({ at, x = 0, y = 0, r = 0, o = 1 }) => ({
    offset: at,
    transform: `translate(${round(x)}px, ${round(y)}px) rotate(${round(r)}deg)`,
    ...box,
    ...(fades ? { opacity: o } : {}),
    ...(track.smooth === true ? {} : { easing: EASE_DRAW }),
  }));
}

interface Stroke {
  shape: SVGGeometryElement;
  length: number;
  index: number;
}

/**
 * Draws the strokes completely one after the other inside [start, start + duration] (ms), each weighted by its length with a
 * floor; a dot fades in its turn. The dash leaves a margin of stroke widths on both sides so no round cap shows before the
 * pen arrives, and the last frame (offset 0, a dash longer than the path) looks exactly like the rest.
 */
function drawStrokes(
  strokes: readonly Stroke[],
  reverse: ReadonlySet<number>,
  start: number,
  duration: number,
  stroke: number,
  scale: number,
): Animation[] {
  if (strokes.length === 0) return [];
  const sum = strokes.reduce((acc, item) => acc + item.length, 0) || 1;
  const weights = strokes.map((item) => Math.max(FLOOR, item.length / sum));
  const starts: number[] = [];
  let end = 0;
  weights.forEach((weight, at) => {
    const begin = at === 0 ? 0 : (starts[at - 1] ?? 0) + OVERLAP * (weights[at - 1] ?? 0);
    starts.push(begin);
    end = Math.max(end, begin + weight);
  });
  const k = duration / end;
  return strokes.map(({ shape, length, index }, at) => {
    const timing: KeyframeAnimationOptions = {
      duration: (weights[at] ?? 0) * k,
      delay: start + (starts[at] ?? 0) * k,
      easing: EASE_DRAW,
      fill: 'backwards',
    };
    if (length * scale < DOT_PX) return shape.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    const dash = round(length + stroke);
    const gap = round(length + 4 * stroke);
    const hidden = round(length + 2 * stroke);
    const array = `${dash} ${gap}`;
    return shape.animate(
      [
        { strokeDasharray: array, strokeDashoffset: `${reverse.has(index) ? -hidden : hidden}` },
        { strokeDasharray: array, strokeDashoffset: '0' },
      ],
      timing,
    );
  });
}

/** Plays the icon's motion once; returns the running animations and the total in ms. */
export function playMotion(svg: SVGSVGElement, size: number): { animations: Animation[]; total: number } {
  const motion = motionFor(svg);
  const total = tokenMs('--motion-icon', MOTION_ICON_MS) * FAMILY_FACTOR[motion.family];
  const shapes = Array.from(svg.querySelectorAll(GEOMETRY));
  const stroke = (STROKE_PX * VIEW) / size;
  const scale = size / VIEW;
  const animations: Animation[] = [];
  for (const track of motion.tracks) {
    const from = track.from ?? 0;
    const to = track.to ?? 1;
    const start = from * total;
    const duration = Math.max(0, to - from) * total;
    if (track.kind === 'move') {
      const frames = moveFrames(track);
      const picked = track.el === 'all' ? shapes : track.el.map((index) => shapes[index]);
      for (const shape of picked) {
        if (shape === undefined || !animatable(shape)) continue;
        animations.push(
          shape.animate(frames, {
            duration,
            delay: start,
            easing: track.smooth === true ? EASE_DRAW : 'linear',
            fill: 'backwards',
          }),
        );
      }
      continue;
    }
    const strokes: Stroke[] = [];
    const order = track.el === 'longest' ? shapes.map((_, index) => index) : track.el;
    for (const index of order) {
      const shape = shapes[index];
      if (shape === undefined || !animatable(shape)) continue;
      const length = typeof shape.getTotalLength === 'function' ? shape.getTotalLength() : 0;
      if (!Number.isFinite(length) || length < 0) continue;
      strokes.push({ shape, length, index });
    }
    if (track.el === 'longest') {
      // Strokes longest first, then the dots.
      const dot = (item: Stroke) => item.length * scale < DOT_PX;
      strokes.sort((a, b) => Number(dot(a)) - Number(dot(b)) || b.length - a.length);
    }
    animations.push(...drawStrokes(strokes, new Set(track.reverse ?? []), start, duration, stroke, scale));
  }
  return { animations, total };
}
