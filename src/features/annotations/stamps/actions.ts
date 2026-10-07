import type { Annotation, AnnotationDraft, Rgb, StampTone } from '../../../api/annotations';
import type { Rect } from '../../../api/wire';
import { announce } from '../../../components';
import { translators } from '../../../i18n';
import { useLocaleStore } from '../../../i18n/store';
import { useAnnotations } from '../../../stores/annotations';
import { useSettings } from '../../../stores/settings';
import { useUi } from '../../../stores/ui';
import { reportRefusal } from '../create/refusal';
import { defaultSize, type StampFace } from './model';
import { useStamp } from './store';

/** The annotation colour of a tone: always the tone's (the backend ignores a draft colour and mirrors these from `tokens.css`). */
export const TONE_RGB: Readonly<Record<StampTone, Rgb>> = { solar: [255, 248, 77], ink: [15, 15, 15] };

const t = (...args: Parameters<(typeof translators)['en']>) => translators[useLocaleStore.getState().locale](...args);

/** The draft of a stamp: the author name of the settings is added when there is one (ADR-034). */
export function stampDraft(pageIndex: number, box: Rect, face: StampFace, tone: StampTone): AnnotationDraft {
  const author = useSettings.getState().authorName;
  return {
    kind: 'stamp',
    pageId: pageIndex,
    color: TONE_RGB[tone],
    box,
    stamp: face.stamp,
    text: face.text,
    date: face.date,
    tone,
    ...(author === '' ? {} : { author }),
  };
}

/**
 * Places a stamp: one command, one undo step (`stamp.undo.add`). The new stamp is selected (handles and mini bar), the tool returns to
 * Auswahl unless it is locked, an own text joins the recent list, and a polite message says where it went (DESIGN 3.14 ST3, ST7).
 */
export async function placeStamp(
  docId: number,
  pageIndex: number,
  box: Rect,
  face: StampFace,
  tone: StampTone,
): Promise<Annotation | null> {
  try {
    const changes = await useAnnotations.getState().apply(docId, {
      type: 'batch',
      label: 'stamp.undo.add',
      commands: [{ type: 'createAnnotation', draft: stampDraft(pageIndex, box, face, tone) }],
    });
    const created = changes.upserted.find((annotation) => annotation.kind === 'stamp') ?? null;
    if (created === null) return null;
    useAnnotations.getState().select(docId, [created.id]);
    if (face.stamp === 'custom') useStamp.getState().remember({ text: face.text, date: face.date !== null });
    useStamp.getState().setKeyboard(false);
    const ui = useUi.getState();
    if (!ui.toolLocked) ui.releaseTool();
    announce(t('stamp.announce.placed', { page: pageIndex + 1 }));
    return created;
  } catch (caught) {
    reportRefusal(caught);
    return null;
  }
}

/**
 * The box a stamp gets when its text is replaced: the same centre and height, the width of the new text at that height, kept inside
 * the page.
 */
export function replacedBox(old: Rect, face: StampFace, page: readonly [number, number] | null): Rect {
  const natural = defaultSize(face);
  const h = old.h;
  const w = (natural.w * h) / natural.h;
  let x = old.x + old.w / 2 - w / 2;
  let y = old.y;
  if (page !== null) {
    x = Math.min(Math.max(x, 0), Math.max(0, page[0] - w));
    y = Math.min(Math.max(y, 0), Math.max(0, page[1] - h));
  }
  return { x, y, w, h };
}

/**
 * The mini bar's Change…: the stamp is replaced by one with the chosen text (the delete and the new stamp are one step,
 * `stamp.undo.edit`), keeping its centre and height; the replacement is selected.
 */
export async function replaceStamp(
  docId: number,
  old: Extract<Annotation, { kind: 'stamp' }>,
  face: StampFace,
  tone: StampTone,
  page: readonly [number, number] | null,
): Promise<void> {
  const box = replacedBox(old.box, face, page);
  try {
    const changes = await useAnnotations.getState().apply(docId, {
      type: 'batch',
      label: 'stamp.undo.edit',
      commands: [
        { type: 'deleteAnnotations', ids: [old.id] },
        { type: 'createAnnotation', draft: stampDraft(old.pageId, box, face, tone) },
      ],
    });
    const created = changes.upserted.find((annotation) => annotation.kind === 'stamp');
    if (created !== undefined) useAnnotations.getState().select(docId, [created.id]);
    if (face.stamp === 'custom') useStamp.getState().remember({ text: face.text, date: face.date !== null });
  } catch (caught) {
    reportRefusal(caught);
  }
}
