// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mayRecognize, type ActionState } from '../../actions/state';
import type { DocumentInfo } from '../../api/documents';
import type { OcrCapabilities, PageClass, PageOcrClass } from '../../api/ocr';
import type { PageSlotInfo } from '../../api/pages';
import { onChangeSet, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useOrganize } from '../organize/store';
import { useSearch } from '../search/store';
import { dropDocumentText } from '../textlayer/cache';
import { OcrBanner } from './OcrBanner';
import { OcrPanel } from './OcrPanel';
import { countScope, languageState, offerWanted, runCount, selectionFor, wantedLanguage } from './model';
import { onOcrFinished, onOcrProgress, openOcrDialog, startOcr } from './runtime';
import { isOcrBusy, useOcr } from './store';

const api = vi.hoisted(() => ({
  ocrCapabilities: vi.fn(),
  ocrClassifyPages: vi.fn(),
  ocrStart: vi.fn(),
  ocrCancel: vi.fn(),
  openLanguageSettings: vi.fn(),
}));
vi.mock('../../api/ocr', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

vi.mock('../textlayer/cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dropDocumentText: vi.fn(),
}));

MotionGlobalConfig.skipAnimations = true;

const DOC: DocumentInfo = { id: 1, pageCount: 3, displayName: 'A.pdf' };
const slots: PageSlotInfo[] = [10, 11, 12].map((id) => ({
  id,
  width: 612,
  height: 792,
  rotation: 0,
  rev: 0,
  label: null,
  origin: 'file',
}));
const caps = (de: boolean, en: boolean, backend: OcrCapabilities['backend'] = 'windows'): OcrCapabilities => ({
  backend,
  languages: [
    { tag: 'de-DE', available: de },
    { tag: 'en-US', available: en },
  ],
  maxImageDimension: 8000,
});
const classes = (...list: PageOcrClass[]): PageClass[] => list.map((cls, index) => ({ page: 10 + index, class: cls }));

function seed(capabilities: OcrCapabilities, list: PageClass[]) {
  api.ocrCapabilities.mockResolvedValue(capabilities);
  api.ocrClassifyPages.mockResolvedValue(list);
  useOcr.setState({ capabilities, classes: { 1: list } });
}

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add(DOC);
  usePages.getState().setSlots(1, slots);
  Object.values(api).forEach((mock) => mock.mockReset());
  api.ocrStart.mockResolvedValue({ job: 7, langUsed: 'en-US', notice: null });
  api.ocrCancel.mockResolvedValue(undefined);
  useOcr.setState({ capabilities: null, classes: {}, runs: {}, dismissed: {}, dialog: null });
  useOrganize.setState({ byDoc: {} });
  useAnnotations.getState().remove(1);
  useUi.setState({ toast: null, activeTool: 'select' });
});

describe('the model', () => {
  it('follows the UI language and finds the fallback', () => {
    expect(wantedLanguage('de')).toBe('de-DE');
    expect(wantedLanguage('en')).toBe('en-US');
    expect(languageState(null, 'en-US')).toEqual({ kind: 'loading' });
    expect(languageState(caps(true, true), 'en-US')).toEqual({ kind: 'available' });
    expect(languageState(caps(true, false), 'en-US')).toEqual({ kind: 'fallback', used: 'de-DE' });
    expect(languageState(caps(false, false), 'en-US')).toEqual({ kind: 'none' });
  });

  it('counts scans and layers, and Redo adds the layers', () => {
    const list = classes('scan', 'sheerLayer', 'text', 'scan');
    const counts = countScope(list, [10, 11, 12, 13]);
    expect(counts).toEqual({ inScope: 4, scan: 2, sheerLayer: 1 });
    expect(runCount(counts, false)).toBe(2);
    expect(runCount(counts, true)).toBe(3);
    expect(selectionFor('scan', list, 10, [], true)).toEqual({ type: 'pages', pages: [10, 11, 13] });
    expect(selectionFor('scan', list, 10, [], false)).toEqual({ type: 'pages', pages: [10, 13] });
    expect(selectionFor('all', list, 10, [], false)).toEqual({ type: 'all' });
    expect(selectionFor('current', list, 11, [], false)).toEqual({ type: 'current', pageId: 11 });
    expect(selectionFor('selected', list, 10, [10, 12], false)).toEqual({ type: 'pages', pages: [10, 12] });
  });

  it('wants the offer only with scans, a recognizer, no lock and no dismissal', () => {
    const base = { backendNone: false, scanPages: 1, locked: false, dismissed: false, readOnly: false };
    expect(offerWanted(base)).toBe(true);
    for (const change of [
      { backendNone: true },
      { scanPages: 0 },
      { locked: true },
      { dismissed: true },
      { readOnly: true },
    ]) {
      expect(offerWanted({ ...base, ...change })).toBe(false);
    }
  });

  it('enables the command by the table of DESIGN 3.12 O4', () => {
    const ok: ActionState = {
      hasDocument: true,
      zoomAtMin: false,
      zoomAtMax: false,
      canUndo: false,
      canRedo: false,
    };
    expect(mayRecognize(ok)).toBe(true);
    expect(mayRecognize({ ...ok, ocrUnavailable: true })).toBe(false);
    expect(mayRecognize({ ...ok, signatureLocked: true })).toBe(false);
    expect(mayRecognize({ ...ok, canEdit: false })).toBe(false);
    expect(mayRecognize({ ...ok, readOnly: true })).toBe(false);
    expect(mayRecognize({ ...ok, ocrBusy: true })).toBe(false);
    expect(mayRecognize({ ...ok, hasDocument: false })).toBe(false);
  });
});

describe('the banner', () => {
  const shown = () => document.querySelector<HTMLElement>('[data-surface="ocr-banner"]');

  it('offers "N pages are images" and opens the dialog', async () => {
    seed(caps(true, true), classes('text', 'scan', 'scan'));
    const { user } = setup(<OcrBanner />);
    await waitFor(() => expect(shown()?.dataset.variant).toBe('offer'));
    expect(shown()?.textContent).toContain('2 pages are images. Recognize text?');
    await user.click(screen.getByRole('button', { name: 'Recognize text…' }));
    expect(useOcr.getState().dialog).toEqual({ docId: 1, preselectSelected: false });
  });

  it('says "This page is an image" on a scan page', async () => {
    seed(caps(true, true), classes('scan', 'scan', 'scan'));
    render(<OcrBanner />);
    await waitFor(() => expect(shown()?.textContent).toContain('This page is an image. Recognize text?'));
  });

  it('hides for a hidden offer, closes for the tab and stays away without scans, recognizer, edit right or with a lock', async () => {
    seed(caps(true, true), classes('scan'));
    const { user } = setup(<OcrBanner />);
    await waitFor(() => expect(shown()).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(shown()).toBeNull();
    expect(useOcr.getState().dismissed[1]).toBe(true);
  });

  it.each([
    ['no scan pages', () => seed(caps(true, true), classes('text', 'empty'))],
    ['backend none', () => seed(caps(false, false, 'none'), classes('scan'))],
    [
      'a locked document',
      () => {
        seed(caps(true, true), classes('scan'));
        useDocuments.getState().add({ ...DOC, signatureLock: 'locked' });
      },
    ],
    [
      'no modify permission',
      () => {
        seed(caps(true, true), classes('scan'));
        useDocuments.getState().add({
          ...DOC,
          flags: { encrypted: true, xfa: false, hasForms: false, signed: false, permissions: ['print'] },
        });
      },
    ],
  ])('shows no banner for %s', async (_name, arrange) => {
    arrange();
    render(<OcrBanner />);
    await act(async () => undefined);
    expect(shown()).toBeNull();
  });

  it('shows progress with a determinate bar and Stop, then the stopping state', async () => {
    seed(caps(true, true), classes('scan', 'scan', 'scan'));
    useOcr.getState().setRun(1, { job: 7, total: 3, done: 0, failed: 0, stopping: false });
    const { user } = setup(<OcrBanner />);
    await waitFor(() => expect(shown()?.dataset.variant).toBe('progress'));
    expect(shown()?.textContent).toContain('Recognizing page 1 of 3');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    act(() => onOcrProgress({ type: 'ocrProgress', doc: 1, job: 7, done: 1, total: 3, failed: 0 }));
    expect(shown()?.textContent).toContain('Recognizing page 2 of 3');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Recognizing page 2 of 3');
    // No per-page announcements (O6): nothing in the banner is a live region that changes with the page.
    expect(shown()?.closest('[role="status"], [aria-live="polite"], [aria-live="assertive"]')).toBeNull();
    expect(shown()?.querySelector('[role="status"], [aria-live="polite"], [aria-live="assertive"]')).toBeNull();
    expect(document.querySelector('[data-ocr="label"]')?.getAttribute('aria-live')).toBe('off');
    expect(document.querySelector('[data-ocr="count"]')?.textContent).toBe('1/3');
    expect(document.querySelector<HTMLElement>('[data-ocr="bar-fill"]')?.style.width).toBe('33%');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.ocrCancel).toHaveBeenCalledWith(7);
    expect(shown()?.textContent).toContain('Stopping…');
    expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the inspector form', () => {
  const open = async (preselect = false) => {
    const view = setup(<OcrPanel />);
    act(() => useOcr.getState().openDialog({ docId: 1, preselectSelected: preselect }));
    await screen.findByRole('complementary');
    return view;
  };

  it('defaults to scanned pages and starts with the scan page ids', async () => {
    seed(caps(true, true), classes('text', 'scan', 'scan'));
    const { user } = await open();
    expect((screen.getByRole('radio', { name: 'Scanned pages (2)' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('radio', { name: /Selected pages/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Recognize' }));
    expect(api.ocrStart).toHaveBeenCalledWith(1, { type: 'pages', pages: [11, 12] }, 'en-US', false);
    expect(useOcr.getState().dialog).toBeNull();
    expect(isOcrBusy(1)).toBe(true);
  });

  it('labels the scope group and marks the selection without colour', async () => {
    seed(caps(true, true), classes('text', 'scan', 'scan'));
    const { user } = await open();
    const group = screen.getByRole('radiogroup', { name: 'Pages' });
    expect(group).not.toBeNull();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(group.querySelector('[data-checked]')?.getAttribute('data-scope')).toBe('scan');
    radios[0]?.focus();
    await user.keyboard('{ArrowDown}');
    const after = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(after.map((radio) => radio.checked)).toEqual([false, true, false]);
    expect(document.activeElement).toBe(after[1]);
    expect(group.querySelector('[data-checked]')?.getAttribute('data-scope')).toBe('current');
  });

  it('preselects the selected pages from Pages mode', async () => {
    seed(caps(true, true), classes('scan', 'scan', 'text'));
    useOrganize.getState().setSelection(1, { selected: [10, 11] });
    useUi.setState({ activeTool: 'pages' });
    act(() => openOcrDialog());
    setup(<OcrPanel />);
    await screen.findByRole('complementary');
    expect((screen.getByRole('radio', { name: 'Selected pages (2)' }) as HTMLInputElement).checked).toBe(true);
  });

  it('with no scan pages shows the reason and disables Start', async () => {
    seed(caps(true, true), classes('text', 'empty'));
    await open();
    expect(screen.getByRole('radio', { name: 'Scanned pages (0)' })).not.toBeNull();
    expect(document.querySelector('[data-ocr="nothing"]')?.textContent).toContain(
      'No scanned pages to recognize here.',
    );
    expect(document.querySelector('[data-inspector="apply"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the Redo row only with layers of this session, and Redo adds them', async () => {
    seed(caps(true, true), classes('sheerLayer', 'scan', 'text'));
    const { user } = await open();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Recognize' }));
    expect(api.ocrStart).toHaveBeenCalledWith(1, { type: 'pages', pages: [10, 11] }, 'en-US', true);
  });

  it('has no Redo row without layers', async () => {
    seed(caps(true, true), classes('scan'));
    await open();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('names the fallback language', async () => {
    seed(caps(true, false), classes('scan'));
    await open();
    expect(document.querySelector('[data-ocr="language-fallback"]')?.textContent).toContain(
      "English recognition isn't installed on this computer; German is used",
    );
    expect(document.querySelector('[data-inspector="apply"]')?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('with no language says so, gives the settings path in words and disables Start', async () => {
    seed(caps(false, false), classes('scan'));
    await open();
    expect(document.querySelector('[data-ocr="language-none"]')?.textContent).toContain(
      'No recognition language is installed on this computer.',
    );
    expect(document.querySelector('[data-ocr="settings-hint"]')).toBeNull();
    expect(document.querySelector('[data-inspector="apply"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('on Windows the settings button opens the language settings; if that fails the words stay', async () => {
    seed(caps(false, false), classes('scan'));
    api.openLanguageSettings.mockRejectedValue(new Error('no'));
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Open language settings' }));
    expect(api.openLanguageSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector('[data-ocr="settings-hint"]')).not.toBeNull());
  });

  it('on another backend only the instruction text shows', async () => {
    seed(caps(false, false, 'vision'), classes('scan'));
    await open();
    expect(screen.queryByRole('button', { name: 'Open language settings' })).toBeNull();
    expect(document.querySelector('[data-ocr="settings-hint"]')?.textContent).toContain('System Settings');
    expect(document.querySelector('[data-ocr="settings-hint"]')?.textContent).not.toContain('Windows');
  });

  it('on the Vision backend the fallback notice shows like anywhere', async () => {
    seed(caps(true, false, 'vision'), classes('scan'));
    await open();
    expect(document.querySelector('[data-ocr="language-fallback"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Open language settings' })).toBeNull();
  });

  it('Close and Esc close without starting', async () => {
    seed(caps(true, true), classes('scan'));
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(api.ocrStart).not.toHaveBeenCalled();
    act(() => useOcr.getState().openDialog({ docId: 1, preselectSelected: false }));
    await screen.findByRole('complementary');
    await user.keyboard('{Escape}');
    expect(useOcr.getState().dialog).toBeNull();
    expect(api.ocrStart).not.toHaveBeenCalled();
  });

  it('Enter on a scope starts, Reset brings the scope back, and the first scope takes focus', async () => {
    seed(caps(true, true), classes('text', 'scan', 'scan'));
    const { user } = await open();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(document.activeElement).toBe(radios[0]);
    expect(screen.getByRole('button', { name: 'Reset' }).getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByRole('radio', { name: 'Scanned pages (2)' }) as HTMLInputElement).checked).toBe(true);
    screen.getByRole('radio', { name: 'Scanned pages (2)' }).focus();
    await user.keyboard('{Enter}');
    expect(api.ocrStart).toHaveBeenCalledTimes(1);
    expect(useOcr.getState().dialog).toBeNull();
  });

  it('a refused start ends the busy state and shows the error toast with Try again', async () => {
    seed(caps(true, true), classes('scan'));
    api.ocrStart.mockRejectedValue(new Error('refused'));
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Recognize' }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe("Text couldn't be recognized."));
    expect(useUi.getState().toast?.tone).toBe('error');
    expect(isOcrBusy(1)).toBe(false);
    act(() => useUi.getState().toast?.action?.run());
    expect(useOcr.getState().dialog).not.toBeNull();
  });
});

describe('a refused start names the reason', () => {
  it.each([
    ['read_only', "This document can't be edited."],
    ['unsupported_feature', "Text recognition isn't available on this computer."],
  ])('%s', async (code, message) => {
    api.ocrStart.mockRejectedValue({ code, retryable: false });
    await startOcr(1, { type: 'pages', pages: [10] }, 'en-US', false, 1);
    expect(useUi.getState().toast?.message).toBe(message);
    expect(isOcrBusy(1)).toBe(false);
  });
});

describe('the result toasts', () => {
  const run = (stopping = false) => useOcr.getState().setRun(1, { job: 7, total: 3, done: 3, failed: 0, stopping });
  const finish = (applied: number, failed: number) =>
    act(() => onOcrFinished({ type: 'ocrFinished', doc: 1, job: 7, applied, skipped: 0, failed }));

  beforeEach(() => api.ocrClassifyPages.mockResolvedValue([]));

  it('says how many pages were recognized', () => {
    run();
    finish(3, 0);
    expect(useUi.getState().toast?.message).toBe('Text recognized on 3 pages');
    expect(isOcrBusy(1)).toBe(false);
  });

  it('records the step: Undo is there, the document is dirty, text views read again', () => {
    useAnnotations.getState().applyChanges(1, {
      rev: 4,
      upserted: [],
      removed: [],
      pages: null,
      history: { canUndo: false, canRedo: true, undoLabel: null, redoLabel: 'x', dirty: false },
    });
    const search = vi.spyOn(useSearch.getState(), 'retry').mockImplementation(() => undefined);
    const heard: (readonly string[] | undefined)[] = [];
    const off = onChangeSet((_doc, changes) => heard.push(changes?.doc));
    run();
    finish(2, 0);
    off();
    const doc = useAnnotations.getState().byDoc[1];
    expect(doc?.rev).toBe(5);
    expect(doc?.history).toMatchObject({ canUndo: true, canRedo: false, dirty: true, undoLabel: 'ocr.undo' });
    expect(heard).toEqual([['ocr']]);
    expect(search).toHaveBeenCalledWith(1);
  });

  it('forgets the text layers of the document when the ocr part changes', () => {
    vi.mocked(dropDocumentText).mockClear();
    run();
    finish(1, 0);
    expect(dropDocumentText).toHaveBeenCalledWith(1);
  });

  it('does not touch the history when nothing was applied', () => {
    run();
    finish(0, 0);
    expect(useAnnotations.getState().byDoc[1]?.history.canUndo).not.toBe(true);
  });

  it('shows the read-only notice, not the failure toast, when the document got locked', () => {
    run();
    act(() =>
      onOcrFinished({ type: 'ocrFinished', doc: 1, job: 7, applied: 1, skipped: 2, failed: 0, refused: 'readOnly' }),
    );
    expect(useUi.getState().toast?.message).toBe('Signed and locked. Make an editable copy to change it.');
    expect(useUi.getState().toast?.tone).not.toBe('error');
    expect(isOcrBusy(1)).toBe(false);
  });

  it('names the failures', () => {
    run();
    finish(2, 1);
    expect(useUi.getState().toast?.message).toBe('Text recognized on 2 pages; 1 failed');
  });

  it('says how far a stopped run got', () => {
    run(true);
    finish(1, 0);
    expect(useUi.getState().toast?.message).toBe('Stopped. Text recognized on 1 of 3 pages');
  });

  it('shows the error toast when nothing was applied and pages failed', () => {
    run();
    finish(0, 3);
    expect(useUi.getState().toast).toMatchObject({ message: "Text couldn't be recognized.", tone: 'error' });
  });

  it('ignores a finish for a tab without a run', () => {
    finish(1, 0);
    expect(useUi.getState().toast).toBeNull();
  });
});
