import { useEffect, useMemo, useState } from 'react';

import { resolveHeaderFooter, type HfSpec, type ResolvedPage } from '../../api/headerFooter';
import { renderPage } from '../../api/render';
import { bucketFor } from '../../engine/buckets';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { drawnSize, pageIdAt, readSlots } from '../../stores/pages';

/** The preview box in CSS px (DESIGN 3.15 HF2: 216 x 306); the page is contained in it. */
const BOX_W = 216;
const BOX_H = 306;
/** The wait before the draft is resolved again (HF2: debounced 120 ms). */
export const PREVIEW_DEBOUNCE_MS = 120;

/**
 * One page with the draft's text on it. The page image is the render of the page (the lowest priority, like a thumbnail); the
 * text is what the backend would write (`resolve_header_footer`, runs in page space), drawn as SVG over it. The previous answer
 * stays until the next one is there; only the latest answer counts. A page that still shows the file's own layer is shown
 * without the draft (`underFileLayer`, ADR-139 addendum C). Decorative: the controls carry the meaning.
 */
export function Preview({ docId, pageNumber, spec }: { docId: number; pageNumber: number; spec: HfSpec | null }) {
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

  if (slot === undefined) return null;
  const [dw, dh] = drawnSize(slot);
  const scale = Math.min(BOX_W / dw, BOX_H / dh);
  const w = dw * scale;
  const h = dh * scale;
  const quarter = slot.rotation === 90 || slot.rotation === 270;
  // The runs are in the unrotated page's space; the SVG is that page, turned like the displayed one.
  const innerW = quarter ? h : w;
  const innerH = quarter ? w : h;
  const runs = resolved !== null && resolved.pageId === pageId && !resolved.underFileLayer ? resolved.runs : [];
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
