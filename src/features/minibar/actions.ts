import type { ChangeSet, DocCommand } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { runHistoryStep } from '../../actions/history';
import { announce } from '../../components';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { jumpTo } from '../comments/actions';
import { useInsert } from '../insert/store';
import { useStyleStore } from '../inspector/style';
import { useRedact } from '../redact/store';
import { changeCommand, creationKindOf, defaultOf, kindCommand, type MiniChange, type MiniObject } from './model';

/** Runs a command; an error is shown as the banner and answered with `null`. */
async function run(docId: number, command: DocCommand): Promise<ChangeSet | null> {
  try {
    return await useAnnotations.getState().apply(docId, command);
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return null;
  }
}

/**
 * A change made in the bar: applied to the whole selection as one undo step (one update, or one batch), and remembered as the default
 * of the next annotation of each kind it touched (DESIGN v2 3.3).
 */
export async function applyChange(docId: number, objects: readonly MiniObject[], change: MiniChange): Promise<void> {
  const command = changeCommand(objects, change);
  if (command === null) return;
  if ((await run(docId, command)) === null) return;
  for (const object of objects) {
    if (object.locked) continue;
    const kind = creationKindOf(object);
    const style = defaultOf(object, change);
    if (kind !== null && style !== null) useStyleStore.getState().set(kind, style);
    if (object.kind === 'textBox' && style !== null) {
      useInsert.getState().setStyle({
        ...(style.color === undefined ? {} : { color: style.color }),
        ...(style.fontSize === undefined ? {} : { fontSize: style.fontSize }),
      });
    }
  }
}

/** Turns the selected markups into another kind, or marks into another glyph, as one undo step; the replacements are selected. */
export async function changeKind(docId: number, objects: readonly MiniObject[], kind: string): Promise<void> {
  const command = kindCommand(objects, kind);
  if (command === null) return;
  const changes = await run(docId, command);
  if (changes === null) return;
  useAnnotations.getState().select(
    docId,
    changes.upserted.map((annotation) => annotation.id),
  );
}

/** Deletes the selection as one undo step, says so, and offers Undo in a toast (as the other deletes do, DESIGN 3.23). */
export async function deleteSelection(docId: number, objects: readonly MiniObject[]): Promise<void> {
  const ids = objects.filter((object) => !object.locked).map((object) => object.id);
  if (ids.length === 0) return;
  const changes = await run(docId, { type: 'deleteAnnotations', ids });
  if (changes === null) return;
  useAnnotations.getState().clearSelection(docId);
  useInsert.getState().select(docId, null);
  useRedact.getState().select(docId, null);
  const t = translators[useLocaleStore.getState().locale];
  const [first] = objects;
  const type =
    first === undefined
      ? ''
      : first.kind === 'textBox' || first.kind === 'image' || first.kind === 'redactMark'
        ? t(`minibar.type.${first.kind}`)
        : t(`annot.type.${first.kind}`);
  const message = ids.length === 1 ? t('annot.deleted', { type }) : t('insert.deletedMany', { n: ids.length });
  announce(message);
  useUi.getState().showToast({ message, action: { label: t('action.undo'), run: () => runHistoryStep('undo') } });
}

/** The comment of the selected annotation: its tab opens in the left panel and the annotation is shown there. */
export function openComment(docId: number, object: MiniObject): void {
  const ui = useUi.getState();
  ui.setLeftPanelCollapsed(false);
  ui.setLeftPanelTab('comments');
  jumpTo(docId, object.pageId, object.id);
}
