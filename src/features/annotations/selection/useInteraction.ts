import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type { Annotation } from '../../../api/annotations';
import { toAppError } from '../../../api/errors';
import type { PageSize } from '../../../api/render';
import { runHistoryStep } from '../../../actions/history';
import { announce } from '../../../components';
import { useT } from '../../../i18n';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { viewToPage, type Rotation } from '../../viewer/transform';
import type { Point } from '../../../api/wire';
import {
  ROTATE_SNAP_DEG,
  angleOf,
  angleToward,
  arrowStep,
  canMove,
  canRotate,
  clampMove,
  handlesOf,
  hitsAnnotation,
  isTextMarkup,
  normalizeAngle,
  patchOf,
  readingOrder,
  resized,
  rotateHandleAt,
  translated,
  turnedTo,
  type HandleId,
} from './geometry';

/** A pointer must travel this far (screen px) before a press on an annotation becomes a drag (DESIGN 3.23). */
export const DRAG_THRESHOLD_PX = 4;
/** Nudges by key within this time are one undo step (DESIGN 3.23). */
export const NUDGE_COALESCE_MS = 500;
/** A nudge by Shift+arrow, in points. */
export const BIG_STEP_PT = 10;

/** What is being done to the annotations, as a preview: a move of some, or one resize. */
export type Draft =
  | { kind: 'move'; ids: readonly number[]; dx: number; dy: number }
  | { kind: 'resize'; id: number; handle: HandleId; dx: number; dy: number; keepAspect: boolean }
  /** A signature or mark turned to an absolute angle in degrees (ADR-105). */
  | { kind: 'rotate'; id: number; angle: number };

export interface InteractionParams {
  docId: number;
  pageIndex: number;
  /** The page in page space (before any rotation). */
  page: PageSize;
  pxPerPt: number;
  /** The rotation of page space on screen, file and view together. */
  rotation: Rotation;
  list: readonly Annotation[];
}

/** The handlers of the annotations of a page. The object never changes, so the annotations' frames do not render for it. */
export interface Handlers {
  onItemPointerDown: (a: Annotation, event: PointerEvent) => void;
  onHandlePointerDown: (a: Annotation, handle: HandleId, event: PointerEvent) => void;
  onItemKeyDown: (a: Annotation, event: KeyboardEvent) => void;
  onItemFocus: (a: Annotation) => void;
  onItemBlur: () => void;
  /**
   * A press that a creation or placement layer received at `at` (page space): if it is on a movable annotation, that annotation is
   * selected and dragged instead of a new one being made, and this returns true (ADR-105). `slop` is the reach of a click on a thin
   * line, in points.
   */
  onGrab: (event: PointerEvent, at: Point, slop: number) => boolean;
}

export interface Interaction {
  /** The previews of what is in progress, by annotation id. */
  preview: ReadonlyMap<number, Annotation>;
  handlers: Handlers;
}

const NO_PREVIEW: ReadonlyMap<number, Annotation> = new Map();

/**
 * Selecting, moving and resizing the annotations of one page (DESIGN 3.23). The pointer and the keyboard both produce a `Draft`
 * that the layer draws as a preview; the draft becomes one command when the pointer is released or the nudges have rested for
 * `NUDGE_COALESCE_MS`: `moveAnnotations` for a move (one undo step for any number of annotations), `updateAnnotation` for a
 * resize. The preview stays until the command has answered, so the annotation never jumps back for a moment.
 */
export function useInteraction(params: InteractionParams): Interaction {
  const t = useT();
  const latest = useRef(params);
  // The handlers read the newest props when an event arrives, not the ones of the render that made them.
  useLayoutEffect(() => {
    latest.current = params;
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nudging = useRef<Draft | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  /** The elements that a move in progress offsets by CSS, and whether one is in progress (the layout effect below resets them). */
  const moved = useRef<HTMLElement[]>([]);
  const dragging = useRef(false);
  const frame = useRef<number | null>(null);
  const resetMoved = () => {
    for (const element of moved.current) {
      element.style.removeProperty('transform');
      element.style.removeProperty('translate');
    }
    moved.current = [];
  };
  // The preview of a move is a CSS offset on the elements themselves: no render per pointer event. When the drag is over, the draft
  // is the final one, the elements are drawn there, and the offset goes in the same frame.
  useLayoutEffect(() => {
    if (!dragging.current) resetMoved();
  }, [draft]);

  const report = (caught: unknown) => useUi.getState().showBanner(toAppError(caught));

  /** A delta in screen px as page space (the rotation undone). */
  const toPage = useCallback((dxPx: number, dyPx: number) => {
    const { page, pxPerPt, rotation } = latest.current;
    const at = viewToPage({ x: dxPx / pxPerPt, y: dyPx / pxPerPt }, page, rotation);
    const origin = viewToPage({ x: 0, y: 0 }, page, rotation);
    return { x: at.x - origin.x, y: at.y - origin.y };
  }, []);

  const selected = (): readonly number[] => useAnnotations.getState().selectedIds[latest.current.docId] ?? [];
  const select = (ids: readonly number[]) => useAnnotations.getState().select(latest.current.docId, ids);

  /** Runs a draft as a command; the preview is dropped when it has answered. */
  const commit = useCallback((d: Draft): Promise<void> => {
    const { docId, list } = latest.current;
    const store = useAnnotations.getState();
    let run: Promise<unknown> | null = null;
    if (d.kind === 'move') {
      if (d.dx !== 0 || d.dy !== 0)
        run = store.apply(docId, { type: 'moveAnnotations', ids: d.ids, dx: d.dx, dy: d.dy });
    } else if (d.kind === 'rotate') {
      const original = list.find((a) => a.id === d.id);
      if (original && angleOf(original) !== d.angle) {
        run = store.apply(docId, { type: 'updateAnnotation', id: d.id, patch: { angle: d.angle } });
      }
    } else {
      const original = list.find((a) => a.id === d.id);
      const next = original && resized(original, d.handle, d.dx, d.dy, d.keepAspect, latest.current.page);
      if (original && next) {
        run = store.apply(docId, {
          type: 'updateAnnotation',
          id: d.id,
          patch: patchOf(next),
          coalesce: `resize.${d.id}`,
        });
      }
    }
    return (run ?? Promise.resolve()).then(
      () => {
        if (mounted.current) setDraft(null);
      },
      (caught: unknown) => {
        if (mounted.current) setDraft(null);
        report(caught);
      },
    );
  }, []);

  /** Drops the nudges that wait (Esc): nothing is written and the annotation is back where it was. */
  const cancelNudge = useCallback(() => {
    clearTimeout(nudgeTimer.current);
    nudgeTimer.current = undefined;
    nudging.current = null;
    setDraft(null);
  }, []);

  const flushNudge = useCallback(() => {
    clearTimeout(nudgeTimer.current);
    nudgeTimer.current = undefined;
    const pending = nudging.current;
    nudging.current = null;
    if (pending !== null) void commit(pending);
  }, [commit]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelDrag.current?.();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Unmounted with a nudge waiting (the page scrolled away): it is still the user's edit.
      const pending = nudging.current;
      clearTimeout(nudgeTimer.current);
      if (pending !== null) void commit(pending);
    };
  }, [commit]);

  const movable = (): number[] => {
    const byId = useAnnotations.getState().byDoc[latest.current.docId]?.byId ?? {};
    return selected().filter((id) => {
      const a = byId[id];
      return a !== undefined && canMove(a);
    });
  };

  const clampedMove = (ids: readonly number[], dx: number, dy: number) => {
    const rects = latest.current.list.filter((a) => ids.includes(a.id)).map((a) => a.rect);
    return clampMove(rects, dx, dy, latest.current.page);
  };

  /**
   * A press that may become a drag. `make` turns the pointer's travel (screen px) into a draft; `click` runs if it never travelled
   * `DRAG_THRESHOLD_PX`. Esc cancels. The window listens, so the drag follows the pointer off the page.
   */
  const startDrag = (
    event: PointerEvent,
    make: (dxPx: number, dyPx: number, shift: boolean) => Draft,
    click: () => void,
    /** Draws a move without a render: it offsets the moved elements (`applyMove`). */
    live?: (d: Draft) => void,
  ) => {
    cancelDrag.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let last: Draft | null = null;
    /** The newest draft waits for the next animation frame: the pointer may report faster than the screen draws. */
    const show = (d: Draft) => {
      last = d;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (last === null) return;
        if (live) live(last);
        else setDraft(last);
      });
    };
    const stop = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      cancelDrag.current = null;
    };
    const onMove = (e: globalThis.PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!active && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const first = !active;
      active = true;
      const next = make(dx, dy, e.shiftKey);
      if (first && live && next.kind === 'move') {
        // The drawing of the moved annotations switches to their previews once; every move after that is a CSS offset.
        dragging.current = true;
        setDraft({ ...next, dx: 0, dy: 0 });
      }
      show(next);
    };
    const onUp = () => {
      stop();
      if (active && last !== null) {
        dragging.current = false;
        const done = last;
        setDraft(done);
        void commit(done);
      } else click();
    };
    const onCancel = () => {
      stop();
      dragging.current = false;
      resetMoved();
      setDraft(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    cancelDrag.current = () => {
      stop();
      dragging.current = false;
      resetMoved();
      setDraft(null);
    };
  };

  const onItemPointerDown = (a: Annotation, event: PointerEvent) => {
    if (event.button !== 0) return;
    flushNudge();
    const current = selected();
    const toggle = event.shiftKey || event.ctrlKey || event.metaKey;
    if (toggle) {
      select(current.includes(a.id) ? current.filter((id) => id !== a.id) : [...current, a.id]);
      if (current.includes(a.id)) return;
    } else if (!current.includes(a.id)) {
      select([a.id]);
    }
    // Keyboard focus follows the press, so the arrows and Delete act on it.
    (event.currentTarget as HTMLElement | null)
      ?.closest('[data-annot-layer]')
      ?.querySelector<HTMLElement>(`[data-annot-frame="${a.id}"]`)
      ?.focus({ preventScroll: true });
    const ids = movable();
    if (!ids.includes(a.id)) return;
    event.preventDefault();
    const root = (event.currentTarget as Element | null)?.closest('[data-annot-layer]') ?? null;
    startDrag(
      event,
      (dxPx, dyPx, shift) => {
        const constrained = shift ? (Math.abs(dxPx) >= Math.abs(dyPx) ? [dxPx, 0] : [0, dyPx]) : [dxPx, dyPx];
        const delta = toPage(constrained[0] ?? 0, constrained[1] ?? 0);
        const clamped = clampedMove(ids, delta.x, delta.y);
        return { kind: 'move', ids, dx: clamped.x, dy: clamped.y };
      },
      () => {
        // A click on one of several selected annotations narrows the selection to it.
        if (!toggle && selected().length > 1) select([a.id]);
      },
      (d) => applyMove(root, d),
    );
  };

  /** Offsets the drawn shape and the frame of each annotation of a move draft by CSS; nothing is rendered. */
  const applyMove = (root: Element | null, d: Draft) => {
    if (root === null || d.kind !== 'move') return;
    for (const id of d.ids) {
      const selector = `[data-annot-item="${id}"], [data-annot-frame="${id}"]`;
      for (const element of root.querySelectorAll<HTMLElement>(selector)) {
        // Page space is the layer's own unit (it is scaled as a whole), so the offset is in points.
        if (element.hasAttribute('data-annot-item')) element.style.transform = `translate(${d.dx}px, ${d.dy}px)`;
        else element.style.translate = `${d.dx}px ${d.dy}px`;
        if (!moved.current.includes(element)) moved.current.push(element);
      }
    }
  };

  const onGrab = (event: PointerEvent, at: Point, slop: number): boolean => {
    if (event.button !== 0) return false;
    const hit = readingOrder(latest.current.list)
      .reverse()
      .find((a) => a.state === undefined && canMove(a) && !isTextMarkup(a) && hitsAnnotation(a, at, slop));
    if (hit === undefined) return false;
    onItemPointerDown(hit, event);
    return true;
  };

  const onHandlePointerDown = (a: Annotation, handle: HandleId, event: PointerEvent) => {
    if (event.button !== 0 || !handlesOf(a).includes(handle)) return;
    event.preventDefault();
    event.stopPropagation();
    flushNudge();
    if (handle === 'rotate') {
      if (!canRotate(a) || (a.kind !== 'signature' && a.kind !== 'mark')) return;
      // The turn follows where the pointer is about the centre of the box: the handle's own position plus the pointer's travel.
      const { box } = a;
      const from = rotateHandleAt(box, angleOf(a));
      startDrag(
        event,
        (dxPx, dyPx, shift) => {
          const delta = toPage(dxPx, dyPx);
          return {
            kind: 'rotate',
            id: a.id,
            angle: angleToward(box, { x: from.x + delta.x, y: from.y + delta.y }, shift),
          };
        },
        () => undefined,
      );
      return;
    }
    startDrag(
      event,
      (dxPx, dyPx, shift) => {
        const delta = toPage(dxPx, dyPx);
        return { kind: 'resize', id: a.id, handle, dx: delta.x, dy: delta.y, keepAspect: shift };
      },
      () => undefined,
    );
  };

  const nudge = (kind: 'move' | 'resize', a: Annotation, vx: number, vy: number) => {
    const step = toPage(vx * latest.current.pxPerPt, vy * latest.current.pxPerPt);
    const before = nudging.current;
    let next: Draft;
    if (kind === 'move') {
      const ids = before?.kind === 'move' ? before.ids : movable().includes(a.id) ? movable() : [];
      if (ids.length === 0) return;
      const total = clampedMove(
        ids,
        (before?.kind === 'move' ? before.dx : 0) + step.x,
        (before?.kind === 'move' ? before.dy : 0) + step.y,
      );
      next = { kind: 'move', ids, dx: total.x, dy: total.y };
    } else {
      const handle: HandleId | undefined = handlesOf(a).includes('se')
        ? 'se'
        : handlesOf(a).includes('to')
          ? 'to'
          : undefined;
      if (handle === undefined) {
        // Nothing to say it with otherwise: the keys do nothing, and the user hears why.
        announce(t('annot.resizeUnavailable'));
        return;
      }
      const same = before?.kind === 'resize' && before.id === a.id;
      next = {
        kind: 'resize',
        id: a.id,
        handle,
        dx: (same ? before.dx : 0) + step.x,
        dy: (same ? before.dy : 0) + step.y,
        keepAspect: false,
      };
    }
    // A different kind of change than the one waiting is a step of its own.
    if (
      before !== null &&
      (before.kind !== next.kind || (before.kind === 'resize' && next.kind === 'resize' && before.id !== next.id))
    ) {
      flushNudge();
    }
    nudging.current = next;
    setDraft(next);
    clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(flushNudge, NUDGE_COALESCE_MS);
  };

  const remove = (ids: readonly number[], a: Annotation) => {
    const { docId } = latest.current;
    const label = t(`annot.type.${a.kind}`);
    useAnnotations
      .getState()
      .apply(docId, { type: 'deleteAnnotations', ids })
      .then(() => {
        useUi.getState().showToast({
          message: t('annot.deleted', { type: label }),
          action: { label: t('action.undo'), run: () => runHistoryStep('undo') },
        });
      }, report);
  };

  const onItemKeyDown = (a: Annotation, event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && canRotate(a)) {
      // Alt+Shift+Left and Right turn a signature or mark by 15 degrees, one undo step each.
      event.preventDefault();
      flushNudge();
      const current = angleOf(latest.current.list.find((x) => x.id === a.id) ?? a);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const angle = normalizeAngle(
        Math.round(current / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG + direction * ROTATE_SNAP_DEG,
      );
      useAnnotations
        .getState()
        .apply(latest.current.docId, { type: 'updateAnnotation', id: a.id, patch: { angle } })
        .catch(report);
      return;
    }
    const step = arrowStep(event.key);
    if (step !== null) {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const unit = event.shiftKey ? BIG_STEP_PT : 1;
      // The arrows go the way they point on screen: the step is in screen points, then turned into page space.
      nudge(event.altKey ? 'resize' : 'move', a, step.x * unit, step.y * unit);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      flushNudge();
      const current = selected();
      const ids = current.includes(a.id) ? current : [a.id];
      if (!a.locked) remove(ids, a);
    } else if (event.key === ' ' && event.shiftKey) {
      event.preventDefault();
      const current = selected();
      select(current.includes(a.id) ? current.filter((id) => id !== a.id) : [...current, a.id]);
    } else if (event.key === 'Escape' && nudging.current !== null) {
      // The first Esc takes back the nudges that are still waiting; the selection stays.
      event.preventDefault();
      cancelNudge();
    } else if (event.key === 'Escape' && selected().length > 0) {
      event.preventDefault();
      select([]);
    }
  };

  // Focus selects (DESIGN 3.23): a Tab stop that is not in the selection becomes the selection.
  const onItemFocus = (a: Annotation) => {
    if (!selected().includes(a.id)) select([a.id]);
  };

  const preview = useMemo(() => {
    if (draft === null) return NO_PREVIEW;
    const map = new Map<number, Annotation>();
    for (const a of params.list) {
      if (draft.kind === 'move' && draft.ids.includes(a.id)) {
        map.set(a.id, translated(a, draft.dx, draft.dy));
      } else if (draft.kind === 'rotate' && draft.id === a.id) {
        map.set(a.id, turnedTo(a, draft.angle));
      } else if (draft.kind === 'resize' && draft.id === a.id) {
        const next = resized(a, draft.handle, draft.dx, draft.dy, draft.keepAspect, params.page);
        if (next !== null) map.set(a.id, next);
      }
    }
    return map;
  }, [draft, params.list, params.page]);

  const current = {
    onItemPointerDown,
    onHandlePointerDown,
    onItemKeyDown,
    onItemFocus,
    onItemBlur: flushNudge,
    onGrab,
  };
  const impl = useRef(current);
  useLayoutEffect(() => {
    impl.current = current;
  });
  const handlers = useMemo<Handlers>(
    () => ({
      onItemPointerDown: (a, event) => impl.current.onItemPointerDown(a, event),
      onHandlePointerDown: (a, handle, event) => impl.current.onHandlePointerDown(a, handle, event),
      onItemKeyDown: (a, event) => impl.current.onItemKeyDown(a, event),
      onItemFocus: (a) => impl.current.onItemFocus(a),
      onItemBlur: () => impl.current.onItemBlur(),
      onGrab: (event, at, slop) => impl.current.onGrab(event, at, slop),
    }),
    [],
  );
  return { preview, handlers };
}
