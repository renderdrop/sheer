import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import type { Annotation } from '../../api/annotations';
import { createCitations, listCitations, type CitationDraft, type CitationInfo } from '../../api/citations';
import { toAppError } from '../../api/errors';
import { announce } from '../../components';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { pageIdAt, positionOf } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { styleFor } from '../inspector/style';
import { quadsForOffsets } from '../annotations/create/markup';
import { peekLayer } from '../textlayer/cache';
import { resolveBoundary } from '../textlayer/selection';

/** The most pages one selection cites, and the most rectangles of one draft (`limits.rs`: 64 drafts, 512 quads). */
const MAX_PAGES = 50;
const QUADS_MAX = 512;
/** A change of the annotations reads the list again this long after the last one. */
export const CITATIONS_REFRESH_MS = 200;

/** Whether an annotation is a citation: a highlight that carries a quote (ADR-119). */
export function isCitation(annotation: Pick<Annotation, 'kind' | 'cite'>): boolean {
  return annotation.kind === 'highlight' && annotation.cite !== undefined;
}

/** The tour's sample (and any document that cannot change) is read-only: nothing is cited or tagged there (AC 22). */
export function isReadOnlyDocument(docId: number): boolean {
  return useDocuments.getState().byId[docId]?.kind === 'welcome';
}

interface CitationsState {
  byDoc: Readonly<Record<number, readonly CitationInfo[]>>;
  /** Reads the list of a document; a failed read keeps what is shown (the list is a view, never the source). */
  load: (docId: number) => Promise<void>;
  drop: (docId: number) => void;
}

const EMPTY: readonly CitationInfo[] = [];

export const useCitationStore = create<CitationsState>()((set) => ({
  byDoc: {},
  load: async (docId) => {
    try {
      const list = await listCitations(docId);
      set((state) => ({ byDoc: { ...state.byDoc, [docId]: list } }));
    } catch {
      // Keep the list that is there.
    }
  },
  drop: (docId) =>
    set((state) => {
      const rest = { ...state.byDoc };
      delete rest[docId];
      return { byDoc: rest };
    }),
}));

/**
 * The citations of a document, in page order. Read on first use and again after every change of the annotations (a command, an undo,
 * a redo), a moment after the last one.
 */
export function useCitations(docId: number | null): readonly CitationInfo[] {
  const rev = useAnnotations((state) => (docId === null ? 0 : (state.byDoc[docId]?.rev ?? 0)));
  const list = useCitationStore((state) => (docId === null ? undefined : state.byDoc[docId]));
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (docId === null) return;
    const first = seen.current !== docId;
    seen.current = docId;
    if (first && useCitationStore.getState().byDoc[docId] === undefined) {
      void useCitationStore.getState().load(docId);
      return;
    }
    const timer = window.setTimeout(() => void useCitationStore.getState().load(docId), CITATIONS_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [docId, rev]);
  return list ?? EMPTY;
}

/** The citations read for a document so far (outside React: the menu's enabled state). */
export function citationCount(docId: number | null): number {
  return docId === null ? 0 : (useCitationStore.getState().byDoc[docId]?.length ?? 0);
}

type FocusListener = (annotId: number) => void;
const focusListeners = new Set<FocusListener>();

/** Asks the margin to focus the bubble of a citation ("Open citation" in the mini bar). Nothing happens without a listener. */
export function requestCitationFocus(annotId: number): void {
  for (const listener of [...focusListeners]) listener(annotId);
}

/** Registers the margin's answer to `requestCitationFocus`; returns the function that removes it. */
export function onCitationFocus(listener: FocusListener): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

/**
 * The drafts of the text that is selected in the text layers, one per page (the quads are the selection's rectangles in page space),
 * in the colour the next citation gets. Empty when nothing usable is selected.
 */
export function selectionCitationDrafts(docId: number): CitationDraft[] {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  const a = resolveBoundary(range.startContainer, range.startOffset);
  const b = resolveBoundary(range.endContainer, range.endOffset);
  if (a === null || b === null) return [];
  const aPosition = positionOf(docId, a.page);
  const bPosition = positionOf(docId, b.page);
  if (aPosition === null || bPosition === null) return [];
  const forward = aPosition < bPosition || (aPosition === bPosition && a.index <= b.index);
  const [start, end] = forward ? [a, b] : [b, a];
  const [startPosition, endPosition] = forward ? [aPosition, bPosition] : [bPosition, aPosition];
  const color = styleFor('citation').color;
  const drafts: CitationDraft[] = [];
  for (let position = startPosition; position <= endPosition && position <= startPosition + MAX_PAGES; position += 1) {
    const pageId = pageIdAt(docId, position);
    if (pageId === null) continue;
    const layer = peekLayer(docId, pageId);
    if (layer === undefined) continue;
    const from = pageId === start.page ? start.index : 0;
    const to = pageId === end.page ? end.index : layer.text.length;
    const quads = quadsForOffsets(layer, from, to).slice(0, QUADS_MAX);
    if (quads.length > 0) drafts.push({ pageId, quads, color });
  }
  return drafts;
}

/**
 * Makes the citations of `drafts` as one undo step, selects the first one and says so (DESIGN 3.7 C2: no toast, a polite
 * announcement; a draft without text is the toast `citation.noText`). Resolves with the first new annotation's id, `null` when
 * nothing was made.
 */
export async function createCitationDrafts(docId: number, drafts: readonly CitationDraft[]): Promise<number | null> {
  const first = drafts[0];
  if (first === undefined || isReadOnlyDocument(docId)) return null;
  const t = translators[useLocaleStore.getState().locale];
  try {
    const changes = await createCitations(docId, drafts);
    useAnnotations.getState().applyChanges(docId, changes);
    const created = changes.upserted.find((annotation) => annotation.pageId === first.pageId) ?? changes.upserted[0];
    if (created === undefined) return null;
    window.getSelection()?.removeAllRanges();
    useAnnotations.getState().select(docId, [created.id]);
    const position = positionOf(docId, created.pageId);
    announce(t('citation.added', { page: position === null ? '' : String(position + 1) }));
    return created.id;
  } catch (caught) {
    const error = toAppError(caught);
    if (error.code === 'invalid_argument' && error.params?.what === 'citation') {
      useUi.getState().showToast({ message: t('citation.noText') });
    } else if (error.code === 'read_only') {
      useUi.getState().showToast({ message: t('annot.refused.readOnly') });
    } else {
      useUi.getState().showBanner(error);
    }
    return null;
  }
}

/**
 * Cites the text that is selected: one draft per page, one undo step. A no-op without a text selection or on a read-only document.
 * Resolves with the first new annotation's id, `null` when nothing was made.
 */
export function createCitationFromSelection(docId: number): Promise<number | null> {
  return createCitationDrafts(docId, selectionCitationDrafts(docId));
}
