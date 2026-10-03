import { memo } from 'react';

import type { Annotation, LineEnd } from '../../../api/annotations';
import type { Point, Rect } from '../../../api/wire';
import { rgbToCss } from '../../inspector/palette';
import { quadBox } from '../../viewer/transform';

/**
 * The look of every annotation kind in page space (DESIGN 3.23), as SVG. The colors are the document's own (annotation colors
 * are content, ADR-029 section 4), not interface colors. `Shape` draws, `HitShape` is the transparent geometry that takes the pointer.
 */

/** The size of a note's icon in points when the backend's box is empty. */
const NOTE_FALLBACK_PT = 20;
/** The speech bubble drawn on a note's anchor (Lucide `message-square`, ISC, on a 24 grid) and its inset as a share of the anchor. */
const NOTE_GLYPH = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';
const NOTE_GLYPH_INSET = 0.2;
/** The line height of free text, as a multiple of the font size. */
const LINE_HEIGHT = 1.2;
/** The inset of free text from its box, in points. */
const TEXT_PAD_PT = 2;
const ARROW_LENGTH_FACTOR = 4;
const ARROW_MIN_PT = 6;
/** The share of a markup's height at which the strike-out runs, and the underline's width as a share of the height. */
const STRIKE_AT = 0.55;
const UNDERLINE_SHARE = 0.08;
const UNDERLINE_MIN_PT = 0.75;

/** The points of an arrow head at `tip`, pointing away from `from`. */
export function arrowHead(from: Point, tip: Point, width: number): readonly Point[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const length = Math.max(ARROW_MIN_PT, width * ARROW_LENGTH_FACTOR);
  const spread = Math.PI / 7;
  return [
    tip,
    { x: tip.x - length * Math.cos(angle - spread), y: tip.y - length * Math.sin(angle - spread) },
    { x: tip.x - length * Math.cos(angle + spread), y: tip.y - length * Math.sin(angle + spread) },
  ];
}

const pointsAttr = (points: readonly Point[]): string => points.map((p) => `${p.x},${p.y}`).join(' ');
const outlineD = (points: readonly Point[]): string =>
  points.length === 0 ? '' : `M${points.map((p) => `${p.x} ${p.y}`).join('L')}Z`;

function EndHead({
  at,
  from,
  end,
  width,
  color,
}: {
  at: Point;
  from: Point;
  end: LineEnd;
  width: number;
  color: string;
}) {
  if (end === 'none') return null;
  const head = arrowHead(from, at, width);
  return end === 'closedArrow' ? (
    <polygon points={pointsAttr(head)} fill={color} stroke={color} strokeWidth={width} strokeLinejoin="round" />
  ) : (
    <polyline
      points={pointsAttr([head[1] ?? at, at, head[2] ?? at])}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** The look of an annotation. An opaque one draws nothing: the page bitmap has it already. */
export const Shape = memo(function Shape({ a }: { a: Annotation }) {
  const color = rgbToCss(a.color);
  switch (a.kind) {
    case 'highlight':
      return (
        <g fill={color} opacity={a.opacity}>
          {a.quads.map((q, i) => {
            const b = quadBox(q);
            return <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} />;
          })}
        </g>
      );
    case 'underline':
    case 'strikeout':
      return (
        <g stroke={color} opacity={a.opacity} fill="none">
          {a.quads.map((q, i) => {
            const b = quadBox(q);
            const y = a.kind === 'underline' ? b.y + b.h : b.y + b.h * STRIKE_AT;
            return (
              <line
                key={i}
                x1={b.x}
                x2={b.x + b.w}
                y1={y}
                y2={y}
                strokeWidth={Math.max(UNDERLINE_MIN_PT, b.h * UNDERLINE_SHARE)}
              />
            );
          })}
        </g>
      );
    case 'note': {
      const size = Math.max(a.rect.w, a.rect.h) || NOTE_FALLBACK_PT;
      // The anchor is the note's colour with a speech bubble on it (the 24-unit path of the interface's note icon), so it reads as a note.
      return (
        <g>
          <rect
            x={a.at.x}
            y={a.at.y}
            width={size}
            height={size}
            rx={size / 6}
            fill={color}
            fillOpacity={a.opacity}
            stroke={color}
          />
          <path
            d={NOTE_GLYPH}
            transform={`translate(${a.at.x + size * NOTE_GLYPH_INSET} ${a.at.y + size * NOTE_GLYPH_INSET}) scale(${(size * (1 - 2 * NOTE_GLYPH_INSET)) / 24})`}
            fill="none"
            style={{ stroke: 'var(--color-doc-ink)' }}
            strokeOpacity={0.75}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            data-note-glyph=""
          />
        </g>
      );
    }
    case 'freeText':
      return (
        <g opacity={a.opacity}>
          <rect
            x={a.box.x}
            y={a.box.y}
            width={a.box.w}
            height={a.box.h}
            fill={a.fill === null ? 'none' : rgbToCss(a.fill)}
            stroke={a.borderWidth > 0 ? color : 'none'}
            strokeWidth={a.borderWidth}
          />
          <text fill={color} fontFamily="Helvetica, Arial, sans-serif" fontSize={a.fontSize}>
            {a.lines.map((line, i) => (
              <tspan
                key={i}
                x={a.box.x + TEXT_PAD_PT}
                y={a.box.y + TEXT_PAD_PT + a.fontSize * (1 + i * LINE_HEIGHT) * 0.92}
              >
                {line}
              </tspan>
            ))}
          </text>
        </g>
      );
    case 'ink':
      return (
        <g fill={color} opacity={a.opacity}>
          {a.strokes.map((s, i) => (
            <path key={i} d={outlineD(s.outline)} />
          ))}
        </g>
      );
    case 'rect':
    case 'ellipse': {
      const common = {
        fill: a.fill === null ? 'none' : rgbToCss(a.fill),
        stroke: color,
        strokeWidth: a.width,
        strokeDasharray: a.dashed ? `${a.width * 3} ${a.width * 2}` : undefined,
        opacity: a.opacity,
      };
      return a.kind === 'rect' ? (
        <rect x={a.box.x} y={a.box.y} width={a.box.w} height={a.box.h} {...common} />
      ) : (
        <ellipse cx={a.box.x + a.box.w / 2} cy={a.box.y + a.box.h / 2} rx={a.box.w / 2} ry={a.box.h / 2} {...common} />
      );
    }
    case 'line':
      return (
        <g opacity={a.opacity}>
          <line
            x1={a.from.x}
            y1={a.from.y}
            x2={a.to.x}
            y2={a.to.y}
            stroke={color}
            strokeWidth={a.width}
            strokeLinecap="round"
          />
          <EndHead at={a.to} from={a.from} end={a.head} width={a.width} color={color} />
          <EndHead at={a.from} from={a.to} end={a.tail} width={a.width} color={color} />
        </g>
      );
    default:
      return null;
  }
});

/** Whether a box has an extent (an opaque annotation may not). */
export const hasExtent = (r: Rect): boolean => r.w > 0 || r.h > 0;

/**
 * The geometry that takes the pointer for an annotation: its boxes, or a stroke of at least `minPt` along its lines. The
 * wrapper sets `pointer-events`.
 */
export const HitShape = memo(function HitShape({ a, minPt }: { a: Annotation; minPt: number }) {
  const hit = { fill: 'transparent', stroke: 'none' } as const;
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return (
        <>
          {a.quads.map((q, i) => {
            const b = quadBox(q);
            return <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} {...hit} />;
          })}
        </>
      );
    case 'ink':
      return (
        <>
          {a.strokes.map((s, i) => (
            <polyline
              key={i}
              points={pointsAttr(s.points)}
              fill="none"
              stroke="transparent"
              strokeWidth={Math.max(a.width, minPt)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </>
      );
    case 'line':
      return (
        <line
          x1={a.from.x}
          y1={a.from.y}
          x2={a.to.x}
          y2={a.to.y}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(a.width, minPt)}
          strokeLinecap="round"
        />
      );
    default:
      return hasExtent(a.rect) ? <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} {...hit} /> : null;
  }
});
