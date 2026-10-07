import { announce } from '../../components/SuccessPulse';
import { toAppError } from '../../api/errors';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { isSignatureLocked } from '../lock/useSignatureLock';
import { isOcrBusy, useOcrBusy } from '../ocr/store';
import { useUi } from '../../stores/ui';
import { isNoopMove, keyboardMove, toIndexFor } from './grid';
import {
  applyPageCommand,
  importWarnings,
  pickPdfSources,
  readSlots,
  releaseSource,
  undoPageStep,
  type Slot,
} from './source';
import { selectionOf, useOrganize } from './store';

/** The pages a command acts on: the selection, else the focused page (DESIGN 3.28); in list order, only pages that exist. */
export function targetsOf(docId: number): number[] {
  const slots = readSlots(docId);
  const { selected, focus } = selectionOf(useOrganize.getState(), docId);
  const wanted = selected.length > 0 ? selected : focus !== null ? [focus] : [];
  const live = new Set(wanted);
  return slots.filter((slot) => live.has(slot.id)).map((slot) => slot.id);
}

/**
 * The tour's sample, a document locked by a certifying signature and a tab that a text recognition run writes into (DESIGN 3.12 O3)
 * are read-only: the page commands do nothing there.
 */
export function isReadOnly(docId: number): boolean {
  return useDocuments.getState().byId[docId]?.kind === 'welcome' || isSignatureLocked(docId) || isOcrBusy(docId);
}

/** `isReadOnly`, followed: the grid draws again when a signature locks the document or a run starts or ends. */
export function useIsReadOnly(docId: number): boolean {
  const busy = useOcrBusy(docId);
  return (
    useDocuments((state) => state.byId[docId]?.kind === 'welcome' || state.byId[docId]?.signatureLock === 'locked') ||
    busy
  );
}

function fail(error: unknown): void {
  useUi.getState().showBanner(toAppError(error));
}

/** Runs a page command and reports a failure in the banner (the model is unchanged then). Resolves to the new list or `null`. */
async function run(docId: number, command: Parameters<typeof applyPageCommand>[1]): Promise<readonly Slot[] | null> {
  if (isReadOnly(docId)) return null;
  try {
    return await applyPageCommand(docId, command);
  } catch (caught) {
    fail(caught);
    return null;
  }
}

/** Rotates the target pages by a quarter turn (one undo step). Returns whether anything was sent. */
export async function rotatePages(docId: number, quarterTurns: -1 | 1 | 2): Promise<boolean> {
  const pages = targetsOf(docId);
  if (pages.length === 0) return false;
  return (await run(docId, { type: 'rotatePages', pages, quarterTurns })) !== null;
}

/**
 * Deletes the target pages: no confirmation, a toast with Undo (DESIGN 3.28). The last page is never deleted, so a command that
 * would remove them all does nothing. The focus goes to the page that took the place of the first one deleted.
 */
export async function deletePages(docId: number): Promise<boolean> {
  const before = readSlots(docId);
  const pages = targetsOf(docId);
  if (pages.length === 0 || pages.length >= before.length) return false;
  const firstIndex = before.findIndex((slot) => slot.id === pages[0]);
  const after = await run(docId, { type: 'deletePages', pages });
  if (after === null) return false;
  const next = after[Math.min(firstIndex, after.length - 1)];
  useOrganize.getState().setSelection(docId, { selected: [], anchor: null, focus: next?.id ?? null });
  const t = translators[useLocaleStore.getState().locale];
  const message = t('organize.deleted', { count: pages.length });
  useUi.getState().showToast({
    message,
    action: { label: t('action.undo'), run: () => void undoPageStep(docId).catch(fail) },
  });
  announce(message);
  return true;
}

/** Moves `pages` so that they sit before the page that has index `insertion` of the current list. */
export async function dropPages(docId: number, pages: readonly number[], insertion: number): Promise<boolean> {
  const slots = readSlots(docId);
  const indices = pages.map((id) => slots.findIndex((slot) => slot.id === id)).filter((index) => index >= 0);
  if (indices.length === 0) return false;
  const toIndex = toIndexFor(indices, insertion);
  if (isNoopMove(indices, toIndex)) return false;
  return moveTo(docId, pages, toIndex);
}

async function moveTo(docId: number, pages: readonly number[], toIndex: number): Promise<boolean> {
  const ordered = readSlots(docId)
    .filter((slot) => pages.includes(slot.id))
    .map((slot) => slot.id);
  const after = await run(docId, { type: 'movePages', pages: ordered, toIndex });
  if (after === null) return false;
  const position = after.findIndex((slot) => slot.id === ordered[0]);
  announce(translators[useLocaleStore.getState().locale]('organize.moved', { n: position + 1 }));
  return true;
}

/** Alt+arrow: the selection (or the focused page) moves `delta` places in the order. */
export async function moveByKeys(docId: number, delta: number): Promise<boolean> {
  const slots = readSlots(docId);
  const pages = targetsOf(docId);
  const indices = pages.map((id) => slots.findIndex((slot) => slot.id === id));
  const move = keyboardMove(indices, slots.length, delta);
  return move === null ? false : moveTo(docId, pages, move.toIndex);
}

/** The index a new page goes to: after the focused page, else at the end (DESIGN 3.28). */
function insertionIndex(docId: number): number {
  const slots = readSlots(docId);
  const { focus } = selectionOf(useOrganize.getState(), docId);
  const at = slots.findIndex((slot) => slot.id === focus);
  return at < 0 ? slots.length : at + 1;
}

/** The new pages become the selection and pulse (MOTION 4.7). */
function showInserted(docId: number, before: readonly Slot[], after: readonly Slot[]): void {
  const known = new Set(before.map((slot) => slot.id));
  const added = after.filter((slot) => !known.has(slot.id)).map((slot) => slot.id);
  if (added.length === 0) return;
  const store = useOrganize.getState();
  store.setSelection(docId, { selected: added, anchor: added[0] ?? null, focus: added[0] ?? null });
  store.setPulse(added);
}

/** Inserts a blank page after the focused page, sized like it (a page of the document's first page's size at the very start). */
export async function insertBlank(docId: number): Promise<boolean> {
  const before = readSlots(docId);
  const at = insertionIndex(docId);
  const neighbour = before[Math.min(Math.max(0, at - 1), before.length - 1)];
  const after = await run(docId, {
    type: 'insertBlankPage',
    at,
    ...(neighbour === undefined ? {} : { width: neighbour.width, height: neighbour.height }),
  });
  if (after === null) return false;
  showInserted(docId, before, after);
  return true;
}

/** Inserts all pages of a PDF the user picks (Rust's Open dialog) after the focused page. */
export async function insertFromFile(docId: number): Promise<boolean> {
  if (isReadOnly(docId)) return false;
  let results;
  try {
    results = await pickPdfSources(false);
  } catch (caught) {
    fail(caught);
    return false;
  }
  const source = results[0];
  if (source === undefined) return false;
  if (source.type === 'failed') {
    fail(source);
    return false;
  }
  const before = readSlots(docId);
  const pages = Array.from({ length: Math.min(source.pageCount, 5000) }, (_, index) => index);
  const after = await run(docId, { type: 'insertPages', source: source.sourceId, pages, at: insertionIndex(docId) });
  releaseSource(source.sourceId).catch(() => undefined);
  if (after === null) return false;
  showInserted(docId, before, after);
  await noteTruncation(docId);
  return true;
}

/** Annotations of the inserted pages that did not fit the model stay in the file: say so in a toast (never an error). */
async function noteTruncation(docId: number): Promise<void> {
  try {
    const skipped = (await importWarnings(docId)).reduce((sum, warning) => sum + warning.skipped, 0);
    if (skipped === 0) return;
    const message = translators[useLocaleStore.getState().locale]('organize.truncated', { count: skipped });
    useUi.getState().showToast({ message });
    announce(message);
  } catch {
    // A note that cannot be read is not worth a message.
  }
}
