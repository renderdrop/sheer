import { useEffect } from 'react';
import { create } from 'zustand';

import { MAX_ANNOT_QUADS, MAX_GROUP_MEMBERS, type AnnotationDraft } from '../../api/annotations';
import type { Quad } from '../../api/wire';
import { detectPlatform } from '../../lib/platform';
import { pageIdAt, positionOf } from '../../stores/pages';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { quadsForOffsets, type TextBoxes } from '../annotations/create/markup';
import { textPointer } from '../viewer/lesen';
import { peekLayer } from './cache';
import { LAYER_SELECTOR, layerOf, resolveBoundary, type TextPoint } from './selection';

/**
 * Several separate text ranges at once (F20.7): with the primary modifier held (Ctrl, Cmd on macOS) a new drag adds a range instead
 * of replacing the selection. The browser holds one range, the live one; the ranges before it are pinned here (as places in the
 * pages' text, so they survive scrolling and the layers being unmounted) and drawn by the page overlays like the live one. Highlight
 * and Comment act on all of them: one markup annotation per page with all that page's quads, and over several pages one group.
 * Esc or a plain click clears them.
 */

/** A range of text in reading order: `start` is before `end`. */
export interface TextSpan {
  start: TextPoint;
  end: TextPoint;
}

/** Most ranges pinned at once; a further one replaces the oldest. */
export const MAX_SPANS = 64;
/** Most pages one range reaches (as for a single selection's highlight). */
const MAX_PAGES_PER_SPAN = 50;

interface MultiSelectionState {
  /** The document the pinned ranges belong to. */
  docId: number | null;
  spans: readonly TextSpan[];
  add: (docId: number, span: TextSpan) => void;
  /** Takes the newest pinned range off and answers it. */
  pop: () => TextSpan | undefined;
  clear: () => void;
}

export const useMultiSelection = create<MultiSelectionState>()((set, get) => ({
  docId: null,
  spans: [],
  add: (docId, span) =>
    set((state) => {
      const kept = state.docId === docId ? state.spans.filter((other) => !sameSpan(other, span)) : [];
      return { docId, spans: [...kept, span].slice(-MAX_SPANS) };
    }),
  pop: () => {
    const { spans } = get();
    const last = spans[spans.length - 1];
    if (last !== undefined) set({ spans: spans.slice(0, -1) });
    return last;
  },
  clear: () => set((state) => (state.spans.length === 0 && state.docId === null ? state : { docId: null, spans: [] })),
}));

const samePoint = (a: TextPoint, b: TextPoint) => a.page === b.page && a.index === b.index;
const sameSpan = (a: TextSpan, b: TextSpan) => samePoint(a.start, b.start) && samePoint(a.end, b.end);

/** The two places in reading order (`position` gives a page's place in the document); `null` when a page is not in it or the range is empty. */
export function ordered(a: TextPoint, b: TextPoint, position: (page: number) => number | null): TextSpan | null {
  const pa = position(a.page);
  const pb = position(b.page);
  if (pa === null || pb === null) return null;
  const forward = pa < pb || (pa === pb && a.index <= b.index);
  const span = forward ? { start: a, end: b } : { start: b, end: a };
  return samePoint(span.start, span.end) ? null : span;
}

/** The browser's selection as a range of the text layers of `docId`; `null` when it has none there. */
export function liveSpan(docId: number, selection: Selection | null = window.getSelection()): TextSpan | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const a = resolveBoundary(range.startContainer, range.startOffset);
  const b = resolveBoundary(range.endContainer, range.endOffset);
  if (a === null || b === null) return null;
  return ordered(a, b, (page) => positionOf(docId, page));
}

/** The pinned ranges of `docId` (none for another document). */
export function pinnedSpans(docId: number): readonly TextSpan[] {
  const state = useMultiSelection.getState();
  return state.docId === docId ? state.spans : [];
}

/** Every selected range of `docId`: the pinned ones, then the live one. */
export function selectedSpans(docId: number): TextSpan[] {
  const pinned = pinnedSpans(docId);
  const live = liveSpan(docId);
  return live === null || pinned.some((span) => sameSpan(span, live)) ? [...pinned] : [...pinned, live];
}

/** The text of one page a set of ranges covers: offset pairs (end exclusive), sorted and merged. */
export interface PagePiece {
  page: number;
  ranges: readonly (readonly [number, number])[];
}

/** Sorted, with overlapping and touching ranges merged. */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** What the page order and the page texts look like, for `piecesOf` (the stores in the app, plain data in a test). */
export interface PageSource {
  position: (page: number) => number | null;
  pageAt: (position: number) => number | null;
  /** The length of a page's text, `undefined` when its layer is not known. */
  lengthOf: (page: number) => number | undefined;
}

/** The ranges cut into pages, in page order; a page whose text is not known is left out. */
export function piecesOf(spans: readonly TextSpan[], source: PageSource): PagePiece[] {
  const byPage = new Map<number, { position: number; ranges: [number, number][] }>();
  for (const { start, end } of spans) {
    const from = source.position(start.page);
    const to = source.position(end.page);
    if (from === null || to === null) continue;
    for (let position = from; position <= to && position <= from + MAX_PAGES_PER_SPAN; position += 1) {
      const page = source.pageAt(position);
      if (page === null) continue;
      const length = source.lengthOf(page);
      if (length === undefined) continue;
      const a = page === start.page ? start.index : 0;
      const b = page === end.page ? end.index : length;
      let entry = byPage.get(page);
      if (entry === undefined) {
        entry = { position, ranges: [] };
        byPage.set(page, entry);
      }
      entry.ranges.push([a, b]);
    }
  }
  return [...byPage.entries()]
    .sort((x, y) => x[1].position - y[1].position)
    .map(([page, entry]) => ({ page, ranges: mergeRanges(entry.ranges) }))
    .filter((piece) => piece.ranges.length > 0);
}

/** The quads of a page's pieces (at most `MAX_ANNOT_QUADS`). */
export function piecesQuads(layer: TextBoxes, ranges: readonly (readonly [number, number])[]): Quad[] {
  return ranges.flatMap(([from, to]) => quadsForOffsets(layer, from, to)).slice(0, MAX_ANNOT_QUADS);
}

/** The page source of a document from the stores. */
export function storeSource(docId: number): PageSource {
  return {
    position: (page) => positionOf(docId, page),
    pageAt: (position) => pageIdAt(docId, position),
    lengthOf: (page) => peekLayer(docId, page)?.text.length,
  };
}

/**
 * The markup drafts of everything selected in `docId` (pinned ranges and the live one): one per page with all that page's quads, in
 * page order, at most `MAX_GROUP_MEMBERS` pages. `make` builds the draft of a page from its quads (`null`: none).
 */
export function selectionMarkupDrafts(
  docId: number,
  make: (page: number, quads: readonly Quad[]) => AnnotationDraft | null,
): AnnotationDraft[] {
  const drafts: AnnotationDraft[] = [];
  for (const piece of piecesOf(selectedSpans(docId), storeSource(docId))) {
    const layer = peekLayer(docId, piece.page);
    if (layer === undefined) continue;
    const draft = make(piece.page, piecesQuads(layer, piece.ranges));
    if (draft !== null) drafts.push(draft);
    if (drafts.length >= MAX_GROUP_MEMBERS) break;
  }
  return drafts;
}

/** Whether the primary modifier is held: Cmd on macOS, Ctrl elsewhere. */
export function primaryHeld(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>): boolean {
  const platform = useSettings.getState().platform ?? detectPlatform();
  return platform === 'macos' ? event.metaKey : event.ctrlKey;
}

/** The DOM range for a place of a page's text, if the page's layer is mounted under `root`. */
function domPoint(root: ParentNode, point: TextPoint): { node: Node; offset: number } | null {
  const layer = root.querySelector(`${LAYER_SELECTOR}[data-text-page="${point.page}"]`);
  if (!(layer instanceof HTMLElement)) return null;
  for (const span of layer.querySelectorAll<HTMLElement>('[data-run-start]')) {
    const start = Number(span.dataset.runStart);
    const end = Number(span.dataset.runEnd);
    if (point.index < start || point.index > end) continue;
    const text = span.firstChild;
    if (text === null) return { node: span, offset: 0 };
    return { node: text, offset: Math.min(point.index - start, text.textContent?.length ?? 0) };
  }
  return null;
}

/** Selects `span` in the browser (both its pages must be mounted under `root`); whether it could. */
export function selectSpan(
  root: ParentNode,
  span: TextSpan,
  selection: Selection | null = window.getSelection(),
): boolean {
  const a = domPoint(root, span.start);
  const b = domPoint(root, span.end);
  if (selection === null || a === null || b === null) return false;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * The pointer side of the multi-selection, for as long as the canvas is mounted: a press with the primary modifier in a text layer
 * pins the live range (the drag that follows makes the next one); a plain press anywhere else than on the selection bar clears the
 * pinned ones. A modified click that selects nothing brings the newest pinned range back as the live one, so the bar has a place.
 */
export function useMultiSelectGesture(region: { current: HTMLElement | null }, docId: number | null): void {
  useEffect(() => {
    if (docId === null) return;
    let adding = false;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target instanceof Element && target.closest('[data-selection-bar]') !== null) return;
      if (!primaryHeld(event)) {
        adding = false;
        if (useMultiSelection.getState().spans.length > 0) useMultiSelection.getState().clear();
        return;
      }
      adding = false;
      if (!textPointer(useUi.getState().activeTool) || layerOf(target) === null) return;
      const live = liveSpan(docId);
      if (live !== null) useMultiSelection.getState().add(docId, live);
      adding = pinnedSpans(docId).length > 0;
    };
    const onUp = () => {
      if (!adding) return;
      adding = false;
      // After the browser has placed (or collapsed) the selection.
      window.setTimeout(() => {
        if (liveSpan(docId) !== null) return;
        const root = region.current;
        const last = useMultiSelection.getState().pop();
        if (root !== null && last !== undefined && !selectSpan(root, last))
          useMultiSelection.getState().add(docId, last);
      }, 0);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
    };
  }, [region, docId]);
  // Another document: its ranges are not this one's.
  useEffect(() => () => useMultiSelection.getState().clear(), [docId]);
}
