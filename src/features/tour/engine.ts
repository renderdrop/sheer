import type { Annotation } from '../../api/annotations';
import type { Rect } from './steps';

/**
 * The completion conditions of the welcome tour's steps (DESIGN 3.14), as pure functions of what the view stores report. The
 * store reports a zoom only once it has been committed at rest, so "at rest" needs no check here.
 */

/** The page must hold still this long before the Navigate step counts (the page announcement's delay, DESIGN 3.10). */
export const NAVIGATE_SETTLE_MS = 500;

/** How long the "done" card is held before the next step (or the end) follows, ms. */
export const HOLD_MS = 600;

/** What the engine knows of the document's view. */
export interface ViewReading {
  /** Zero-based current page. */
  pageIndex: number;
  zoom: number;
}

/** What was true when the step started. */
export interface Baseline {
  zoom: number;
}

/** What the document-reading steps need (DESIGN 3.46): the annotations, the page order and the step's geometry in page space. */
export interface StepFacts {
  annotations: readonly Annotation[];
  /** Page ids in their current order. */
  pageOrder: readonly number[];
  /** Page id of the page the step happens on (Highlight, Note, Sign), null when it is unknown. */
  pageId: number | null;
  target?: Rect;
  quad?: Rect;
  /** Reorder: the page that has to move up (S) and the page it has to get above (M), as page ids. */
  moves?: number;
  above?: number;
}

/** A highlight must cover this share of the sentence (DESIGN 3.14 step 4). */
export const HIGHLIGHT_COVERAGE = 0.5;
/** A note counts when it is anchored this close to the spot's centre, pt (DESIGN 3.14 step 5). */
export const NOTE_RADIUS_PT = 24;
/** Keyboard nudges of a placed signature settle this long before the Sign step counts (DESIGN 3.46). */
export const SIGN_SETTLE_MS = 400;

/** Whether the union of the highlights' boxes on the page covers HIGHLIGHT_COVERAGE of the sentence along its line. */
export function highlightCovers(annotations: readonly Annotation[], pageId: number, sentence: Rect): boolean {
  const spans: [number, number][] = [];
  for (const annotation of annotations) {
    if (annotation.pageId !== pageId || annotation.kind !== 'highlight') continue;
    for (const quad of annotation.quads) {
      const xs = quad.map((point) => point.x);
      const ys = quad.map((point) => point.y);
      const overlap = Math.min(Math.max(...ys), sentence.y + sentence.h) - Math.max(Math.min(...ys), sentence.y);
      // A box on another line of text does not count: it must share half of the sentence's height.
      if (overlap < sentence.h / 2) continue;
      const from = Math.max(Math.min(...xs), sentence.x);
      const to = Math.min(Math.max(...xs), sentence.x + sentence.w);
      if (to > from) spans.push([from, to]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [from, to] of spans) {
    covered += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return covered >= sentence.w * HIGHLIGHT_COVERAGE - 1e-9;
}

/** Whether a note (not a reply) on the page is anchored within NOTE_RADIUS_PT of the spot's centre. */
export function noteNear(annotations: readonly Annotation[], pageId: number, spot: Rect): boolean {
  const cx = spot.x + spot.w / 2;
  const cy = spot.y + spot.h / 2;
  return annotations.some(
    (annotation) =>
      annotation.pageId === pageId &&
      annotation.kind === 'note' &&
      annotation.inReplyTo === null &&
      Math.hypot(annotation.at.x - cx, annotation.at.y - cy) <= NOTE_RADIUS_PT,
  );
}

/** Whether a signature or initials on the page has its centre in the frame (placed there or dragged there). */
export function signatureIn(annotations: readonly Annotation[], pageId: number, frame: Rect): boolean {
  return annotations.some((annotation) => {
    if (annotation.pageId !== pageId || annotation.kind !== 'signature') return false;
    const cx = annotation.box.x + annotation.box.w / 2;
    const cy = annotation.box.y + annotation.box.h / 2;
    return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
  });
}

/** Whether page `moves` precedes page `above` in the page order, whatever moved it. */
export function precedes(pageOrder: readonly number[], moves: number, above: number): boolean {
  const first = pageOrder.indexOf(moves);
  const second = pageOrder.indexOf(above);
  return first >= 0 && second >= 0 && first < second;
}

/**
 * Whether the state satisfies the step right now. `open` has no state to read: the engine completes it once the first frame has
 * faded in. A step this does not know is never complete by itself.
 */
export function isSatisfied(stepId: string, view: ViewReading, baseline: Baseline, facts?: StepFacts): boolean {
  switch (stepId) {
    case 'navigate':
      return view.pageIndex >= 1;
    case 'zoom':
      return view.zoom > baseline.zoom + 1e-9;
    case 'highlight':
      return (
        facts?.pageId !== undefined &&
        facts.pageId !== null &&
        facts.quad !== undefined &&
        highlightCovers(facts.annotations, facts.pageId, facts.quad)
      );
    case 'comment':
      return (
        facts?.pageId !== undefined &&
        facts.pageId !== null &&
        facts.target !== undefined &&
        noteNear(facts.annotations, facts.pageId, facts.target)
      );
    case 'sign':
      return (
        facts?.pageId !== undefined &&
        facts.pageId !== null &&
        facts.target !== undefined &&
        signatureIn(facts.annotations, facts.pageId, facts.target)
      );
    case 'reorder':
      return (
        facts?.moves !== undefined && facts.above !== undefined && precedes(facts.pageOrder, facts.moves, facts.above)
      );
    default:
      return false;
  }
}

/** Steps whose condition has to hold for `NAVIGATE_SETTLE_MS` before it counts (scrolling settles first). */
export function settleDelay(stepId: string): number {
  return stepId === 'navigate' ? NAVIGATE_SETTLE_MS : stepId === 'sign' ? SIGN_SETTLE_MS : 0;
}
