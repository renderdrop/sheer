import { create } from 'zustand';

import type { FitMode } from '../../stores/view';

/** DESIGN 3.11 L7: how many views go back. */
export const HISTORY_DEPTH = 50;

/** A saved view: the page by id and the point of it at the viewport's top-left (page points), so a re-layout restores it exactly. */
export interface HistoryEntry {
  pageId: number;
  xPt: number;
  yPt: number;
  zoom: number;
  fit: FitMode;
  /** Where the jump came from: the run that gets the 2 px outline when the user comes back. View-space page points. */
  origin?: { pageId: number; rect: Rect };
  /** The element that had the keyboard focus when a keyboard jump left (not stored in any file; session only). */
  focus?: HTMLElement | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DocHistory {
  back: readonly HistoryEntry[];
  forward: readonly HistoryEntry[];
}

export const EMPTY_HISTORY: DocHistory = { back: [], forward: [] };

/** A new view within one viewport of the top entry (same page) replaces it instead of stacking. */
export function isNear(a: HistoryEntry, b: HistoryEntry, viewportPx: number): boolean {
  return a.pageId === b.pageId && Math.abs(a.yPt - b.yPt) * b.zoom < Math.max(1, viewportPx);
}

export interface HistoryState {
  byDoc: Readonly<Record<number, DocHistory>>;
  /** Saves the view the user leaves; clears forward. */
  push: (docId: number, entry: HistoryEntry, viewportPx: number) => void;
  /** Back: puts `current` on the forward stack and returns the entry to restore (`null` when there is none). */
  stepBack: (docId: number, current: HistoryEntry) => HistoryEntry | null;
  stepForward: (docId: number, current: HistoryEntry) => HistoryEntry | null;
  /** Drops entries whose page is no longer in the document. */
  prune: (docId: number, validPageIds: ReadonlySet<number>) => void;
  /** Forgets a closed document. */
  drop: (docId: number) => void;
}

const keep = (entries: readonly HistoryEntry[], valid: ReadonlySet<number>) =>
  entries.filter((entry) => valid.has(entry.pageId));

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  byDoc: {},
  push: (docId, entry, viewportPx) =>
    set((state) => {
      const current = state.byDoc[docId] ?? EMPTY_HISTORY;
      const top = current.back[current.back.length - 1];
      const base = top !== undefined && isNear(top, entry, viewportPx) ? current.back.slice(0, -1) : current.back;
      const back = [...base, entry].slice(-HISTORY_DEPTH);
      return { byDoc: { ...state.byDoc, [docId]: { back, forward: [] } } };
    }),
  stepBack: (docId, current) => {
    const history = get().byDoc[docId] ?? EMPTY_HISTORY;
    const target = history.back[history.back.length - 1];
    if (target === undefined) return null;
    set((state) => ({
      byDoc: {
        ...state.byDoc,
        [docId]: { back: history.back.slice(0, -1), forward: [...history.forward, current].slice(-HISTORY_DEPTH) },
      },
    }));
    return target;
  },
  stepForward: (docId, current) => {
    const history = get().byDoc[docId] ?? EMPTY_HISTORY;
    const target = history.forward[history.forward.length - 1];
    if (target === undefined) return null;
    set((state) => ({
      byDoc: {
        ...state.byDoc,
        [docId]: { back: [...history.back, current].slice(-HISTORY_DEPTH), forward: history.forward.slice(0, -1) },
      },
    }));
    return target;
  },
  prune: (docId, valid) =>
    set((state) => {
      const history = state.byDoc[docId];
      if (history === undefined) return state;
      const back = keep(history.back, valid);
      const forward = keep(history.forward, valid);
      if (back.length === history.back.length && forward.length === history.forward.length) return state;
      return { byDoc: { ...state.byDoc, [docId]: { back, forward } } };
    }),
  drop: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
}));
