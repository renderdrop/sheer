import { create } from 'zustand';

import type { ChangeSet, DocCommand } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { onChangeSet, onHistoryEvent, useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';

/**
 * The change list of the history panel (F19.23, ADR-143). The backend keeps the undo stack but tells only the label of its next
 * step, so this list is the session's own record of the steps that ran through the annotations store, per document: a command adds
 * an entry (and drops the ones after the cursor, as the backend drops its redo steps), an undo or redo moves the cursor. Jumping is
 * a run of undo or redo steps in order, never a reorder, so text edits (which depend on each other) stay consistent.
 */
export type EntryGroup = 'annotation' | 'text' | 'page' | 'other';

export interface HistoryEntry {
  id: number;
  /** The label key part: an annotation kind (`highlight`) or an operation (`delete`, `move`, ...). */
  what: string;
  group: EntryGroup;
  /** The page id the step concerns; null when it has none. */
  pageId: number | null;
  /** The annotation a create or edit step concerns; null for the others. */
  annotationId: number | null;
  /** The label of a batch, as the backend knows it. */
  batchLabel: string | null;
  /** The coalescing key of an edit, so that its follow-up edits do not add entries. */
  coalesce: string | null;
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

let nextId = 1;
const EMPTY: DocLog = { entries: [], cursor: 0 };

/** The log of a document, or the empty one. */
export function logOf(state: LogState, docId: number | null): DocLog {
  return (docId === null ? undefined : state.byDoc[docId]) ?? EMPTY;
}

function describe(docId: number, command: DocCommand, changes: ChangeSet): Omit<HistoryEntry, 'id' | 'time'> {
  const base = { pageId: null, annotationId: null, batchLabel: null, coalesce: null, group: 'other' as EntryGroup };
  const known = (id: number) => useAnnotations.getState().byDoc[docId]?.byId[id];
  switch (command.type) {
    case 'createAnnotation': {
      const made = changes.upserted[0]?.id ?? changes.content?.[0]?.id ?? null;
      return {
        ...base,
        what: command.draft.kind,
        group: 'annotation',
        pageId: command.draft.pageId,
        annotationId: made,
      };
    }
    case 'updateAnnotation':
      return {
        ...base,
        what: 'update',
        group: 'annotation',
        annotationId: command.id,
        pageId: known(command.id)?.pageId ?? null,
        coalesce: command.coalesce ?? null,
      };
    case 'deleteAnnotations':
      return { ...base, what: 'delete' };
    case 'moveAnnotations':
      return { ...base, what: 'move', pageId: known(command.ids[0] ?? -1)?.pageId ?? null };
    case 'batch':
      return { ...base, what: 'batch', batchLabel: command.label };
    case 'editTextLine':
      return { ...base, what: 'text', group: 'text', pageId: command.pageId };
    case 'setFieldValue':
      return { ...base, what: 'field' };
    case 'cropPages':
      return { ...base, what: 'crop', group: 'page' };
    case 'rotatePages':
    case 'deletePages':
    case 'movePages':
    case 'insertBlankPage':
    case 'insertPages':
      return { ...base, what: 'page', group: 'page' };
    case 'markRedactions':
      return { ...base, what: 'redact' };
    default:
      return { ...base, what: 'change' };
  }
}

function put(docId: number, log: DocLog): void {
  useHistoryLog.setState((state) => ({ byDoc: { ...state.byDoc, [docId]: log } }));
}

/** Brings the cursor in line with what the backend says can still be undone or redone (a step that bypassed the store). */
function settle(log: DocLog, changes: ChangeSet): DocLog {
  let cursor = log.cursor;
  if (!changes.history.canRedo) cursor = log.entries.length;
  if (!changes.history.canUndo) cursor = 0;
  return cursor === log.cursor ? log : { ...log, cursor };
}

let installed = false;

/** Follows the annotations store; once. */
export function installHistoryLog(): void {
  if (installed) return;
  installed = true;
  onHistoryEvent((docId, event) => {
    const log = logOf(useHistoryLog.getState(), docId);
    if (event.type === 'apply') {
      const info = describe(docId, event.command, event.changes);
      const kept = log.entries.slice(0, log.cursor);
      const last = kept[kept.length - 1];
      // The backend folds an edit with the same key into the step before it.
      if (info.coalesce !== null && last?.coalesce === info.coalesce && last.annotationId === info.annotationId) {
        put(docId, { entries: kept, cursor: kept.length });
        return;
      }
      const entries = [...kept, { ...info, id: nextId++, time: Date.now() }];
      put(docId, { entries, cursor: entries.length });
      return;
    }
    if (!event.moved) {
      put(docId, settle(log, event.changes));
      return;
    }
    const cursor = Math.min(log.entries.length, Math.max(0, log.cursor + (event.type === 'undo' ? -1 : 1)));
    put(docId, settle({ ...log, cursor }, event.changes));
  });
  onChangeSet((docId, changes) => {
    if (changes !== null) return;
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
