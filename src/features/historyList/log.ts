import { create } from 'zustand';

import { getHistory, type HistoryItem } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { onChangeSet, useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';

/**
 * The change list of the history panel (F19.23, ADR-143). The list is the backend's own undo history (`get_history`): every step of
 * the session is in it, whichever way it was made (annotations, page operations, text edits, redaction, recognition), and the
 * cursor says how many are applied. It is read again after every change set the annotations store delivers (a command, an undo, a
 * redo, a job's result). Jumping is a run of undo or redo steps in order, never a reorder, so text edits (which depend on each
 * other) stay consistent.
 */
export type EntryGroup = 'annotation' | 'text' | 'page' | 'other';

export interface HistoryEntry {
  /** The step's serial number in the backend; it changes when an edit is folded into the step. */
  id: number;
  /** The label key part: an annotation kind (`highlight`) or an operation (`delete`, `move`, ...). */
  what: string;
  group: EntryGroup;
  /** The page id the step concerns; null when it has none. */
  pageId: number | null;
  /** The annotation a create or edit step concerns; null for the others. */
  annotationId: number | null;
  /** The label of a batch or another step without a name of its own here, as the backend knows it. */
  batchLabel: string | null;
  /** When the list first showed the step. */
  time: number;
}

export interface DocLog {
  entries: readonly HistoryEntry[];
  /** How many entries are applied: entries from this index on are redo steps. */
  cursor: number;
}

interface LogState {
  byDoc: Readonly<Record<number, DocLog>>;
}

export const useHistoryLog = create<LogState>()(() => ({ byDoc: {} }));

const EMPTY: DocLog = { entries: [], cursor: 0 };

/** The log of a document, or the empty one. */
export function logOf(state: LogState, docId: number | null): DocLog {
  return (docId === null ? undefined : state.byDoc[docId]) ?? EMPTY;
}

const OPERATIONS: Readonly<Record<string, string>> = {
  'annotation.update': 'update',
  'annotation.delete': 'delete',
  'annotation.move': 'move',
  'field.set': 'field',
  'page.crop': 'crop',
  'redact.mark': 'redact',
};

/** What the panel shows of a backend step. */
function describe(item: HistoryItem): Omit<HistoryEntry, 'id' | 'time'> {
  const base = { pageId: item.page, annotationId: null, batchLabel: null, group: 'other' as EntryGroup };
  if (item.labelKey === 'annotation.create') {
    return {
      ...base,
      what: item.annotationKind ?? 'change',
      group: 'annotation',
      annotationId: item.annotationId,
    };
  }
  if (item.labelKey === 'annotation.update') {
    return { ...base, what: 'update', group: 'annotation', annotationId: item.annotationId };
  }
  if (item.isTextEdit) return { ...base, what: 'text', group: 'text' };
  const operation = OPERATIONS[item.labelKey];
  if (operation !== undefined) return { ...base, what: operation, group: item.kind === 'page' ? 'page' : 'other' };
  if (item.kind === 'page') return { ...base, what: 'page', group: 'page' };
  return { ...base, what: 'batch', batchLabel: item.labelKey };
}

/** When each step was first seen, by document and step id. */
const seen = new Map<number, Map<number, number>>();
/** Bumped when a document closes, so that an answer in flight does not bring its log back. */
const generation = new Map<number, number>();

async function load(docId: number): Promise<void> {
  const before = generation.get(docId) ?? 0;
  let list;
  try {
    list = await getHistory(docId);
  } catch {
    // The list keeps what it had; the next change reads it again.
    return;
  }
  if ((generation.get(docId) ?? 0) !== before) return;
  const times = seen.get(docId) ?? new Map<number, number>();
  const next = new Map<number, number>();
  const now = Date.now();
  const entries = list.entries.map((item): HistoryEntry => {
    const time = times.get(item.id) ?? now;
    next.set(item.id, time);
    return { ...describe(item), id: item.id, time };
  });
  seen.set(docId, next);
  useHistoryLog.setState((state) => ({ byDoc: { ...state.byDoc, [docId]: { entries, cursor: list.cursor } } }));
}

const active = new Map<number, Promise<void>>();
const queued = new Map<number, Promise<void>>();

/**
 * Reads the backend's history of a document into the log. Reads never overlap: one that comes while another runs waits for it and
 * is shared by all who ask meanwhile, so the last answer to be stored is the newest one.
 */
export function refreshHistory(docId: number): Promise<void> {
  const waiting = queued.get(docId);
  if (waiting !== undefined) return waiting;
  const start = (): Promise<void> => {
    queued.delete(docId);
    const run = load(docId).finally(() => {
      if (active.get(docId) === run) active.delete(docId);
    });
    active.set(docId, run);
    return run;
  };
  const running = active.get(docId);
  if (running === undefined) return start();
  const next = running.then(start, start);
  queued.set(docId, next);
  return next;
}

let installed = false;

/** Follows the annotations store's change sets; once. */
export function installHistoryLog(): void {
  if (installed) return;
  installed = true;
  onChangeSet((docId, changes) => {
    if (changes !== null) {
      void refreshHistory(docId);
      return;
    }
    generation.set(docId, (generation.get(docId) ?? 0) + 1);
    seen.delete(docId);
    useHistoryLog.setState((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    });
  });
}

let running = false;

/**
 * Takes the document to the state after `index` entries (0 = as opened) by undo and redo steps, one after the other. Stops at the
 * first step that fails (the banner says why). Returns whether the target was reached.
 */
export async function jumpTo(docId: number, index: number): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    const store = useAnnotations.getState();
    for (;;) {
      const log = logOf(useHistoryLog.getState(), docId);
      const target = Math.min(Math.max(index, 0), log.entries.length);
      if (log.cursor === target) return true;
      const before = log.cursor;
      await (log.cursor > target ? store.undo(docId) : store.redo(docId));
      await refreshHistory(docId);
      // A step that moved nothing would loop for ever.
      if (logOf(useHistoryLog.getState(), docId).cursor === before) return false;
    }
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return false;
  } finally {
    running = false;
  }
}

/** Deletes the annotation of an entry through the normal command (an undoable step of its own). */
export async function deleteFromHistory(docId: number, annotationId: number): Promise<void> {
  if (useAnnotations.getState().byDoc[docId]?.byId[annotationId] === undefined) return;
  try {
    await useAnnotations.getState().apply(docId, { type: 'deleteAnnotations', ids: [annotationId] });
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
  }
}
