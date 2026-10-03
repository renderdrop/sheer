import type { Annotation, AnnotationDraft } from '../../../api/annotations';
import { toAppError } from '../../../api/errors';
import type { Point } from '../../../api/wire';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { lastSignatureColour } from '../create/store';
import { ensureAsset } from './assets';
import { centredBox, dateText, itemSize, markDraft, signatureDraft, textDraft } from './drafts';
import type { PlaceItem } from './store';

/**
 * Places the armed item on a page, centred on `at` and kept inside the page: one `createAnnotation` command, so one undo step
 * (DESIGN 3.34). A signature first copies its art into the document's assets (once per source; that is not part of the history).
 * Resolves with the created annotation, `null` when nothing was made (the backend refused: the replica is unchanged).
 */
export async function placeItem(
  docId: number,
  pageId: number,
  item: PlaceItem,
  at: Point,
  page: readonly [number, number],
  now: Date = new Date(),
): Promise<Annotation | null> {
  try {
    const text = item.type === 'date' ? dateText(now) : '';
    const box = centredBox(at, itemSize(item, page, text), page);
    let draft: AnnotationDraft;
    switch (item.type) {
      case 'signature': {
        const asset = await ensureAsset(docId, item.ref);
        draft = signatureDraft(pageId, box, item.role, asset, lastSignatureColour());
        break;
      }
      case 'mark':
        draft = markDraft(pageId, box, item.glyph);
        break;
      case 'date':
        draft = textDraft(pageId, box, [text]);
        break;
      case 'text':
        draft = textDraft(pageId, box, []);
        break;
    }
    const changes = await useAnnotations.getState().apply(docId, { type: 'createAnnotation', draft });
    const created = changes.upserted.find((a) => a.kind === draft.kind) ?? changes.upserted[0] ?? null;
    if (created !== null) useAnnotations.getState().select(docId, [created.id]);
    return created;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return null;
  }
}
