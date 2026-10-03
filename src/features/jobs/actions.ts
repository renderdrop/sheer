import { extractPages, type PageId } from '../../api/jobs';
import { toAppError } from '../../api/errors';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { openCompress, openMerge, openSplit } from './state';

/** Merge files… (More, File menu): the sheet, with the active document first. */
export const runMerge = (): void => openMerge();
/** Split… */
export const runSplit = (): void => openSplit('every');
/** Compress… */
export const runCompress = (): void => openCompress();

/**
 * Where Organize mode (package R2, `features/pages`) tells the jobs which pages are selected: it registers a function that
 * returns the selected page ids of the active document, or `null`/an empty list when there is no selection or Organize is not
 * open. Extract with a selection goes straight to Rust's Save As (DESIGN 3.30); without one it opens the dialog on Extract.
 */
let selectionProvider: (() => readonly PageId[] | null) | null = null;
export function setPageSelectionProvider(provider: (() => readonly PageId[] | null) | null): void {
  selectionProvider = provider;
}

/** The `extract-pages` action. */
export function runExtract(): void {
  const docId = useDocuments.getState().activeId;
  if (docId === null) return;
  const selected = selectionProvider?.() ?? null;
  if (selected === null || selected.length === 0) {
    openSplit('extract');
    return;
  }
  extractPages(docId, [...selected], (event) => {
    const ui = useUi.getState();
    if (event.type === 'failed') ui.showBanner(event.error);
    else if (event.type === 'done')
      ui.showToast({ message: translators[useLocaleStore.getState().locale]('split.done', { count: event.outputs }) });
  }).catch((caught: unknown) => useUi.getState().showBanner(toAppError(caught)));
}
