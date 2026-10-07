// Dev only (DESIGN 3.12 O8): the OCR surfaces of the gate. Each entry fills the OCR store with a state and opens the surface, never
// with new behaviour. `surfaces.ts` imports this behind `import.meta.env.DEV`.
import type { OcrCapabilities, PageClass, PageOcrClass } from '../api/ocr';
import { openOcrDialog, closeOcrDialog } from '../features/ocr/runtime';
import { useOcr, type OcrRun } from '../features/ocr/store';
import { selectionOf, useOrganize } from '../features/organize/store';
import { selectActiveId, useDocuments } from '../stores/documents';
import { readSlots } from '../stores/pages';
import { translators } from '../i18n';
import { useLocaleStore } from '../i18n/store';
import { useUi, type Toast } from '../stores/ui';

import type { DevSurface } from './surfaces';

const WINDOWS = (de: boolean, en: boolean): OcrCapabilities => ({
  backend: 'windows',
  languages: [
    { tag: 'de-DE', available: de },
    { tag: 'en-US', available: en },
  ],
  maxImageDimension: 8000,
});

const activeId = (): number => selectActiveId(useDocuments.getState()) ?? 0;
const done = (): Promise<void> => Promise.resolve();

/** Page classes for the open document: the real pages first, then made-up ones so `count` entries exist. */
function classesFor(docId: number, pattern: readonly PageOcrClass[]): PageClass[] {
  const slots = readSlots(docId);
  return pattern.map((cls, index) => ({ page: slots[index]?.id ?? 900_000 + index, class: cls }));
}

interface Setup {
  capabilities: OcrCapabilities | (() => OcrCapabilities);
  classes: readonly PageOcrClass[];
  run?: OcrRun;
  selected?: boolean;
  /** The first page is a text page, so the banner reads "N pages are images". */
}

function surface(id: string, setup: Setup, open: () => void, close: () => void): DevSurface {
  let before: { capabilities: OcrCapabilities | null; classes: readonly PageClass[] | undefined } | null = null;
  return {
    id,
    open: () => {
      const docId = activeId();
      const state = useOcr.getState();
      before = { capabilities: state.capabilities, classes: state.classes[docId] };
      state.setCapabilities(typeof setup.capabilities === 'function' ? setup.capabilities() : setup.capabilities);
      state.setClasses(docId, classesFor(docId, setup.classes));
      if (setup.run !== undefined) state.setRun(docId, setup.run);
      if (setup.selected === true) {
        const first = readSlots(docId)[0]?.id;
        if (first !== undefined) useOrganize.getState().setSelection(docId, { selected: [first, first + 1] });
      }
      open();
      return done();
    },
    close: () => {
      const docId = activeId();
      close();
      const state = useOcr.getState();
      state.setRun(docId, null);
      if (setup.selected === true && selectionOf(useOrganize.getState(), docId).selected.length > 0) {
        useOrganize.getState().clear(docId);
      }
      if (before !== null) {
        if (before.capabilities !== null) state.setCapabilities(before.capabilities);
        if (before.classes !== undefined) state.setClasses(docId, before.classes);
        else state.forget(docId);
      }
    },
  };
}

const run = (done: number, total: number, stopping = false): OcrRun => ({
  job: 1,
  total,
  done,
  failed: 0,
  stopping,
});
const tr = () => translators[useLocaleStore.getState().locale];
const dismiss = () => useUi.getState().dismissToast();
const toastSurface = (id: string, make: () => Omit<Toast, 'id'>): DevSurface => ({
  id,
  open: () => {
    useUi.getState().showToast(make());
    return done();
  },
  close: dismiss,
});
const nothing = (): void => undefined;

export function ocrSurfaces(): DevSurface[] {
  const scans: PageOcrClass[] = ['text', 'scan', 'scan'];
  const caps = WINDOWS(true, true);
  const otherLanguage = (): OcrCapabilities =>
    useLocaleStore.getState().locale === 'de' ? WINDOWS(false, true) : WINDOWS(true, false);
  const unit = (id: string, setup: Setup, open: () => void, close: () => void) => surface(id, setup, open, close);
  return [
    unit('ocr-banner-offer-pages', { capabilities: caps, classes: scans }, nothing, nothing),
    unit('ocr-banner-offer-page', { capabilities: caps, classes: ['scan', 'scan', 'scan'] }, nothing, nothing),
    unit('ocr-banner-progress-0', { capabilities: caps, classes: scans, run: run(0, 3) }, nothing, nothing),
    unit('ocr-banner-progress-mid', { capabilities: caps, classes: scans, run: run(1, 3) }, nothing, nothing),
    unit(
      'ocr-banner-progress-stopping',
      { capabilities: caps, classes: scans, run: run(1, 3, true) },
      nothing,
      nothing,
    ),
    unit('ocr-dialog', { capabilities: caps, classes: scans }, openOcrDialog, closeOcrDialog),
    unit(
      'ocr-dialog-selected',
      { capabilities: caps, classes: scans, selected: true },
      () => {
        useUi.getState().selectTool('pages');
        openOcrDialog();
      },
      closeOcrDialog,
    ),
    unit(
      'ocr-dialog-redo',
      { capabilities: caps, classes: ['sheerLayer', 'scan', 'scan'] },
      openOcrDialog,
      closeOcrDialog,
    ),
    // Only the language that is not the UI language is installed (read when the surface opens: the gate runs en, then de).
    unit('ocr-dialog-fallback', { capabilities: otherLanguage, classes: scans }, openOcrDialog, closeOcrDialog),
    unit('ocr-dialog-none', { capabilities: WINDOWS(false, false), classes: scans }, openOcrDialog, closeOcrDialog),
    unit('ocr-dialog-empty', { capabilities: caps, classes: ['text', 'text', 'text'] }, openOcrDialog, closeOcrDialog),
    toastSurface('ocr-toast-done', () => ({ message: tr()('ocr.done', { count: 3 }) })),
    toastSurface('ocr-toast-partial', () => ({
      message: tr()('ocr.donePartial', {
        done: tr()('ocr.done', { count: 2 }),
        failed: tr()('ocr.failedCount', { count: 1 }),
      }),
    })),
    toastSurface('ocr-toast-stopped', () => ({ message: tr()('ocr.stopped', { applied: 1, total: 3 }) })),
    toastSurface('ocr-toast-failed', () => ({
      message: tr()('ocr.failed'),
      tone: 'error',
      action: { label: tr()('ocr.retry'), run: nothing },
    })),
  ];
}
