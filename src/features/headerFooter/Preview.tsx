import { useEffect, useMemo, useState } from 'react';

import {
  resolveHeaderFooter,
  type DetectedItem,
  type HfSpec,
  type PlacedRun,
  type ResolvedPage,
} from '../../api/headerFooter';
import { renderPage } from '../../api/render';
import { bucketFor } from '../../engine/buckets';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { drawnSize, pageIdAt, readSlots } from '../../stores/pages';
import { backgroundRect, findOverlaps, overlappedItems } from './overlap';

/** The preview box in CSS px (DESIGN 3.15 HF2: 216 x 306); the page is contained in it. */
const BOX_W = 216;
const BOX_H = 306;
/** The wait before the draft is resolved again (HF2: debounced 120 ms). */
export const PREVIEW_DEBOUNCE_MS = 120;
const NO_RUNS: readonly PlacedRun[] = [];

/**
 * One page with the draft's text on it. The page image is the render of the page (the lowest priority, like a thumbnail); the
 * text is what the backend would write (`resolve_header_footer`, runs in page space), drawn as SVG over it. The previous answer
 * stays until the next one is there; only the latest answer counts. A page that still shows the file's own layer is shown
 * without the draft (`underFileLayer`, ADR-139 addendum C). Decorative: the controls carry the meaning.
 */
export function Preview({
  docId,
  pageNumber,
  spec,
  detected,
  onOverlap,
}: {
  docId: number;
  pageNumber: number;
  spec: HfSpec | null;
  /** What the document already has in its margin bands (drawn as outlines; the ones the new text lands on are marked). */
  detected: readonly DetectedItem[];
  /** The existing pieces the preview page's new text overlaps. */
  onOverlap: (items: DetectedItem[]) => void;
}) {
  const pageId = pageIdAt(docId, pageNumber - 1);
  const slot = readSlots(docId)[pageNumber - 1];
  const [image, setImage] = useState<{ pageId: number; url: string } | null>(null);
  const [resolved, setResolved] = useState<ResolvedPage | null>(null);
  const specKey = useMemo(() => (spec === null ? null : JSON.stringify(spec)), [spec]);
  const widthPt = slot === undefined ? 0 : drawnSize(slot)[0];

  useEffect(() => {
    if (pageId === null || widthPt <= 0) return;
    let cancelled = false;
    let url: string | null = null;
    const bucket = bucketFor(BOX_W / (widthPt * CSS_PX_PER_PT), window.devicePixelRatio || 1);
    renderPage({ docId, pageId, bucket, priority: 'thumbnail', generation: 0 })
      .then((frame) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([frame.data], { type: 'image/png' }));
        setImage((old) => {
          if (old !== null) URL.revokeObjectURL(old.url);
          return { pageId, url: url ?? '' };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [docId, pageId, widthPt]);

  useEffect(
    () => () => {
      setImage((old) => {
        if (old !== null) URL.revokeObjectURL(old.url);
        return null;
      });
    },
    [],
  );

  useEffect(() => {
    if (specKey === null || pageId === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      resolveHeaderFooter(docId, spec, [pageId])
        .then((pages) => {
          if (!cancelled) setResolved(pages[0] ?? null);
        })
        .catch(() => undefined);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `spec` is read through its key: a new object with the same content does not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, pageId, specKey]);

  const runs = resolved !== null && resolved.pageId === pageId && !resolved.underFileLayer ? resolved.runs : NO_RUNS;
  const background = spec?.background === true;
  const overlaps = useMemo(() => findOverlaps(runs, detected, background), [runs, detected, background]);
  const hit = useMemo(() => overlappedItems(overlaps), [overlaps]);
  useEffect(() => onOverlap(hit), [hit, onOverlap]);

  if (slot === undefined) return null;
  const [dw, dh] = drawnSize(slot);
  const scale = Math.min(BOX_W / dw, BOX_H / dh);
  const w = dw * scale;
  const h = dh * scale;
  const quarter = slot.rotation === 90 || slot.rotation === 270;
  // The runs are in the unrotated page's space; the SVG is that page, turned like the displayed one.
  const innerW = quarter ? h : w;
  const innerH = quarter ? w : h;
  return (
    <div
      aria-hidden="true"
      data-hf="preview"
      className="flex h-[var(--hf-preview-h)] w-[var(--hf-preview-w)] shrink-0 items-center justify-center rounded-md bg-subtle"
    >
      <div
        className="relative overflow-hidden border border-border-subtle bg-card"
        style={{ width: w, height: h }}
        data-hf="preview-page"
      >
        {image !== null && image.pageId === pageId && (
          <img src={image.url} alt="" draggable={false} className="absolute inset-0 size-full" />
        )}
        <svg
          viewBox={`0 0 ${quarter ? dh : dw} ${quarter ? dw : dh}`}
          width={innerW}
          height={innerH}
          className="absolute start-1/2 top-1/2"
          style={{ transform: `translate(-50%, -50%) rotate(${slot.rotation}deg)` }}
        >
          {detected.map((item, index) => (
            <rect
              key={`found-${index}`}
              x={item.rect.x}
              y={item.rect.y}
              width={item.rect.w}
              height={item.rect.h}
              strokeWidth={0.75}
              strokeDasharray="3 2"
              fill="none"
              className={hit.includes(item) && !background ? 'stroke-error-text' : 'stroke-text-muted'}
              data-hf={hit.includes(item) ? 'preview-overlap' : 'preview-existing'}
            />
          ))}
          {/* The background boxes come after the outlines of what is there: opaque in the page colour, they cover it as the saved
              page will (F21.7). */}
          {background &&
            runs.map((run, index) => {
              const box = backgroundRect(run);
              return (
                <rect
                  key={`bg-${index}`}
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  className="fill-page"
                  data-hf="preview-background"
                />
              );
            })}
          {runs.map((run, index) => (
            <text
              key={index}
              x={run.origin.x}
              y={run.origin.y}
              fontSize={run.size}
              className="fill-text font-sans"
              transform={`rotate(${run.angle} ${run.origin.x} ${run.origin.y})`}
            >
              {run.text}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
