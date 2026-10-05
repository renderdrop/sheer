import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { announce } from '../../components';
import { useT } from '../../i18n';
import type { Point, Rect } from '../../api/wire';
import { useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { clampToPage } from '../annotations/create/geometry';
import { handleCursor, readingOrder } from '../annotations/selection/geometry';
import { fileRotationOf } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import {
  normalizeRotation,
  overlayBox,
  swapsSides,
  totalRotation,
  unrotatedSize,
  viewToPage,
} from '../viewer/transform';
import { armImage, createImage } from './actions';
import { defaultImageRect, handleAt, handlesFor, imageRectFromDrag, newTextBoxRect } from './geometry';
import { useInsert, objectsOnPage, type ContentObject } from './store';
import { TextEditor } from './TextEditor';
import { useObjectInteraction } from './useObjectInteraction';
import { ImageView, ObjectView } from './view';

/** The ghost of an image follows the pointer at this opacity (DESIGN 3.36). */
const GHOST_OPACITY = 0.5;
/** Text of a text box that goes into its accessible name, in characters. */
const NAME_TEXT_CHARS = 60;
/** The canvas region that scrolls the pages (Canvas.tsx). */
const SCROLL_SURFACE = '[role="region"]';

/**
 * Canvas layer for new text boxes and images (layer 3, DESIGN 3.36). It draws the text boxes and images of the page that the
 * model holds (they are page content until the next save burns them in), their selection chrome and the inline editor; while
 * Add text or Add image is active it also takes the pointer to place one. Nothing renders before the page's own rotation is known.
 */
export const InsertLayer = memo(function InsertLayer(props: PageLayerProps) {
  if (!props.ready) return null;
  return <ReadyLayer {...props} />;
});

function ReadyLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
}: PageLayerProps) {
  const t = useT();
  const tool = useUi((s) => s.activeTool);
  const objects = useInsert((s) => objectsOnPage(s, docId, pageIndex));
  const selectedId = useInsert((s) => s.selected[docId] ?? null);
  const extraIds = useInsert((s) => s.extra[docId]);
  const editing = useInsert((s) => s.editing);
  const pendingImage = useInsert((s) => s.pendingImage);
  const lockAspect = useInsert((s) => s.lockAspect);
  const fontSizeNow = useInsert((s) => s.style.fontSize);
  const annotationSelection = useAnnotations((s) => s.selectedIds[docId]);

  useEffect(() => {
    // A failed read leaves the page unloaded; the next time it is shown it tries again.
    useInsert
      .getState()
      .loadPage(docId, pageIndex)
      .catch(() => undefined);
  }, [docId, pageIndex]);

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = useMemo(() => unrotatedSize([widthPt, heightPt], file), [widthPt, heightPt, file]);
  const total = totalRotation(file, rotation);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;
  const viewW = swapsSides(total) ? page[1] : page[0];
  const viewH = swapsSides(total) ? page[0] : page[1];

  const editingHere = editing !== null && editing.docId === docId && editing.pageId === pageIndex ? editing : null;
  const editedObject = objects.find((o) => o.id === editingHere?.id);

  const startEdit = useCallback(
    (object: ContentObject) => {
      if (object.kind !== 'textBox') return;
      useInsert.getState().startEditing({ docId, pageId: pageIndex, id: object.id, box: object.box });
    },
    [docId, pageIndex],
  );

  const interaction = useObjectInteraction({ docId, page, pxPerPt, rotation: total, objects, onEdit: startEdit });

  // Selecting a comment leaves the selection of the objects (one selection at a time).
  const annotationsSelected = (annotationSelection?.length ?? 0) > 0;
  useEffect(() => {
    if (annotationsSelected) useInsert.getState().select(docId, null);
  }, [annotationsSelected, docId]);

  // A click on the page that is not on an object clears the selection.
  const hasSelection = selectedId !== null;
  useEffect(() => {
    if (!hasSelection) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-action-scope="canvas"]') === null) return;
      if (target.closest('[data-insert-frame], [data-insert-editor], [data-annot-keep]') !== null) return;
      useInsert.getState().select(docId, null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [hasSelection, docId]);

  // The Add image tool opens the dialog first; every page's layer asks, the first one wins.
  const imageTool = tool === 'image';
  useEffect(() => {
    const state = useInsert.getState();
    if (imageTool && state.pendingImage === null && !state.arming) void armImage(docId);
    if (!imageTool && state.pendingImage !== null) state.setPendingImage(null);
  }, [imageTool, pendingImage, docId]);

  const items = useMemo(() => readingOrder(objects.map((o) => ({ o, rect: o.box, id: o.id }))), [objects]);

  const hitsOn = tool === 'select' || tool === 'textBox';
  const placing = tool === 'textBox' || (imageTool && pendingImage !== null);
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, total);
  const style = { ...box, transformOrigin: 'center', '--page-scale': pxPerPt } as CSSProperties;

  // --- Placing ---------------------------------------------------------------------------------------------------------
  const surface = useRef<HTMLDivElement>(null);
  const [sketch, setSketch] = useState<{ from: Point; to: Point } | null>(null);
  const [ghost, setGhost] = useState<Point | null>(null);

  const toPage = useCallback(
    (event: { clientX: number; clientY: number }): Point | null => {
      const element = surface.current;
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const view = {
        x: ((event.clientX - rect.left) / rect.width) * viewW,
        y: ((event.clientY - rect.top) / rect.height) * viewH,
      };
      return clampToPage(viewToPage(view, page, total), page[0], page[1]);
    },
    [page, total, viewW, viewH],
  );

  const place = useCallback(
    (from: Point, to: Point, shift: boolean) => {
      if (tool === 'textBox') {
        const fontSize = useInsert.getState().style.fontSize;
        useInsert
          .getState()
          .startEditing({ docId, pageId: pageIndex, id: null, box: newTextBoxRect(from, to, fontSize, page) });
        return;
      }
      const image = useInsert.getState().pendingImage;
      if (image === null) return;
      const keep = useInsert.getState().lockAspect !== shift;
      const dragged = Math.hypot(to.x - from.x, to.y - from.y) > 3;
      const rect: Rect = dragged
        ? imageRectFromDrag(from, to, image.aspect, keep, page)
        : defaultImageRect(image.aspect, to, page);
      // The tool stays active (F11): the image stays armed so the next click places it again.
      void createImage(docId, pageIndex, rect, image).then((created) => {
        if (created === null) return;
        useInsert.getState().select(docId, created.id);
        announce(t('insert.placed', { kind: t('insert.imageRole'), n: pageIndex + 1 }));
      });
    },
    [tool, docId, pageIndex, page, t],
  );

  const onSurfaceDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // A text still being edited is committed by this very click (the editor loses focus); it places nothing.
    if (useInsert.getState().editing !== null) return;
    const at = toPage(event);
    if (at === null) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSketch({ from: at, to: at });
  };
  const onSurfaceMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const at = toPage(event);
    setGhost(at);
    if (sketch !== null && at !== null) setSketch({ from: sketch.from, to: at });
  };
  const onSurfaceUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sketch === null) return;
    const at = toPage(event) ?? sketch.to;
    const from = sketch.from;
    setSketch(null);
    place(from, at, event.shiftKey);
  };

  // Enter places at the centre of the scroll surface's visible rect, on the page that is there (the keyboard's way to place).
  const onEnter = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    onEnter.current = (event) => {
      if (!placing || event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, button, [role^="menu"]') !== null)
        return;
      if (useInsert.getState().editing !== null) return;
      const element = surface.current;
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      const scroller = element.closest(SCROLL_SURFACE)?.getBoundingClientRect();
      const cx = scroller !== undefined ? scroller.left + scroller.width / 2 : window.innerWidth / 2;
      const cy = scroller !== undefined ? scroller.top + scroller.height / 2 : window.innerHeight / 2;
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return;
      const at = toPage({ clientX: cx, clientY: cy });
      if (at === null) return;
      event.preventDefault();
      place(at, at, false);
    };
  });
  useEffect(() => {
    if (!placing) return;
    const onKey = (event: KeyboardEvent) => onEnter.current(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing]);

  const sketchRect: Rect | null =
    sketch === null
      ? null
      : tool === 'textBox'
        ? newTextBoxRect(sketch.from, sketch.to, fontSizeNow, page)
        : pendingImage === null
          ? null
          : imageRectFromDrag(sketch.from, sketch.to, pendingImage.aspect, lockAspect, page);
  const ghostRect =
    ghost !== null && sketch === null && imageTool && pendingImage !== null
      ? defaultImageRect(pendingImage.aspect, ghost, page)
      : null;

  const only = selectedId !== null && (extraIds?.length ?? 0) === 0;
  return (
    <div data-insert-layer="" className="pointer-events-none absolute inset-0 z-canvas-annotations">
      {placing && (
        <div
          ref={surface}
          data-insert-surface=""
          data-tool={tool}
          className="pointer-events-auto absolute inset-0 touch-none select-none"
          onPointerDown={onSurfaceDown}
          onPointerMove={onSurfaceMove}
          onPointerUp={onSurfaceUp}
          onPointerLeave={() => setGhost(null)}
        />
      )}
      <div role="group" aria-label={t('annot.layer', { n: pageIndex + 1 })} className="absolute" style={style}>
        {items.map(({ o }) => {
          const shown = interaction.preview.get(o.id) ?? o.box;
          const hidden = editingHere?.id === o.id;
          return (
            <div key={o.id}>
              {!hidden && <ObjectView docId={docId} object={o} box={shown} />}
              <ObjectFrame
                object={o}
                box={shown}
                selected={selectedId === o.id || (extraIds?.includes(o.id) ?? false)}
                withHandles={only && selectedId === o.id && !hidden}
                keepAspect={lockAspect}
                interactive={hitsOn}
                pageNumber={pageIndex + 1}
                api={interaction}
              />
            </div>
          );
        })}
        {sketchRect !== null && <Outline box={sketchRect} />}
        {ghostRect !== null && pendingImage !== null && (
          <>
            <ImageView docId={docId} assetId={pendingImage.assetId} box={ghostRect} opacity={GHOST_OPACITY} />
            <Outline box={ghostRect} />
          </>
        )}
        {editingHere !== null && (
          <TextEditor
            key={editingHere.id ?? 'new'}
            editing={editingHere}
            object={editedObject?.kind === 'textBox' ? editedObject : undefined}
            onCreated={(created) => {
              useInsert.getState().select(docId, created.id);
              announce(t('insert.placed', { kind: t('insert.textRole'), n: pageIndex + 1 }));
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A dashed outline of a box being drawn, in the selection colour; a hairline whatever the zoom. */
function Outline({ box }: { box: Rect }) {
  return (
    <div
      aria-hidden="true"
      data-insert-outline=""
      className="pointer-events-none absolute"
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        outline: 'calc(var(--hairline) / var(--page-scale, 1)) dashed var(--color-doc-select)',
      }}
    />
  );
}

interface FrameProps {
  object: ContentObject;
  box: Rect;
  selected: boolean;
  withHandles: boolean;
  keepAspect: boolean;
  interactive: boolean;
  pageNumber: number;
  api: ReturnType<typeof useObjectInteraction>;
}

/** The focusable frame of one object: its tab stop, accessible name and selection chrome (the classes of the annotation frames). */
const ObjectFrame = memo(function ObjectFrame({
  object,
  box,
  selected,
  withHandles,
  keepAspect,
  interactive,
  pageNumber,
  api,
}: FrameProps) {
  const t = useT();
  const role = t(object.kind === 'textBox' ? 'insert.textRole' : 'insert.imageRole');
  const text = object.kind === 'textBox' ? object.text.trim().slice(0, NAME_TEXT_CHARS) : '';
  const handles = selected && withHandles && !object.locked ? handlesFor(object.kind, keepAspect) : [];
  const frame: Rect = box;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-roledescription={role}
      aria-pressed={selected}
      aria-label={text === '' ? `${role}, ${pageNumber}` : `${role}, ${pageNumber}: ${text}`}
      data-annot-frame={`insert-${object.id}`}
      data-insert-frame={object.id}
      data-state={selected ? 'selected' : 'idle'}
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        ...(interactive ? { pointerEvents: 'auto', cursor: object.locked ? 'default' : 'move' } : {}),
      }}
      onPointerDown={(event) => interactive && api.onItemPointerDown(object, event)}
      onFocus={() => api.onItemFocus(object)}
      onBlur={api.onItemBlur}
      onKeyDown={(event) => api.onItemKeyDown(object, event)}
    >
      <span data-annot-box="" aria-hidden="true" />
      <span data-annot-ring="" aria-hidden="true" />
      {handles.map((handle) => {
        const p = handleAt(frame, handle);
        return (
          <span
            key={handle}
            data-annot-handle={handle}
            aria-hidden="true"
            style={{ left: p.x - frame.x, top: p.y - frame.y, cursor: handleCursor(handle) }}
            onPointerDown={(event) => api.onHandlePointerDown(object, handle, event)}
          />
        );
      })}
    </div>
  );
});
