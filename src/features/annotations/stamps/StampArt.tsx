import type { StampTone } from '../../../api/annotations';
import { STAMP_BORDER_PT, STAMP_RADIUS_PT, boldWidth, textLayout, type TextLayout } from './model';

export interface StampArtProps {
  /** The stamp's size in page points. */
  w: number;
  h: number;
  text: string;
  date: string | null;
  tone: StampTone;
  /** A fixed text layout (the picker's tiles, which keep the type legible) instead of the fit into the box. */
  layout?: TextLayout;
}

/**
 * The look of a stamp in its own coordinates (origin top left), as the appearance stream draws it (DESIGN 3.14 ST4): a rounded
 * rectangle in Ink, filled Solar for the Solar tone, the text in bold sans centred, the date in regular below it. The colours are the
 * document's own (annotation colours are content), so they come from the document tokens, not the interface's.
 */
export function StampArt({ w, h, text, date, tone, layout: fixed }: StampArtProps) {
  const layout = fixed ?? textLayout(text, date, w, h);
  const half = STAMP_BORDER_PT / 2;
  return (
    <g data-stamp-art="" data-tone={tone}>
      <rect
        x={half}
        y={half}
        width={Math.max(0, w - STAMP_BORDER_PT)}
        height={Math.max(0, h - STAMP_BORDER_PT)}
        rx={STAMP_RADIUS_PT}
        fill={tone === 'solar' ? 'var(--hl-solar)' : 'none'}
        stroke="var(--color-doc-ink)"
        strokeWidth={STAMP_BORDER_PT}
      />
      <text
        x={w / 2}
        y={layout.baseline}
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontWeight={700}
        fontSize={layout.size}
        textLength={boldWidth(text, layout.size)}
        lengthAdjust="spacingAndGlyphs"
        fill="var(--color-doc-ink)"
      >
        {text}
      </text>
      {date !== null && (
        <text
          x={w / 2}
          y={layout.dateBaseline}
          textAnchor="middle"
          fontFamily="Helvetica, Arial, sans-serif"
          fontSize={layout.dateSize}
          fill="var(--color-doc-ink)"
        >
          {date}
        </text>
      )}
    </g>
  );
}
