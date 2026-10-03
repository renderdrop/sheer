import { create } from 'zustand';

import type { ChangeSet, ContentAnnotation } from '../../api/annotations';
import { onChangeSet } from '../../stores/annotations';
import { positionOf } from '../../stores/pages';

/**
 * The redaction marks of each open document (DESIGN 3.38, ADR-047 section 3). Rust owns them (they are model objects, never in the
 * file); this store follows them through the content part of every change set (a command, an undo, a redo, the result of the apply
 * job), so Undo and Redo of any step keep it right. Marks are never loaded: a session starts without any.
 */
export type RedactMark = Extract<ContentAnnotation, { kind: 'redactMark' }>;

export interface RedactState {
  /** The marks of each document, by id. */
  marks: Readonly<Record<number, Readonly<Record<number, RedactMark>>>>;
  /** The selected mark of each document. */
  selected: Readonly<Record<number, number | null>>;
  /** The apply dialog is open. */
  applyOpen: boolean;
  /** The "Also remove document metadata" checkbox (on by default, DESIGN 3.38). */
  removeMetadata: boolean;

  select: (docId: number, id: number | null) => void;
  setApplyOpen: (open: boolean) => void;
  setRemoveMetadata: (on: boolean) => void;
  /** Follows a change set; `null` forgets a closed document. */
  follow: (docId: number, changes: ChangeSet | null) => void;
}

const NONE: Readonly<Record<number, RedactMark>> = {};

export const useRedact = create<RedactState>()((set) => ({
  marks: {},
  selected: {},
  applyOpen: false,
  removeMetadata: true,

  select: (docId, id) =>
    set((state) => (state.selected[docId] === id ? state : { selected: { ...state.selected, [docId]: id } })),
  setApplyOpen: (applyOpen) => set({ applyOpen }),
  setRemoveMetadata: (removeMetadata) => set({ removeMetadata }),

  follow: (docId, changes) =>
    set((state) => {
      if (changes === null) {
        const marks = Object.fromEntries(Object.entries(state.marks).filter(([id]) => Number(id) !== docId));
        const selected = Object.fromEntries(Object.entries(state.selected).filter(([id]) => Number(id) !== docId));
        return state.marks[docId] === undefined && state.selected[docId] === undefined
          ? state
          : { marks, selected, applyOpen: false };
      }
      const upserted = (changes.content ?? []).filter((item): item is RedactMark => item.kind === 'redactMark');
      const before = state.marks[docId] ?? NONE;
      const gone = changes.removed.filter((id) => before[id] !== undefined);
      if (upserted.length === 0 && gone.length === 0) return state;
      const next: Record<number, RedactMark> = { ...before };
      for (const id of gone) {
        delete next[id];
      }
      for (const mark of upserted) next[mark.id] = mark;
      const current = state.selected[docId];
      const keep = current === null || current === undefined || next[current] !== undefined;
      return {
        marks: { ...state.marks, [docId]: next },
        ...(keep ? {} : { selected: { ...state.selected, [docId]: null } }),
      };
    }),
}));

onChangeSet((docId, changes) => useRedact.getState().follow(docId, changes));

const EMPTY: readonly RedactMark[] = [];
const sorted = new WeakMap<object, readonly RedactMark[]>();

/** The marks of a document in the order of its pages, then by id. The same array while the marks are unchanged. */
export function marksOf(state: Pick<RedactState, 'marks'>, docId: number | null): readonly RedactMark[] {
  const byId = docId === null ? undefined : state.marks[docId];
  if (byId === undefined) return EMPTY;
  const cached = sorted.get(byId);
  if (cached !== undefined) return cached;
  const list = Object.values(byId);
  if (list.length === 0) return EMPTY;
  const position = new Map<number, number>();
  for (const mark of list)
    if (!position.has(mark.pageId))
      position.set(mark.pageId, docId === null ? 0 : (positionOf(docId, mark.pageId) ?? mark.pageId));
  list.sort((a, b) => (position.get(a.pageId) ?? 0) - (position.get(b.pageId) ?? 0) || a.id - b.id);
  sorted.set(byId, list);
  return list;
}

/** The distinct pages that hold marks, in page order. */
export function markedPages(marks: readonly RedactMark[]): number[] {
  const pages: number[] = [];
  for (const mark of marks) if (!pages.includes(mark.pageId)) pages.push(mark.pageId);
  return pages;
}
