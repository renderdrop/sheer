import { memo } from 'react';

import type { Annotation } from '../../../api/annotations';
import { rgbToCss } from '../../inspector/palette';
import { assetArt, useRasterUrl } from './assets';
import { markGeometry } from './marks';

/**
 * The look of the `signature` and `mark` kinds in page space (DESIGN 3.34). Vector art (drawn, typed) is polygons filled in the
 * annotation's colour; a picture is the asset's PNG preview; a signature that only the file has is in the page bitmap, so nothing is
 * drawn for it. Marks are strokes in the annotation's colour.
 */

type SignatureAnnotation = Extract<Annotation, { kind: 'signature' }>;
type MarkAnnotation = Extract<Annotation, { kind: 'mark' }>;

const polygonD = (points: readonly { x: number; y: number }[]): string =>
  points.length === 0 ? '' : `M${points.map((p) => `${p.x} ${p.y}`).join('L')}Z`;

export const SignatureShape = memo(function SignatureShape({ a, docId }: { a: SignatureAnnotation; docId: number }) {
  const assetId = a.art.type === 'asset' ? a.art.assetId : null;
  const art = assetId === null ? null : assetArt(docId, assetId);
  const raster = useRasterUrl(docId, assetId ?? 0, art?.type === 'raster');
  if (art === null) return null;
  const { box } = a;
  if (art.type === 'raster') {
    return raster === null ? null : (
      <image
        href={raster}
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        preserveAspectRatio="none"
        opacity={a.opacity}
        data-signature-image=""
      />
    );
  }
  return (
    <g
      transform={`translate(${box.x} ${box.y}) scale(${box.w / art.w} ${box.h / art.h})`}
      fill={rgbToCss(a.color)}
      fillRule="nonzero"
      opacity={a.opacity}
      data-signature-vector=""
    >
      {art.paths.map((path, i) => (
        <path key={i} d={polygonD(path)} />
      ))}
    </g>
  );
});

/** A mark drawn in a box; also the ghost that follows the pointer while one is armed. */
export function MarkGlyphShape({
  glyph,
  box,
  color,
  opacity,
}: {
  glyph: MarkAnnotation['glyph'];
  box: MarkAnnotation['box'];
  color: string;
  opacity: number;
}) {
  const geometry = markGeometry(glyph, box);
  if (geometry.type === 'dot') {
    return <circle cx={geometry.cx} cy={geometry.cy} r={geometry.r} fill={color} opacity={opacity} />;
  }
  return (
    <g
      fill="none"
      stroke={color}
      strokeWidth={geometry.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={opacity}
    >
      {geometry.lines.map((line, i) => (
        <polyline key={i} points={line.map(([x, y]) => `${x},${y}`).join(' ')} />
      ))}
    </g>
  );
}

export function MarkShape({ a }: { a: MarkAnnotation }) {
  return <MarkGlyphShape glyph={a.glyph} box={a.box} color={rgbToCss(a.color)} opacity={a.opacity} />;
}
