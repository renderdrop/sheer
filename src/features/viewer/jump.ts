import type { Annotation } from '../../api/annotations';
import { EASE_OUT } from '../../lib/motion';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { DEFAULT_PAGE_SIZE, positionOf, sizesFor, usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { fileRotationOf } from './fileRotation';
import { waitForJumpEnd } from './scrollBridge';
import { boxToView, totalRotation, unrotatedSize } from './transform';
import { useViewer } from './useViewer';

/**
 * Comment jump (MOTION spell 8): the canvas scrolls to an annotation (ease-out, duration by distance, capped at
 * `--motion-scroll-max`), then its frame pulses once (opacity 1, .4, 1 in two `--motion-fast`). Reduced motion: the jump is
 * instant (the canvas does it) and a 2 px Ink outline marks the annotation for `--hold-outline`, no pulse.
 */

/** `--motion-scroll-max`, `--motion-base` and `--motion-fast` of tokens.css, in ms; the tests hold the numbers. */
/** Mirrors --motion-scroll-max, --motion-base, --motion-fast, --hold-outline (motionSpells.test.tsx compares them with tokens.css). */
export const SCROLL_MAX_MS = 300;
export const SCROLL_MIN_MS = 160;
export const PULSE_STEP_MS = 120;
export const HOLD_OUTLINE_MS = 1000;
/** A jump over this many viewports takes the full cap. */
const FULL_DISTANCE_VIEWPORTS = 2;
const FRAME_TRIES = 30;
/** The pulse is two steps long (1 to .4 to 1). */
const PULSE_MS = (step: number): number => 2 * step;

/** How long a scroll of `distance` px takes in a viewport of `viewport` px: `--motion-base` for a nudge, up to the cap, never above. */
export function jumpDurationMs(distance: number, viewport: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(viewport) || viewport <= 0) return SCROLL_MIN_MS;
  const share = Math.min(1, Math.abs(distance) / (FULL_DISTANCE_VIEWPORTS * viewport));
  return Math.min(SCROLL_MAX_MS, SCROLL_MIN_MS + share * (SCROLL_MAX_MS - SCROLL_MIN_MS));
}

/** The ease-out of the jump for Motion (`--ease-out`). */
export const JUMP_EASE = EASE_OUT;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function tokenMs(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && raw.endsWith('ms') ? value : fallback;
}

/** The pulse (or, reduced, the outline) of an annotation's frame. The page may still be coming into view: the frame is looked for. */
export function pulseAnnotation(id: number): void {
  if (typeof window === 'undefined') return;
  const reduced = reducedMotion();
  let tries = 0;
  const look = () => {
    // The environment may be gone by the time a frame runs (a test that ended, a closed window).
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const frame = document.querySelector<HTMLElement>(`[data-annot-frame="${id}"]`);
    if (frame !== null) {
      if (reduced) {
        frame.style.outline = 'var(--outline-jump) solid var(--color-ink)';
        window.setTimeout(
          () => {
            frame.style.outline = '';
          },
          tokenMs('--hold-outline', HOLD_OUTLINE_MS),
        );
      } else if (typeof frame.animate === 'function') {
        const step = tokenMs('--motion-fast', PULSE_STEP_MS);
        frame.animate(
          { opacity: [1, 0.4, 1] },
          { duration: PULSE_MS(step), easing: `cubic-bezier(${EASE_OUT.join(', ')})` },
        );
      }
      return;
    }
    tries += 1;
    if (tries < FRAME_TRIES) window.requestAnimationFrame(look);
  };
  window.requestAnimationFrame(look);
}

/** Where the top of `annotation` is in the page as the view shows it (rotations applied), in points. */
function topInView(docId: number, annotation: Annotation): number {
  const view = useView.getState().byDoc[docId];
  if (view === undefined) return 0;
  const sizes = sizesFor(usePages.getState(), docId, view.pageCount);
  const drawn = sizes[positionOf(docId, annotation.pageId) ?? annotation.pageId] ?? DEFAULT_PAGE_SIZE;
  const file = fileRotationOf(docId, annotation.pageId);
  return boxToView(annotation.rect, unrotatedSize(drawn, file), totalRotation(file, view.rotation)).y;
}

/** Whether the annotation's frame is wholly inside the canvas region now (then a jump only pulses). */
function inView(id: number): boolean {
  const frame = document.querySelector<HTMLElement>(`[data-annot-frame="${id}"]`);
  const region = frame?.closest<HTMLElement>('[role="region"]');
  if (frame === null || frame === undefined || region === null || region === undefined) return false;
  const a = frame.getBoundingClientRect();
  const b = region.getBoundingClientRect();
  return a.top >= b.top && a.bottom <= b.bottom;
}

/**
 * Scrolls the canvas to the annotation `id` of document `docId` and pulses it; the annotation is selected. `pageId` is optional (the
 * annotation's own page is looked up). Focus stays where it is. Does nothing for an annotation the store does not know.
 */
export function jumpToAnnotation(docId: number, id: number, pageId?: number): void {
  const store = useAnnotations.getState();
  const known = store.byDoc[docId]?.byId[id];
  const page = known?.pageId ?? pageId;
  if (page === undefined) return;
  if (selectActiveId(useDocuments.getState()) !== docId) return;
  if (known !== undefined && inView(id)) {
    store.select(docId, [id]);
    pulseAnnotation(id);
    return;
  }
  const finish = () => {
    store.select(docId, [id]);
    waitForJumpEnd(() => pulseAnnotation(id), SCROLL_MAX_MS + PULSE_STEP_MS);
  };
  void store
    .loadPage(docId, page)
    .catch(() => undefined)
    .then(() => {
      if (typeof window === 'undefined') return;
      const annotation = useAnnotations.getState().byDoc[docId]?.byId[id] ?? known;
      const position = positionOf(docId, page) ?? page;
      if (annotation === undefined) useViewer.getState().goToPage(position);
      else useViewer.getState().goToPoint(position, topInView(docId, annotation));
      finish();
    });
}
