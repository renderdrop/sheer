import type { ChangeSet } from '../api/annotations';

/**
 * MOTION spell 7: which change sets came from an undo or a redo, so that the annotation layer can fade the items they remove out and
 * the items they bring back in. The change set itself does not say (a delete and an undo of a create both remove ids). Listeners
 * are called before the change set is applied to the replica, so the layer still has the items it is about to lose.
 */
export type UndoCueKind = 'undo' | 'redo';
export type UndoCueListener = (docId: number, kind: UndoCueKind, changes: ChangeSet) => void;

const listeners = new Set<UndoCueListener>();

export function onUndoCue(listener: UndoCueListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitUndoCue(docId: number, kind: UndoCueKind, changes: ChangeSet): void {
  for (const listener of listeners) listener(docId, kind, changes);
}
