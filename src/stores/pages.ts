import { useMemo } from 'react';
import { create } from 'zustand';

import type { PageSlotInfo } from '../api/pages';
import type { PageSize } from '../api/render';
import { setFileRotation } from '../features/viewer/fileRotation';
import { useDocuments } from './documents';
import { useView } from './view';

/**
 * The pages of each open document (ARCHITECTURE section 8, `pages`): the page list in its current order (`PageSlotInfo`, from
 * `get_pages` and from every `ChangeSet.pages`) and, derived from it, the size every page is drawn at in PDF points. The canvas
 * lays itself out from the drawn sizes, so every page has a placeholder of the right size before its first pixel is rendered, and a
 * move or a rotation lays it out again without a render. Each document's list is replaced as a whole and never edited.
 */
export interface PagesState {
  /** The size every page is drawn at (rotation applied), in the order of the page list. */
  byDoc: Readonly<Record<number, readonly PageSize[]>>;
  /** The page list; absent for a document whose sizes were stored without one (`set`). */
  slotsByDoc: Readonly<Record<number, readonly PageSlotInfo[]>>;
  /** Stores the sizes of a document (a double in tests); the pages are then taken to be the file's, in order. */
  set: (docId: number, sizes: readonly PageSize[]) => void;
  /** Stores the page list of a document that was just opened, or that a command, an undo or a save changed. */
  setSlots: (docId: number, slots: readonly PageSlotInfo[]) => void;
  /** Forgets a closed document. */
  remove: (docId: number) => void;
}

/** The size a page is drawn at: its size, turned by its rotation. */
export function drawnSize(slot: Pick<PageSlotInfo, 'width' | 'height' | 'rotation'>): PageSize {
  return slot.rotation === 90 || slot.rotation === 270 ? [slot.height, slot.width] : [slot.width, slot.height];
}

export const usePages = create<PagesState>()((set) => ({
  byDoc: {},
  slotsByDoc: {},
  set: (docId, sizes) =>
    set((state) => ({
      byDoc: { ...state.byDoc, [docId]: sizes },
      slotsByDoc: without(state.slotsByDoc, docId),
    })),
  setSlots: (docId, slots) => {
    set((state) => ({
      byDoc: { ...state.byDoc, [docId]: slots.map(drawnSize) },
      slotsByDoc: { ...state.slotsByDoc, [docId]: slots },
    }));
    // The overlays are in page space and are turned by the page's rotation (`viewer/fileRotation`): they follow it at once.
    slots.forEach((slot) => setFileRotation(docId, slot.id, slot.rotation));
    const view = useView.getState().byDoc[docId];
    if (view !== undefined && slots.length > 0 && view.pageCount !== slots.length) {
      useView.getState().setPageCount(docId, slots.length);
    }
    const info = useDocuments.getState().byId[docId];
    if (info !== undefined && slots.length > 0 && info.pageCount !== slots.length) {
      useDocuments.setState((state) => ({ byId: { ...state.byId, [docId]: { ...info, pageCount: slots.length } } }));
    }
  },
  remove: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined && state.slotsByDoc[docId] === undefined) return state;
      return { byDoc: without(state.byDoc, docId), slotsByDoc: without(state.slotsByDoc, docId) };
    }),
}));

function without<T>(record: Readonly<Record<number, T>>, docId: number): Readonly<Record<number, T>> {
  if (record[docId] === undefined) return record;
  return Object.fromEntries(Object.entries(record).filter(([id]) => Number(id) !== docId));
}

const NO_SLOTS: readonly PageSlotInfo[] = [];

function slotsFromSizes(sizes: readonly PageSize[] | undefined): readonly PageSlotInfo[] {
  if (sizes === undefined) return NO_SLOTS;
  return sizes.map(([width, height], id) => ({ id, width, height, rotation: 0, rev: 0, label: null, origin: 'file' }));
}

/** The pages of a document in their current order. */
export function readSlots(docId: number): readonly PageSlotInfo[] {
  const state = usePages.getState();
  return state.slotsByDoc[docId] ?? slotsFromSizes(state.byDoc[docId]);
}

/** `readSlots`, followed: a component renders again when the order or a page changes. */
export function useSlots(docId: number | null): readonly PageSlotInfo[] {
  const slots = usePages((state) => (docId === null ? undefined : state.slotsByDoc[docId]));
  const sizes = usePages((state) => (docId === null ? undefined : state.byDoc[docId]));
  return useMemo(() => slots ?? slotsFromSizes(sizes), [slots, sizes]);
}

/** What a page is taken to be until its size is known: US Letter, the backend's own fallback (`DEFAULT_PAGE_SIZE_PT`). */
export const DEFAULT_PAGE_SIZE: PageSize = [612, 792];

const placeholders = new Map<number, readonly PageSize[]>();

/**
 * `count` pages of the default size. The same list for the same count, so a layout built from it stays valid: the canvas of a
 * document whose sizes have not arrived yet does not lay itself out afresh on every render.
 */
export function placeholderSizes(count: number): readonly PageSize[] {
  const pages = Math.max(0, Math.trunc(count));
  let sizes = placeholders.get(pages);
  if (sizes === undefined) {
    sizes = Array.from({ length: pages }, () => DEFAULT_PAGE_SIZE);
    // A few document lengths at a time are enough; the list is dropped when it is not the one that is in use.
    if (placeholders.size >= 4) placeholders.clear();
    placeholders.set(pages, sizes);
  }
  return sizes;
}

/**
 * The sizes to lay a document out from: the ones the backend reported if they cover the document's pages, else placeholders.
 * A list of the wrong length (the document changed under it) is not trusted.
 */
export function sizesFor(
  state: Pick<PagesState, 'byDoc'>,
  docId: number | null,
  pageCount: number,
): readonly PageSize[] {
  const known = docId === null ? undefined : state.byDoc[docId];
  return known !== undefined && known.length === pageCount ? known : placeholderSizes(pageCount);
}

/** The position of every page id of a list: where a page that a file index, an outline target or a search hit names sits now. */
export function positionsOf(slots: readonly PageSlotInfo[]): ReadonlyMap<number, number> {
  return new Map(slots.map((slot, position) => [slot.id, position]));
}

/** Where the page with `pageId` sits in the document now; `null` if it was deleted (or is not a page of it). */
export function positionOf(docId: number, pageId: number): number | null {
  const slots = readSlots(docId);
  // Before the page list is known a page is its number.
  if (slots.length === 0) return pageId;
  const position = slots.findIndex((slot) => slot.id === pageId);
  return position < 0 ? null : position;
}

/** The id of the page at `position`; before the page list is known, the file's page of that number. `null` past the end. */
export function pageIdAt(docId: number, position: number): number | null {
  const slots = readSlots(docId);
  return slots.length === 0 ? position : (slots[position]?.id ?? null);
}

/** The 1-based number a page is shown with in lists: its place in the current order (its id if the page is gone). */
export function pageNumberOf(docId: number | null, pageId: number): number {
  return (docId === null ? pageId : (positionOf(docId, pageId) ?? pageId)) + 1;
}
