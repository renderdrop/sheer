import { create } from 'zustand';

import { getOutline } from '../../api/outline';
import { toAppError, type AppError } from '../../api/errors';
import { useDocuments } from '../../stores/documents';
import { usePages, positionsOf, readSlots } from '../../stores/pages';
import type { OutlineNode } from '../../api/outline';
import { currentNode, expandSiblings, initialExpansion, buildIndex, retarget, type OutlineIndex } from './tree';
import { readingPosition } from './reading';

/** What the outline of one document is: being fetched, there, or failed. */
export type OutlineEntry =
  | { status: 'loading'; token: number }
  | { status: 'error'; error: AppError; token: number }
  | {
      status: 'ready';
      token: number;
      /** The outline as the file has it: targets are page ids. */
      nodes: readonly OutlineNode[];
      /** `nodes` with targets as the positions the pages sit at now; rebuilt when the pages move (ADR-036). */
      index: OutlineIndex;
      /** Expanded parents, per document and in memory: kept across tab switches. */
      expanded: ReadonlySet<number>;
      /** The last activated node (`aria-selected`), `-1` for none. */
      selected: number;
    };

export interface OutlineState {
  byDoc: Readonly<Record<number, OutlineEntry>>;
  /** Fetches the outline of a document once; a document that is loading, loaded or failed is left alone (`retry` asks again). */
  load: (docId: number) => void;
  retry: (docId: number) => void;
  setExpanded: (docId: number, expanded: ReadonlySet<number>) => void;
  toggle: (docId: number, node: number) => void;
  expandSiblingsOf: (docId: number, node: number) => void;
  collapseAll: (docId: number) => void;
  select: (docId: number, node: number) => void;
  drop: (docId: number) => void;
}

let nextToken = 1;

export const useOutline = create<OutlineState>()((set, get) => {
  const patchReady = (docId: number, change: (entry: Extract<OutlineEntry, { status: 'ready' }>) => OutlineEntry) =>
    set((state) => {
      const entry = state.byDoc[docId];
      return entry?.status === 'ready' ? { byDoc: { ...state.byDoc, [docId]: change(entry) } } : state;
    });

  const fetch = (docId: number) => {
    const token = nextToken++;
    set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'loading', token } } }));
    getOutline(docId).then(
      (nodes) => {
        // Dropped (closed) or asked again while the answer was on its way.
        if (get().byDoc[docId]?.token !== token) return;
        const index = buildIndex(retarget(nodes, positionsOf(readSlots(docId))));
        const expanded = initialExpansion(index, currentNode(index, readingPosition(docId)));
        set((state) => ({
          byDoc: { ...state.byDoc, [docId]: { status: 'ready', token, nodes, index, expanded, selected: -1 } },
        }));
      },
      (caught: unknown) => {
        if (get().byDoc[docId]?.token !== token) return;
        set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'error', error: toAppError(caught), token } } }));
      },
    );
  };

  return {
    byDoc: {},
    load: (docId) => {
      if (get().byDoc[docId] === undefined) fetch(docId);
    },
    retry: (docId) => {
      if (get().byDoc[docId]?.status === 'error') fetch(docId);
    },
    setExpanded: (docId, expanded) => patchReady(docId, (entry) => ({ ...entry, expanded })),
    toggle: (docId, node) =>
      patchReady(docId, (entry) => {
        const expanded = new Set(entry.expanded);
        if (!expanded.delete(node)) expanded.add(node);
        return { ...entry, expanded };
      }),
    expandSiblingsOf: (docId, node) =>
      patchReady(docId, (entry) => ({ ...entry, expanded: expandSiblings(entry.index, entry.expanded, node) })),
    collapseAll: (docId) => patchReady(docId, (entry) => ({ ...entry, expanded: new Set() })),
    select: (docId, node) => patchReady(docId, (entry) => ({ ...entry, selected: node })),
    drop: (docId) =>
      set((state) => {
        if (state.byDoc[docId] === undefined) return state;
        return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([key]) => Number(key) !== docId)) };
      }),
  };
});

// The outline goes with its document: closing it drops what was fetched (and a fetch still on its way is ignored when it arrives).
useDocuments.subscribe((state) => {
  for (const key of Object.keys(useOutline.getState().byDoc)) {
    if (state.byId[Number(key)] === undefined) useOutline.getState().drop(Number(key));
  }
});

// A move or a delete changes where the targets are: the index is made again from the file's outline (the tree keeps its shape, so
// the expansion and the selection stay).
usePages.subscribe((state, previous) => {
  for (const [key, slots] of Object.entries(state.slotsByDoc)) {
    if (previous.slotsByDoc[Number(key)] === slots) continue;
    const docId = Number(key);
    const entry = useOutline.getState().byDoc[docId];
    if (entry?.status !== 'ready') continue;
    const index = buildIndex(retarget(entry.nodes, positionsOf(slots)));
    useOutline.setState((current) => ({ byDoc: { ...current.byDoc, [docId]: { ...entry, index } } }));
  }
});
