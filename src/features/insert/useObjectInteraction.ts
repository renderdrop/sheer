import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { PageSize } from '../../api/render';
import type { Rect } from '../../api/wire';
import { useAnnotations } from '../../stores/annotations';
import { arrowStep, type HandleId } from '../annotations/selection/geometry';
import type { Rotation } from '../viewer/transform';
import { deleteObjects, moveObjects, updateObject } from './actions';
import { BIG_NUDGE_PT, movedRect, NUDGE_PT, resizedRect, sameRect, viewDeltaToPage } from './geometry';
import { selectionIds, useInsert, type ContentObject } from './store';

/** A pointer must travel this far (screen px) before a press on an object becomes a drag. */
export const DRAG_THRESHOLD_PX = 4;
/** Nudges by key within this time are one undo step. */
export const NUDGE_COALESCE_MS = 500;

type Draft =
  | { kind: 'move'; id: number; dx: number; dy: number }
  | { kind: 'resize'; id: number; handle: HandleId; dx: number; dy: number; keepAspect: boolean };

export interface InteractionParams {
  docId: number;
  /** The page's own rotation, so a nudge goes the way the arrow points on screen. */
  page: PageSize;
  pxPerPt: number;
  rotation: Rotation;
  objects: readonly ContentObject[];
  /** Enter or a double click on a text box. */
  onEdit: (object: ContentObject) => void;
}

export interface Interaction {
  /** The boxes of what is being moved or resized, by id. */
  preview: ReadonlyMap<number, Rect>;
  onItemPointerDown: (object: ContentObject, event: PointerEvent) => void;
  onHandlePointerDown: (object: ContentObject, handle: HandleId, event: PointerEvent) => void;
  onItemKeyDown: (object: ContentObject, event: KeyboardEvent) => void;
  onItemFocus: (object: ContentObject) => void;
  onItemBlur: () => void;
}

function draftBox(object: ContentObject, draft: Draft, page: PageSize): Rect {
  if (draft.kind === 'move') return movedRect(object.box, draft.dx, draft.dy, page);
  const keep = object.kind === 'image' && draft.keepAspect;
  return resizedRect(object.kind, object.box, draft.handle, draft.dx, draft.dy, keep, page);
}

/** Selecting, moving, resizing, nudging and deleting the text boxes and images of one page (DESIGN 3.36, 3.23). */
export function useObjectInteraction(params: InteractionParams): Interaction {
  const { docId, page, pxPerPt, rotation, objects, onEdit } = params;
  const [draft, setDraft] = useState<Draft | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const nudging = useRef<{
    id: number;
    dx: number;
    dy: number;
    resize: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const select = useCallback(
    (id: number) => {
      useAnnotations.getState().clearSelection(docId);
      useInsert.getState().select(docId, id);
    },
    [docId],
  );

  const find = useCallback((id: number) => objects.find((o) => o.id === id), [objects]);

  const toPage = useCallback(
    (dxPx: number, dyPx: number) => viewDeltaToPage(dxPx / pxPerPt, dyPx / pxPerPt, page, rotation),
    [page, pxPerPt, rotation],
  );

  const commit = useCallback(
    async (object: ContentObject, d: Draft) => {
      const box = draftBox(object, d, page);
      if (sameRect(box, object.box)) return;
      const ids = selectionIds(useInsert.getState(), docId);
      if (d.kind === 'move' && ids.length > 1 && ids.includes(object.id)) {
        await moveObjects(docId, ids, box.x - object.box.x, box.y - object.box.y);
        return;
      }
      await updateObject(docId, object.id, { box });
    },
    [docId, page],
  );

  const flushNudge = useCallback(() => {
    const pending = nudging.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    nudging.current = null;
    const object = find(pending.id);
    if (object === undefined) {
      setDraft(null);
      return;
    }
    const d: Draft = pending.resize
      ? {
          kind: 'resize',
          id: pending.id,
          handle: object.kind === 'textBox' ? 'e' : 'se',
          dx: pending.dx,
          dy: pending.dy,
          keepAspect: true,
        }
      : { kind: 'move', id: pending.id, dx: pending.dx, dy: pending.dy };
    void commit(object, d).finally(() => setDraft(null));
  }, [commit, find]);

  // Leaving the page with a nudge waiting still writes it.
  const flushRef = useRef(flushNudge);
  useEffect(() => {
    flushRef.current = flushNudge;
  });
  useEffect(() => () => flushRef.current(), []);
  useEffect(() => () => cancel.current?.(), []);

  /** Follows the pointer from `event` on (the window listens, so the drag goes on off the page); Esc cancels. */
  const drag = useCallback(
    (object: ContentObject, event: PointerEvent, make: (dx: number, dy: number, shift: boolean) => Draft) => {
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let last: Draft | null = null;
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        cancel.current = null;
      };
      function onMove(e: globalThis.PointerEvent) {
        const dxPx = e.clientX - startX;
        const dyPx = e.clientY - startY;
        if (!active && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
        active = true;
        const delta = toPage(dxPx, dyPx);
        last = make(delta.x, delta.y, e.shiftKey);
        setDraft(last);
      }
      function onUp() {
        stop();
        const done = last;
        if (!active || done === null) {
          setDraft(null);
          return;
        }
        void commit(object, done).finally(() => setDraft(null));
      }
      function onCancel() {
        stop();
        setDraft(null);
      }
      function onKey(e: globalThis.KeyboardEvent) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      cancel.current = stop;
    },
    [commit, toPage],
  );

  const onItemPointerDown = useCallback(
    (object: ContentObject, event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      flushNudge();
      const shift = event.shiftKey;
      const alreadySelected = selectionIds(useInsert.getState(), docId).includes(object.id);
      if (shift) {
        useAnnotations.getState().clearSelection(docId);
        useInsert.getState().toggle(docId, object.id);
      } else if (!alreadySelected) {
        select(object.id);
      }
      (event.currentTarget as HTMLElement)
        .closest('[data-insert-layer]')
        ?.querySelector<HTMLElement>(`[data-insert-frame="${object.id}"]`)
        ?.focus({ preventScroll: true });
      if (shift) return;
      if (object.kind === 'textBox' && event.detail >= 2) {
        onEdit(object);
        return;
      }
      drag(object, event, (dx, dy) => ({ kind: 'move', id: object.id, dx, dy }));
    },
    [docId, drag, flushNudge, onEdit, select],
  );

  const onHandlePointerDown = useCallback(
    (object: ContentObject, handle: HandleId, event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      flushNudge();
      select(object.id);
      drag(object, event, (dx, dy, shift) => ({
        kind: 'resize',
        id: object.id,
        handle,
        dx,
        dy,
        // Shift toggles the lock (DESIGN 3.36).
        keepAspect: useInsert.getState().lockAspect !== shift,
      }));
    },
    [drag, flushNudge, select],
  );

  const nudge = useCallback(
    (object: ContentObject, dx: number, dy: number, resize: boolean) => {
      const pending = nudging.current;
      const same = pending !== null && pending.id === object.id && pending.resize === resize;
      if (pending !== null && !same) flushNudge();
      if (same) clearTimeout(pending.timer);
      const base = {
        id: object.id,
        resize,
        dx: (same ? pending.dx : 0) + dx,
        dy: (same ? pending.dy : 0) + dy,
        timer: setTimeout(flushNudge, NUDGE_COALESCE_MS),
      };
      nudging.current = base;
      setDraft(
        resize
          ? {
              kind: 'resize',
              id: object.id,
              handle: object.kind === 'textBox' ? 'e' : 'se',
              dx: base.dx,
              dy: base.dy,
              keepAspect: true,
            }
          : { kind: 'move', id: object.id, dx: base.dx, dy: base.dy },
      );
    },
    [flushNudge],
  );

  const onItemKeyDown = useCallback(
    (object: ContentObject, event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const step = arrowStep(event.key);
      if (step !== null) {
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        const unit = event.shiftKey ? BIG_NUDGE_PT : NUDGE_PT;
        // The arrows go the way they point on screen: the step is in screen points, then turned into page space.
        const delta = viewDeltaToPage(step.x * unit, step.y * unit, page, rotation);
        nudge(object, delta.x, delta.y, event.altKey);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        flushNudge();
        const ids = selectionIds(useInsert.getState(), docId);
        void deleteObjects(docId, ids.includes(object.id) ? ids : [object.id]);
      } else if (event.key === 'Enter' && object.kind === 'textBox') {
        event.preventDefault();
        onEdit(object);
      } else if (event.key === 'Escape') {
        if (nudging.current !== null) {
          event.preventDefault();
          clearTimeout(nudging.current.timer);
          nudging.current = null;
          setDraft(null);
        } else if ((useInsert.getState().selected[docId] ?? null) !== null) {
          event.preventDefault();
          useInsert.getState().select(docId, null);
        }
      }
    },
    [docId, flushNudge, nudge, onEdit, page, rotation],
  );

  // Focus selects (DESIGN 3.23): a Tab stop that is not the selection becomes the selection.
  const onItemFocus = useCallback(
    (object: ContentObject) => {
      if (!selectionIds(useInsert.getState(), docId).includes(object.id)) select(object.id);
    },
    [docId, select],
  );

  const selected = useInsert((s) => s.selected[docId]);
  const extra = useInsert((s) => s.extra[docId]);
  const selection = useMemo(
    () => (selected === null || selected === undefined ? [] : [selected, ...(extra ?? [])]),
    [selected, extra],
  );

  const preview = useMemo(() => {
    const map = new Map<number, Rect>();
    if (draft === null) return map;
    const object = objects.find((o) => o.id === draft.id);
    if (object === undefined) return map;
    map.set(object.id, draftBox(object, draft, page));
    if (draft.kind === 'move' && selection.includes(object.id)) {
      // The other selected objects of the page follow by the same distance as the one being dragged.
      const box = draftBox(object, draft, page);
      for (const other of objects) {
        if (other.id !== object.id && selection.includes(other.id)) {
          map.set(other.id, movedRect(other.box, box.x - object.box.x, box.y - object.box.y, page));
        }
      }
    }
    return map;
  }, [draft, objects, page, selection]);

  return { preview, onItemPointerDown, onHandlePointerDown, onItemKeyDown, onItemFocus, onItemBlur: flushNudge };
}
