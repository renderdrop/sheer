import { memo, type CSSProperties } from 'react';

import type { PlacedRun } from '../../api/headerFooter';
import { letterSpacingFor } from '../textlayer/fit';
import { measureTextWidth } from '../textlayer/measure';
import { cssRgb } from '../forms/model';
import { fileRotationOf } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../viewer/transform';
import { backgroundRect } from './overlap';
import { usePageHeaderFooter } from './overlayStore';

/** Where the baseline sits in a line box of height `size` for a Helvetica-like system font. */
const BASELINE = 0.85;

const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

function RunText({ run, color }: { run: PlacedRun; color: string }) {
  const spacing = letterSpacingFor(measureTextWidth(run.text, run.size), run.width, run.text.length, run.size);
  const style: CSSProperties = {
    left: run.origin.x,
    top: run.origin.y - BASELINE * run.size,
    fontSize: run.size,
    lineHeight: `${run.size}px`,
    fontFamily: FONT,
    color,
    letterSpacing: spacing === 0 ? undefined : `${spacing}px`,
    transformOrigin: `0 ${BASELINE * run.size}px`,
    transform: run.angle === 0 ? undefined : `rotate(${run.angle}deg)`,
  };
  return (
    <span className="absolute whitespace-pre" style={style}>
      {run.text}
    </span>
  );
}

/** The opaque box in the page colour behind a run (F21.7): the same box the save fills, so the staged view covers what is under it. */
function RunBackground({ run }: { run: PlacedRun }) {
  const box = backgroundRect(run);
  return (
    <span
      className="absolute bg-page"
      data-hf-background=""
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    />
  );
}

/**
 * The headers and footers that are staged and not yet saved, at the place the save writes them (DESIGN 3.15). Same page-space
 * wrapper as the text overlay; not interactive and hidden from assistive technology (the dialog announces the change).
 */
export const HeaderFooterOverlay = memo(function HeaderFooterOverlay({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  ready,
}: PageLayerProps) {
  const found = usePageHeaderFooter(docId, pageIndex, true);
  if (found === null || !ready) return null;
  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = unrotatedSize([widthPt, heightPt], file);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, totalRotation(file, rotation));
  const color = cssRgb(found.color);
  return (
    <div
      aria-hidden="true"
      data-hf-overlay=""
      className="pointer-events-none absolute z-canvas-text select-none"
      style={{ ...box, transformOrigin: 'center' }}
    >
      {found.background && found.runs.map((run, i) => <RunBackground key={`bg-${i}`} run={run} />)}
      {found.runs.map((run, i) => (
        <RunText key={i} run={run} color={color} />
      ))}
    </div>
  );
});
