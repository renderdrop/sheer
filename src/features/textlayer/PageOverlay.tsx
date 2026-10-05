import { memo, useMemo, type CSSProperties } from 'react';

import type { TextLayer } from '../../api/text';
import { SearchHits } from '../search/SearchHits';
import { fileRotationOf, hasFileRotation } from '../viewer/fileRotation';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../viewer/transform';
import { letterSpacingFor } from './fit';
import { measureTextWidth } from './measure';
import { runsOf, type Run } from './runs';
import { LAYER_ATTRIBUTE } from './selection';

export interface PageOverlayProps {
  docId: number;
  pageIndex: number;
  /** The page's box as it is shown, in px (the view rotation applied). */
  boxWidth: number;
  boxHeight: number;
  /** The page as it is drawn, in points (the file's `/Rotate` applied, the view rotation not). */
  widthPt: number;
  heightPt: number;
  /** The view rotation in degrees. */
  rotation: number;
  /** The text of the page, once it has been fetched. */
  layer: TextLayer | null;
  /** The Select tool is active: the text can be selected. Otherwise the layer takes no pointer. */
  interactive: boolean;
}

/** A transparent span for a run: positioned in page space, sized to its run, fitted by letter spacing (a transform breaks the caret) to the width of the glyphs it covers. */
const RunSpan = memo(function RunSpan({ run, spacing }: { run: Run; spacing: number }) {
  const style: CSSProperties = {
    left: run.x,
    top: run.y,
    height: run.h,
    fontSize: run.h,
    lineHeight: `${run.h}px`,
    color: 'transparent',
    letterSpacing: spacing === 0 ? undefined : `${spacing}px`,
  };
  return (
    <span
      data-run-start={run.start}
      data-run-end={run.end}
      className="absolute cursor-text whitespace-pre"
      style={style}
    >
      {run.text}
    </span>
  );
});

function spacingsOf(runs: readonly Run[]): number[] {
  return runs.map((run) => letterSpacingFor(measureTextWidth(run.text, run.h), run.w, run.text.length, run.h));
}

/** The spans of one page's text, in content order. Real DOM text, so a screen reader reads it and the browser selects it. */
const TextRuns = memo(function TextRuns({
  page,
  layer,
  interactive,
}: {
  page: number;
  layer: TextLayer;
  interactive: boolean;
}) {
  const runs = useMemo(() => runsOf(layer), [layer]);
  const spacings = useMemo(() => spacingsOf(runs), [runs]);
  return (
    <div
      {...{ [LAYER_ATTRIBUTE]: '' }}
      data-text-page={page}
      data-text-length={layer.text.length}
      className="absolute inset-0 cursor-default select-text"
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
    >
      {runs.map((run, i) => (
        <RunSpan key={run.start} run={run} spacing={spacings[i] ?? 0} />
      ))}
    </div>
  );
});

/**
 * Everything over a page's bitmap that lives in page space (canvas layer 2, DESIGN 3.17): the search hits and the text. The wrapper
 * is the unrotated page, `widthPt x heightPt` px in size, scaled to the zoom and turned by the file's and the view's rotation about
 * its centre (`overlayBox`), so its children are placed with the plain coordinates Rust reports. It never takes a pointer itself;
 * the text layer inside does while the Select tool is active.
 */
export const PageOverlay = memo(function PageOverlay({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  layer,
  interactive,
}: PageOverlayProps) {
  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = unrotatedSize([widthPt, heightPt], file);
  // Points on the page as it is shown: the box is the drawn page, turned by the view.
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, totalRotation(file, rotation));
  const style = {
    ...box,
    transformOrigin: 'center',
    '--page-scale': pxPerPt,
  } as CSSProperties;
  return (
    <div
      aria-hidden={layer === null ? true : undefined}
      data-page-overlay=""
      className="pointer-events-none absolute z-canvas-text"
      style={style}
    >
      {/* The hits wait for the page's own rotation, which arrives with its text: placed before that they would be off by it. */}
      {(layer !== null || hasFileRotation(docId, pageIndex)) && <SearchHits docId={docId} pageIndex={pageIndex} />}
      {layer !== null && <TextRuns page={pageIndex} layer={layer} interactive={interactive} />}
    </div>
  );
});
