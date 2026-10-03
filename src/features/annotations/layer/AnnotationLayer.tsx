import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { Annotation } from '../../../api/annotations';
import { useT } from '../../../i18n';
import { annotationsOnPage, useAnnotations, type AnnotationsState } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { PlacementLayer } from '../../signatures/place/PlacementLayer';
import { fileRotationOf } from '../../viewer/fileRotation';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../../viewer/transform';
import { CreationLayer } from '../create';
import { canMove, handleCursor, handlePoint, handlesOf, readingOrder, type HandleId } from '../selection/geometry';
import { useInteraction, type Handlers } from '../selection/useInteraction';
import { HitShape, Shape, hasExtent } from './shapes';

export interface AnnotationLayerProps {
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
  /** The page is on screen: its annotations are fetched (once), not those of a page that is only near. */
  visible: boolean;
  /** The page's own rotation is known (it arrives with its text); before that the layer would be misplaced by it. */
  ready: boolean;
}

/** The slop of a click on a thin line, in screen px. */
const HIT_SLOP_PX = 12;
/** Text of an annotation that goes into its accessible name, in characters. */
const NAME_TEXT_CHARS = 60;

/** The ids of the page's selected annotations as one string, so a page re-renders only when its own selection changes. */
function pageSelectionKey(state: AnnotationsState, docId: number, pageIndex: number): string {
  const selected = state.selectedIds[docId];
  if (selected === undefined || selected.length === 0) return '';
  return annotationsOnPage(state, docId, pageIndex)
    .filter((a) => selected.includes(a.id))
    .map((a) => a.id)
    .join(',');
}

interface FrameProps {
  a: Annotation;
  /** What is drawn: the annotation, or its preview while it is dragged. */
  view: Annotation;
  selected: boolean;
  hovered: boolean;
  /** The only selected annotation shows handles. */
  withHandles: boolean;
  pageNumber: number;
  api: Handlers;
}

/** The focusable frame of one annotation: its tab stop, its accessible name, and its selection chrome. */
const Frame = memo(function Frame({ a, view, selected, hovered, withHandles, pageNumber, api }: FrameProps) {
  const t = useT();
  const type = t(`annot.type.${a.kind}`);
  const text = a.contents.trim().slice(0, NAME_TEXT_CHARS);
  const name =
    a.author !== null
      ? t(text === '' ? 'annot.name' : 'annot.nameText', { type, author: a.author, n: pageNumber, text })
      : t(text === '' ? 'annot.nameNoAuthor' : 'annot.nameNoAuthorText', { type, n: pageNumber, text });
  const { rect } = view;
  const handles: readonly HandleId[] = selected && withHandles ? handlesOf(view) : [];
  return (
    <div
      role="button"
      tabIndex={0}
      aria-roledescription={type}
      aria-pressed={selected}
      aria-label={name}
      data-annot-frame={a.id}
      data-state={selected ? 'selected' : hovered ? 'hover' : 'idle'}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onFocus={() => api.onItemFocus(a)}
      onBlur={api.onItemBlur}
      onKeyDown={(event) => api.onItemKeyDown(a, event)}
    >
      <span data-annot-box="" aria-hidden="true" />
      <span data-annot-ring="" aria-hidden="true" />
      {handles.map((handle) => {
        const p = handlePoint(rect, view, handle);
        return (
          <span
            key={handle}
            data-annot-handle={handle}
            aria-hidden="true"
            style={{ left: p.x - rect.x, top: p.y - rect.y, cursor: handleCursor(handle) }}
            onPointerDown={(event) => api.onHandlePointerDown(a, handle, event)}
          />
        );
      })}
    </div>
  );
});

/**
 * The annotation layer of one page (canvas layer 3, DESIGN 3.23): the annotations of the model drawn in page space, their
 * selection chrome, and, while a creation tool is active, the creation layer. It loads the page's annotations when the page is
 * on screen. The root is the page's box and takes no pointer; the annotations' shapes take it while the Select tool is active.
 *
 * The page bitmap already shows what the file had (`sync: 'clean'`), so only annotations changed or made in this session are drawn
 * again; a clean one is only a hit area. An opaque one is never drawn.
 */
export const AnnotationLayer = memo(function AnnotationLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  visible,
  ready,
}: AnnotationLayerProps) {
  const t = useT();
  useEffect(() => {
    if (!visible) return;
    // A failed read leaves the page unloaded; the next time it is shown it tries again.
    useAnnotations
      .getState()
      .loadPage(docId, pageIndex)
      .catch(() => undefined);
  }, [visible, docId, pageIndex]);

  const list = useAnnotations((state) => annotationsOnPage(state, docId, pageIndex));
  const selectionKey = useAnnotations((state) => pageSelectionKey(state, docId, pageIndex));
  const selectedHere = useMemo(
    () => new Set(selectionKey === '' ? [] : selectionKey.split(',').map(Number)),
    [selectionKey],
  );
  const selectActive = useUi((state) => state.activeTool === 'select');
  const [hover, setHover] = useState<number | null>(null);

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = useMemo(() => unrotatedSize([widthPt, heightPt], file), [widthPt, heightPt, file]);
  const total = totalRotation(file, rotation);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;

  const { preview, handlers } = useInteraction({ docId, pageIndex, page, pxPerPt, rotation: total, list });

  // A click on the page that is not on an annotation clears the selection (text selection still works).
  useEffect(() => {
    if (selectionKey === '') return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-action-scope="canvas"]') === null) return;
      if (target.closest('[data-annot-frame], [data-annot-hit], [data-annot-keep]') !== null) return;
      useAnnotations.getState().select(docId, []);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [selectionKey, docId]);

  const items = useMemo(() => readingOrder(list.filter((a) => a.kind !== 'opaque' || hasExtent(a.rect))), [list]);

  if (!ready) return null;
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, total);
  const style = { ...box, transformOrigin: 'center', '--page-scale': pxPerPt } as CSSProperties;
  const only = selectedHere.size === 1;
  const minPt = HIT_SLOP_PX / pxPerPt;

  const isDrawn = (a: Annotation) => {
    const view = preview.get(a.id) ?? a;
    return view.sync !== 'clean' || view !== a;
  };
  // Highlights are drawn in their own layer that multiplies with the page bitmap: a blend only reaches the bitmap from a sibling
  // of the page's surface, not from inside a layer that is a stacking context of its own (the transformed group below).
  const highlights = items.filter((a) => a.kind === 'highlight' && isDrawn(a));

  return (
    <>
      {highlights.length > 0 && (
        <div
          data-annot-blend=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-canvas-annotations mix-blend-multiply"
        >
          <div className="absolute" style={style}>
            <svg
              width={page[0]}
              height={page[1]}
              viewBox={`0 0 ${page[0]} ${page[1]}`}
              className="pointer-events-none absolute inset-0 overflow-visible"
            >
              {highlights.map((a) => (
                <Shape key={a.id} a={preview.get(a.id) ?? a} />
              ))}
            </svg>
          </div>
        </div>
      )}
      <div data-annot-layer="" className="pointer-events-none absolute inset-0 z-canvas-annotations">
        <div role="group" aria-label={t('annot.layer', { n: pageIndex + 1 })} className="absolute" style={style}>
          <svg
            width={page[0]}
            height={page[1]}
            viewBox={`0 0 ${page[0]} ${page[1]}`}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-visible"
          >
            {items.map((a) => {
              const view = preview.get(a.id) ?? a;
              // Clean ones are in the bitmap, unless they are being dragged: then the preview is all there is of them.
              // Highlights are in the blend layer.
              const drawn = a.kind !== 'highlight' && isDrawn(a);
              return (
                <g key={a.id}>
                  {drawn && <Shape a={view} docId={docId} />}
                  {selectActive && (
                    <g
                      data-annot-hit={a.id}
                      style={{ pointerEvents: 'all', cursor: canMove(a) ? 'move' : 'default' }}
                      onPointerDown={(event) => handlers.onItemPointerDown(a, event)}
                      onPointerEnter={() => setHover(a.id)}
                      onPointerLeave={() => setHover((current) => (current === a.id ? null : current))}
                    >
                      <HitShape a={view} minPt={minPt} />
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
          {items.map((a) => (
            <Frame
              key={a.id}
              a={a}
              view={preview.get(a.id) ?? a}
              selected={selectedHere.has(a.id)}
              hovered={hover === a.id && selectActive}
              withHandles={only && selectActive}
              pageNumber={pageIndex + 1}
              api={handlers}
            />
          ))}
        </div>
        <CreationLayer
          docId={docId}
          pageIndex={pageIndex}
          pageBox={{ width: page[0], height: page[1] }}
          transform={{ pxPerPt, rotation: total }}
        />
        <PlacementLayer
          docId={docId}
          pageIndex={pageIndex}
          pageBox={{ width: page[0], height: page[1] }}
          transform={{ pxPerPt, rotation: total }}
        />
      </div>
    </>
  );
});
