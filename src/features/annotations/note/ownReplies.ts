import { create } from 'zustand';

import type { Annotation } from '../../../api/annotations';

/**
 * The replies the user wrote in this session, by document: a reply stays editable by the person who wrote it even when the author
 * name in Settings changes afterwards. A reply from a file is the user's only when its author is the (non-empty) name now.
 */
interface OwnReplies {
  byDoc: Readonly<Record<number, ReadonlySet<number>>>;
}

export const useOwnReplies = create<OwnReplies>()(() => ({ byDoc: {} }));

export function markOwnReply(docId: number, id: number): void {
  useOwnReplies.setState((state) => ({
    byDoc: { ...state.byDoc, [docId]: new Set([...(state.byDoc[docId] ?? []), id]) },
  }));
}

export function isOwnReply(mine: ReadonlySet<number> | undefined, reply: Annotation, ownName: string): boolean {
  return mine?.has(reply.id) === true || (ownName !== '' && reply.author === ownName);
}
