import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { Annotation } from '../../../api/annotations';
import type { Point } from '../../../api/wire';
import { useT } from '../../../i18n';
import { annotationsOnPage, useAnnotations, type AnnotationsState } from '../../../stores/annotations';
import { useSettled } from '../../thumbnails/motion';
import { PlacementLayer } from '../../signatures/place/PlacementLayer';
import { CertPlacementLayer } from '../../signatures/sign';
import { fileRotationOf } from '../../viewer/fileRotation';
import { useEffectiveTool } from '../../viewer/lesen';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../../viewer/transform';
import { CreationLayer } from '../create';
import { FreeTextEditor } from '../note/FreeTextEditor';
import { NotePopover } from '../note/NotePopover';
import {
  angleOf,
  canMove,
  handleCursor,
  handlePoint,
  handlesOf,
  readingOrder,
  type HandleId,
} from '../selection/geometry';
import { useInteraction, type Handlers } from '../selection/useInteraction';
import { HitShape, Shape, hasExtent } from './shapes';
import { useUndoFades } from './useUndoFades';

/**
 * MOTION spell 7: an item that an undo removed stays as a ghost that fades out (scale 0.98), an item that an undo or a redo brought
 * back fades in from 0.98. `data-undo-fade` carries the direction; tokens.css has the transitions (reduced motion: opacity only).
 */
function UndoFade({ mode, children }: { mode?: 'in' | 'out'; children: ReactNode }) {
  const ref = useRef<SVGGElement | null>(null);
  const settled = useSettled(ref, mode !== undefined);
  if (mode === undefined) return <>{children}</>;
  return (
    <g ref={ref} data-undo-fade={mode} data-settled={settled ? '' : undefined}>
      {children}
    </g>
  );
}

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
  onEdit: (a: Annotation) => void;
}

/** The focusable frame of one annotation: its tab stop, its accessible name, and its selection chrome. */
const Frame = memo(function Frame({ a, view, selected, hovered, withHandles, pageNumber, api, onEdit }: FrameProps) {
  const t = useT();
  const type = t(`annot.type.${a.kind}`);
  const text = a.contents.trim().slice(0, NAME_TEXT_CHARS);
  const name =
    a.author !== null
      ? t(text === '' ? 'annot.name' : 'annot.nameText', { type, author: a.author, n: pageNumber, text })
      : t(text === '' ? 'annot.nameNoAuthor' : 'annot.nameNoAuthorText', { type, n: pageNumber, text });
  // A signature or mark that is turned has its frame on the box before the turn, turned by CSS about its centre (ADR-105).
  const turn = angleOf(view);
  const rect = view.kind === 'signature' || view.kind === 'mark' ? view.box : view.rect;
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
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        transform: turn === 0 ? undefined : `rotate(${turn}deg)`,
      }}
      onFocus={() => api.onItemFocus(a)}
      onBlur={api.onItemBlur}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget && a.kind === 'freeText') {
          event.preventDefault();
          onEdit(a);
          return;
        }
        api.onItemKeyDown(a, event);
      }}
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
  const { leaving, entering } = useUndoFades(docId, pageIndex, list);
  const selectActive = useEffectiveTool() === 'select';
  const [hover, setHover] = useState<number | null>(null);
  /** The annotation the Text or Note tool just made: its editor (free text) or popover (note) is open until it is done. */
  const [editing, setEditing] = useState<{ id: number; kind: 'freeText' | 'note'; fresh: boolean } | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const editingId = editing?.id;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the anchor is a DOM element that exists only after the frame rendered
    setAnchor(
      editingId === undefined ? null : document.querySelector<HTMLElement>(`[data-annot-frame="${editingId}"]`),
    );
  }, [editingId, list]);
  const editedText = editing?.kind === 'freeText' ? list.find((a) => a.id === editing.id) : undefined;

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

  /** Double-click (or Enter) on a free text opens its inline editor. */
  const edit = (a: Annotation) => {
    if (a.kind === 'freeText' && !a.locked) setEditing({ id: a.id, kind: 'freeText', fresh: false });
  };

  const items = useMemo(
    () => readingOrder(list.filter((a) => a.state === undefined && (a.kind !== 'opaque' || hasExtent(a.rect)))),
    [list],
  );

  if (!ready) return null;
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, total);
  const style = { ...box, transformOrigin: 'center', '--page-scale': pxPerPt } as CSSProperties;
  const only = selectedHere.size === 1;
  const minPt = HIT_SLOP_PX / pxPerPt;
  // A press of a creation or placement tool on an annotation that can be moved moves it instead (ADR-105).
  const grab = (event: ReactPointerEvent, at: Point) => handlers.onGrab(event, at, minPt / 2);

  const isDrawn = (a: Annotation) => {
    const view = preview.get(a.id) ?? a;
    return view.sync !== 'clean' || view !== a;
  };
  // Highlights are drawn in their own layer that multiplies with the page bitmap: a blend only reaches the bitmap from a sibling
  // of the page's surface, not from inside a layer that is a stacking context of its own (the transformed group below).
  const highlights = items.filter((a) => a.kind === 'highlight' && isDrawn(a));
  const gone = leaving.filter((a) => !list.some((b) => b.id === a.id));
  const goneHighlights = gone.filter((a) => a.kind === 'highlight');

  return (
    <>
      {(highlights.length > 0 || goneHighlights.length > 0) && (
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
                <UndoFade key={a.id} mode={entering.has(a.id) ? 'in' : undefined}>
                  <Shape a={preview.get(a.id) ?? a} />
                </UndoFade>
              ))}
              {goneHighlights.map((a) => (
                <UndoFade key={`gone-${a.id}`} mode="out">
                  <Shape a={a} />
                </UndoFade>
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
                <g key={a.id} data-annot-item={a.id}>
                  {drawn && (
                    <UndoFade mode={entering.has(a.id) ? 'in' : undefined}>
                      <Shape a={view} docId={docId} />
                    </UndoFade>
                  )}
                  {selectActive && (
                    <g
                      data-annot-hit={a.id}
                      style={{ pointerEvents: 'all', cursor: canMove(a) ? 'move' : 'default' }}
                      onPointerDown={(event) => handlers.onItemPointerDown(a, event)}
                      onDoubleClick={() => edit(a)}
                      onPointerEnter={() => setHover(a.id)}
                      onPointerLeave={() => setHover((current) => (current === a.id ? null : current))}
                    >
                      <HitShape a={view} minPt={minPt} />
                    </g>
                  )}
                </g>
              );
            })}
            {gone
              .filter((a) => a.kind !== 'highlight')
              .map((a) => (
                <UndoFade key={`gone-${a.id}`} mode="out">
                  <Shape a={a} docId={docId} />
                </UndoFade>
              ))}
          </svg>
          {items.map((a) => (
            <Frame
              key={a.id}
              a={a}
              view={preview.get(a.id) ?? a}
              // While its editor is open a text comment shows only the editor's own outline: the frame keeps the size the box had
              // when it was made and would sit as a stale box inside the growing text (R7 designer review).
              selected={selectedHere.has(a.id) && !(editing?.kind === 'freeText' && editing.id === a.id)}
              hovered={hover === a.id && selectActive}
              withHandles={only && selectActive && !(editing?.kind === 'freeText' && editing.id === a.id)}
              pageNumber={pageIndex + 1}
              api={handlers}
              onEdit={edit}
            />
          ))}
        </div>
        <CreationLayer
          docId={docId}
          pageIndex={pageIndex}
          pageBox={{ width: page[0], height: page[1] }}
          transform={{ pxPerPt, rotation: total }}
          grab={grab}
          onCreated={(created) => {
            // The new text comment is selected, so its mini bar shows at once (DESIGN 3.3: whenever something is selected).
            if (created.kind === 'freeText') useAnnotations.getState().select(docId, [created.id]);
            if (created.kind === 'freeText' || created.kind === 'note')
              setEditing({ id: created.id, kind: created.kind, fresh: true });
          }}
        />
        {editedText?.kind === 'freeText' && (
          // The group is in page space and scaled as a whole, so the editor works at scale 1; it takes the pointer itself.
          <div className="absolute" style={style}>
            <div data-annot-keep="" className="pointer-events-auto contents">
              <FreeTextEditor
                docId={docId}
                annotation={editedText}
                scale={1}
                pageWidth={page[0]}
                isNew={editing?.fresh ?? false}
                onDone={() => setEditing(null)}
              />
            </div>
          </div>
        )}
        {editing?.kind === 'note' && (
          <NotePopover docId={docId} noteId={editing.id} anchor={anchor} open isNew onClose={() => setEditing(null)} />
        )}
        <PlacementLayer
          docId={docId}
          pageIndex={pageIndex}
          pageBox={{ width: page[0], height: page[1] }}
          transform={{ pxPerPt, rotation: total }}
          grab={grab}
        />
        <CertPlacementLayer
          docId={docId}
          pageIndex={pageIndex}
          pageBox={{ width: page[0], height: page[1] }}
          transform={{ pxPerPt, rotation: total }}
        />
      </div>
    </>
  );
});
