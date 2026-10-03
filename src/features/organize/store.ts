import { create } from 'zustand';

import { clampThumb } from './grid';

/** Versioned: the first release defaulted to 96, and a value saved then is not a choice (default 160, DESIGN 3.28). */
const STORAGE_KEY = 'sheer.organizeThumb2';

function loadThumb(): number {
  try {
    return clampThumb(Number(globalThis.localStorage.getItem(STORAGE_KEY)));
  } catch {
    return clampThumb(Number.NaN);
  }
}

/** What a document's organize grid remembers while the mode is on: the selection (page ids) and its anchor. */
export interface OrganizeSelection {
  selected: readonly number[];
  /** The page a Shift range starts from. */
  anchor: number | null;
  /** The page that has the focus (the tab stop); it is where inserts go and where the viewer returns to. */
  focus: number | null;
}

const EMPTY: OrganizeSelection = { selected: [], anchor: null, focus: null };

export interface OrganizeState {
  /** The thumbnail size in px (`--grid-thumb`), persisted in this webview's storage. */
  thumb: number;
  byDoc: Readonly<Record<number, OrganizeSelection>>;
  /** Pages that pulse once (inserted ones, §4.7); a new `nonce` is a new pulse. */
  pulse: { nonce: number; ids: readonly number[] };
  setThumb: (thumb: number) => void;
  setSelection: (docId: number, change: Partial<OrganizeSelection>) => void;
  /** Forgets a document's selection (it is closed, or the mode ended). */
  clear: (docId: number) => void;
  setPulse: (ids: readonly number[]) => void;
}

export const useOrganize = create<OrganizeState>()((set) => ({
  thumb: loadThumb(),
  byDoc: {},
  pulse: { nonce: 0, ids: [] },
  setThumb: (value) => {
    const thumb = clampThumb(value);
    set({ thumb });
    try {
      globalThis.localStorage.setItem(STORAGE_KEY, String(thumb));
    } catch {
      // Storage unavailable: the size lasts for the session.
    }
  },
  setSelection: (docId, change) =>
    set((state) => ({ byDoc: { ...state.byDoc, [docId]: { ...(state.byDoc[docId] ?? EMPTY), ...change } } })),
  clear: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
  setPulse: (ids) => set((state) => ({ pulse: { nonce: state.pulse.nonce + 1, ids } })),
}));

export function selectionOf(state: Pick<OrganizeState, 'byDoc'>, docId: number | null): OrganizeSelection {
  return (docId === null ? undefined : state.byDoc[docId]) ?? EMPTY;
}
