import { type Annotation, type DocCommand, type ReviewState } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { useAnnotations } from '../../stores/annotations';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { markOwnReply } from '../annotations/note/ownReplies';
import { jumpToAnnotation } from '../viewer/jump';

/** The step label of a create; a new comment cancelled right away takes it back with Undo instead of adding a delete. */
export const LABEL_CREATE = 'annotation.create';

/** Reports a failed command in the banner (errors never toast) and answers whether it worked. */
export async function run(docId: number, command: DocCommand): Promise<boolean> {
  try {
    await useAnnotations.getState().apply(docId, command);
    return true;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return false;
  }
}

/** The author written into new comments, from Settings (`null` when none is set). */
export function currentAuthor(): string | null {
  const name = useSettings.getState().authorName;
  return name === '' ? null : name;
}

/** The full annotation (the list only has an excerpt); the page is read first when the replica does not have it yet. */
async function fullAnnotation(docId: number, id: number, pageId: number): Promise<Annotation | undefined> {
  const store = useAnnotations.getState();
  await store.loadPage(docId, pageId).catch(() => undefined);
  return useAnnotations.getState().byDoc[docId]?.byId[id];
}

/** The draft of a reply to `root`: a note at the comment's corner, the colour of the comment. */
function replyDraft(root: Annotation, extra: { contents?: string; state?: ReviewState }) {
  return {
    kind: 'note' as const,
    pageId: root.pageId,
    at: { x: root.rect.x, y: root.rect.y },
    icon: 'note' as const,
    color: root.color,
    author: currentAuthor(),
    inReplyTo: root.id,
    ...extra,
  };
}

/** Resolve, Accept, Reject and Reopen: a review-state reply in the file, one undo step. */
export async function setReviewState(
  docId: number,
  rootId: number,
  pageId: number,
  state: ReviewState,
): Promise<boolean> {
  const root = await fullAnnotation(docId, rootId, pageId);
  if (root === undefined) return false;
  return run(docId, { type: 'createAnnotation', draft: replyDraft(root, { state }) });
}

/** A reply of the user to a comment. The reply is the user's own, whatever the author name becomes later. */
export async function postReply(docId: number, rootId: number, pageId: number, text: string): Promise<boolean> {
  const body = text.trim();
  if (body === '') return false;
  const root = await fullAnnotation(docId, rootId, pageId);
  if (root === undefined) return false;
  try {
    const changes = await useAnnotations
      .getState()
      .apply(docId, { type: 'createAnnotation', draft: replyDraft(root, { contents: body }) });
    for (const created of changes.upserted) {
      if (created.inReplyTo === rootId && created.contents === body) markOwnReply(docId, created.id);
    }
    return true;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return false;
  }
}

/** Deletes a comment with all its replies and states, as one undo step. */
export function deleteThread(docId: number, ids: readonly number[]): Promise<boolean> {
  return run(docId, { type: 'deleteAnnotations', ids });
}

/** Takes back a comment that was just made and is cancelled: Undo of its creation when that is the last step, else a delete. */
export async function discardNew(docId: number, id: number): Promise<void> {
  const state = useAnnotations.getState();
  const doc = state.byDoc[docId];
  if (doc?.byId[id] === undefined) return;
  if (doc.history.canUndo && doc.history.undoLabel === LABEL_CREATE) {
    try {
      await state.undo(docId);
    } catch (caught) {
      useUi.getState().showBanner(toAppError(caught));
    }
  } else {
    await run(docId, { type: 'deleteAnnotations', ids: [id] });
  }
}

/** Jumps to an annotation: its page comes into view, it is selected on the canvas and its spot flashes. Focus stays where it is. */
export function jumpTo(docId: number, pageId: number, id: number): void {
  jumpToAnnotation(docId, id, pageId);
}
