import { announce } from '../../components/SuccessPulse';
import {
  ocrCancel,
  ocrCapabilities,
  ocrClassifyPages,
  ocrStart,
  type OcrFinished,
  type OcrLanguageTag,
  type OcrProgress,
} from '../../api/ocr';
import type { PageSelection } from '../../api/pageSelection';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { selectionOf, useOrganize } from '../organize/store';
import { onChangeSet, useAnnotations } from '../../stores/annotations';
import { useSearch } from '../search/store';
import { dropDocumentText } from '../textlayer/cache';
import { useOcr, type OcrRun } from './store';

const translate = () => translators[useLocaleStore.getState().locale];

/** Loads what the recognizer can do, once (the answer does not change while the app runs). Never rejects. */
export async function ensureCapabilities(): Promise<void> {
  if (useOcr.getState().capabilities !== null) return;
  try {
    useOcr.getState().setCapabilities(await ocrCapabilities());
  } catch {
    // No backend (a browser, a test): the command stays as it is.
  }
}

/** Reads the OCR class of every page of the tab. Never rejects; a failure leaves the old answer. */
export async function refreshClasses(docId: number): Promise<void> {
  try {
    const classes = await ocrClassifyPages(docId);
    if (useDocuments.getState().byId[docId] !== undefined) useOcr.getState().setClasses(docId, classes);
  } catch {
    // The offer is optional; nothing to say.
  }
}

/** Opens the dialog for the active tab. Pages mode with cards selected preselects "Selected pages" (O1). */
export function openOcrDialog(): void {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null) return;
  const selected =
    useUi.getState().activeTool === 'pages' && selectionOf(useOrganize.getState(), docId).selected.length > 0;
  useOcr.getState().openDialog({ docId, preselectSelected: selected });
}

export function closeOcrDialog(): void {
  useOcr.getState().openDialog(null);
}

function failedToast(): void {
  const t = translate();
  useUi.getState().showToast({
    message: t('ocr.failed'),
    tone: 'error',
    action: { label: t('ocr.retry'), run: openOcrDialog },
  });
}

/**
 * Starts a run. The tab is busy from this call on (`expected` pages; `ocrProgress` corrects it). A refused start ends the busy state
 * again and shows the error toast. Resolves to whether the start was accepted.
 */
export async function startOcr(
  docId: number,
  pages: PageSelection,
  lang: OcrLanguageTag,
  redo: boolean,
  expected: number,
): Promise<boolean> {
  const run: OcrRun = { job: null, total: expected, done: 0, failed: 0, stopping: false };
  useOcr.getState().setRun(docId, run);
  try {
    const started = await ocrStart(docId, pages, lang, redo);
    useOcr.getState().patchRun(docId, { job: started.job });
    announce(translate()('ocr.announce.start', { count: expected }));
    return true;
  } catch {
    useOcr.getState().setRun(docId, null);
    failedToast();
    return false;
  }
}

/** Stop: the run ends after its current page; the label changes at once. */
export function stopOcr(docId: number): void {
  const run = useOcr.getState().runs[docId];
  if (run === undefined || run.stopping) return;
  useOcr.getState().patchRun(docId, { stopping: true });
  if (run.job !== null) void ocrCancel(run.job).catch(() => undefined);
}

export function onOcrProgress(event: OcrProgress): void {
  const run = useOcr.getState().runs[event.doc];
  if (run === undefined) return;
  useOcr.getState().patchRun(event.doc, {
    job: run.job ?? event.job,
    done: event.done,
    total: event.total,
    failed: event.failed,
  });
}

export function onOcrFinished(event: OcrFinished): void {
  const run = useOcr.getState().runs[event.doc];
  if (run === undefined) return;
  const t = translate();
  const stopped = run.stopping;
  const total = Math.max(run.total, event.applied + event.failed);
  useOcr.getState().setRun(event.doc, null);
  void refreshClasses(event.doc);
  if (event.applied > 0) noteOcrApplied(event.doc);
  if (event.refused === 'readOnly') {
    const message = t('cert.locked.tool');
    useUi.getState().showToast({ message });
    announce(message);
    return;
  }
  if (event.applied === 0 && event.failed > 0) {
    failedToast();
    return;
  }
  const message = stopped
    ? t('ocr.stopped', { applied: event.applied, total })
    : event.failed > 0
      ? t('ocr.donePartial', {
          done: t('ocr.done', { count: event.applied }),
          failed: t('ocr.failedCount', { count: event.failed }),
        })
      : t('ocr.done', { count: event.applied });
  useUi.getState().showToast({ message });
  announce(message);
}

/**
 * The backend applies a run's layers as one undo step but sends no change set with `ocrFinished`. The window records that step the
 * way a change set would: the revision grows, Undo is there, the document is dirty, and the listeners hear a change of the `ocr` part.
 */
export function noteOcrApplied(docId: number): void {
  const rev = (useAnnotations.getState().byDoc[docId]?.rev ?? 0) + 1;
  useAnnotations.getState().applyChanges(docId, {
    rev,
    upserted: [],
    removed: [],
    pages: null,
    doc: ['ocr'],
    history: { canUndo: true, canRedo: false, undoLabel: 'ocr.undo', redoLabel: null, dirty: true },
  });
}

// Whatever changes the recognized text (a run, its undo, its redo) makes the views that hold text read it again: the text layers of the
// pages and the search results (smart links follow the revision, which every change set moves).
onChangeSet((docId, changes) => {
  if (changes === null || changes.doc?.includes('ocr') !== true) return;
  dropDocumentText(docId);
  useSearch.getState().retry(docId);
});
