import { useMemo } from 'react';

import { selectActiveId, useDocuments } from '../../stores/documents';
import { useAnnotations } from '../../stores/annotations';
import { selectionIds, useInsert } from '../insert/store';
import { useRedact } from '../redact/store';
import { barKindOf, type MiniObject } from './model';

const NONE: readonly number[] = [];

/**
 * The canvas objects selected in the active document (annotations, marks, signatures, text boxes, images, redaction marks), read only.
 * Text selections, form fields and page cards are none of these. An annotation the app does not edit (`opaque`) is left out: the bar
 * has nothing to offer for it.
 */
export function useMiniSelection(): { docId: number | null; objects: readonly MiniObject[] } {
  const docId = useDocuments(selectActiveId);
  const annotationIds = useAnnotations((s) => (docId === null ? undefined : s.selectedIds[docId])) ?? NONE;
  const annotations = useAnnotations((s) => (docId === null ? undefined : s.byDoc[docId]?.byId));
  const insertPrimary = useInsert((s) => (docId === null ? null : (s.selected[docId] ?? null)));
  const insertExtra = useInsert((s) => (docId === null ? undefined : s.extra[docId])) ?? NONE;
  const content = useInsert((s) => (docId === null ? undefined : s.byDoc[docId]?.byId));
  const redactId = useRedact((s) => (docId === null ? null : (s.selected[docId] ?? null)));
  const marks = useRedact((s) => (docId === null ? undefined : s.marks[docId]));

  const objects = useMemo<readonly MiniObject[]>(() => {
    const found: MiniObject[] = [];
    for (const id of annotationIds) {
      const annotation = annotations?.[id];
      if (annotation !== undefined) found.push(annotation);
    }
    const insertIds = selectionIds(
      {
        selected: docId === null ? {} : { [docId]: insertPrimary },
        extra: docId === null ? {} : { [docId]: insertExtra },
      },
      docId ?? -1,
    );
    for (const id of insertIds) {
      const object = content?.[id];
      if (object !== undefined) found.push(object);
    }
    const mark = redactId === null ? undefined : marks?.[redactId];
    if (mark !== undefined) found.push(mark);
    return found.filter((object) => barKindOf(object) !== null);
  }, [docId, annotationIds, annotations, insertPrimary, insertExtra, content, redactId, marks]);

  return { docId, objects };
}
