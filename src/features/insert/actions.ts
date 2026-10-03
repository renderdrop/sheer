import type { AnnotationPatch, ContentDraft, Rgb, StdFont } from '../../api/annotations';
import { insertImageDialog, type ImageAssetInfo } from '../../api/content';
import { toAppError, type AppError } from '../../api/errors';
import type { Rect } from '../../api/wire';
import { useAnnotations } from '../../stores/annotations';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useInsert, type ContentObject } from './store';

const BLACK: Rgb = [0, 0, 0];

function withAuthor(draft: ContentDraft): ContentDraft {
  const author = useSettings.getState().authorName;
  return author === '' ? draft : { ...draft, author };
}

/** Runs a command; an error is shown as the banner and answered with `null`. */
async function run(docId: number, command: Parameters<ReturnType<typeof useAnnotations.getState>['apply']>[1]) {
  try {
    return await useAnnotations.getState().apply(docId, command);
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return null;
  }
}

/** The character a text box refused because WinAnsi has no glyph for it (`insert.charset`), or `null` for any other error. */
export function charsetError(error: AppError): string | null {
  const { params } = error;
  return error.code === 'invalid_argument' && params?.what === 'textBox' && params.char !== undefined
    ? params.char
    : null;
}

export interface NewText {
  docId: number;
  pageId: number;
  box: Rect;
  text: string;
  font: StdFont;
  fontSize: number;
  color: Rgb;
}

/** Creates a text box (one undo step). Rejects with the backend's error, so that the editor can show a charset error. */
export async function createTextBox(input: NewText): Promise<ContentObject | null> {
  const changes = await useAnnotations.getState().apply(input.docId, {
    type: 'createAnnotation',
    draft: withAuthor({
      kind: 'textBox',
      pageId: input.pageId,
      color: input.color,
      box: input.box,
      text: input.text,
      font: input.font,
      fontSize: input.fontSize,
      align: 'left',
    }),
  });
  return changes.content?.find((o): o is ContentObject => o.kind === 'textBox' || o.kind === 'image') ?? null;
}

/** Creates an image of an asset the dialog stored (one undo step). Errors show as the banner. */
export async function createImage(
  docId: number,
  pageId: number,
  box: Rect,
  image: ImageAssetInfo,
): Promise<ContentObject | null> {
  const changes = await run(docId, {
    type: 'createAnnotation',
    draft: withAuthor({ kind: 'image', pageId, color: BLACK, box, assetId: image.assetId, aspect: image.aspect }),
  });
  return changes?.content?.find((o): o is ContentObject => o.kind === 'image') ?? null;
}

/** Changes properties of an object; `coalesce` joins a series (a slider) into one undo step. */
export async function updateObject(
  docId: number,
  id: number,
  patch: AnnotationPatch,
  coalesce?: string,
): Promise<void> {
  await run(docId, { type: 'updateAnnotation', id, patch, ...(coalesce === undefined ? {} : { coalesce }) });
}

export async function moveObjects(docId: number, ids: readonly number[], dx: number, dy: number): Promise<void> {
  if (dx === 0 && dy === 0) return;
  await run(docId, { type: 'moveAnnotations', ids, dx, dy });
}

export async function deleteObjects(docId: number, ids: readonly number[]): Promise<void> {
  await run(docId, { type: 'deleteAnnotations', ids });
}

/** Opens the image dialog for the Add image tool. Cancel returns to Select; a bad image shows the banner. */
export async function armImage(docId: number): Promise<void> {
  const store = useInsert.getState();
  store.setArming(true);
  try {
    const image = await insertImageDialog(docId);
    if (image === null) {
      useUi.getState().releaseTool();
    } else {
      useInsert.getState().setPendingImage(image);
    }
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    useUi.getState().releaseTool();
  } finally {
    useInsert.getState().setArming(false);
  }
}
