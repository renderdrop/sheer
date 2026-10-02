// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { activeDocument, openFailed, opened, resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { useViewer, useViewerEffects } from './useViewer';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  renderPage: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();

const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };
const OTHER: DocumentInfo = { id: 2, pageCount: 3, displayName: 'Other.pdf' };

const page = (scale = 4 / 3) => ({ data: new Uint8Array([1, 2, 3]), width: 816, height: 1056, scale });

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  documentsApi.renderPage.mockReset().mockResolvedValue(page());
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  let urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:page-${(urls += 1)}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  reset();
});

const viewer = () => useViewer.getState();
const zoomOf = (id = REPORT.id) => useView.getState().byDoc[id]?.zoom;

describe('opening a document', () => {
  it('registers it with a view at 100 % on the first page, and shows no image yet', async () => {
    await act(() => viewer().open());
    expect(activeDocument()).toEqual(REPORT);
    expect(useView.getState().byDoc[1]).toEqual({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 10 });
    expect(viewer().image).toBeNull();
    expect(viewer().opening).toBe(false);
  });

  it('is "opening" while the dialog is up, and a second open in that time does not start a second dialog', async () => {
    let finish: (info: DocumentInfo | null) => void = () => undefined;
    documentsApi.openDocumentDialog.mockReturnValue(
      new Promise<DocumentInfo | null>((resolve) => {
        finish = resolve;
      }),
    );
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = viewer().open();
    });
    expect(viewer().opening).toBe(true);
    await act(() => viewer().open());
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(null);
      await first;
    });
    expect(viewer().opening).toBe(false);
  });

  it('a cancelled dialog changes nothing and clears the error that was there', async () => {
    useUi.getState().showBanner({ code: 'internal', key: 'error.internal', retryable: false });
    documentsApi.openDocumentDialog.mockResolvedValue([]);
    await act(() => viewer().open());
    expect(activeDocument()).toBeNull();
    expect(useUi.getState().banner).toBeNull();
    expect(useView.getState().byDoc).toEqual({});
  });

  it('a failed open shows the error in the banner, and the open document stays', async () => {
    await act(() => viewer().open());
    documentsApi.openDocumentDialog.mockRejectedValue({
      code: 'damaged_file',
      key: 'error.damaged_file',
      retryable: false,
    });
    await act(() => viewer().open());
    expect(useUi.getState().banner).toMatchObject({ code: 'damaged_file' });
    expect(activeDocument()).toEqual(REPORT);
    expect(viewer().opening).toBe(false);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });

  it('a second document is added beside the first and shown; the first stays open and keeps its view', async () => {
    await act(() => viewer().open());
    act(() => viewer().zoomStep(1));
    useViewer.setState({ image: { url: 'blob:old', widthPt: 612, heightPt: 792 } });
    documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
    await act(() => viewer().open());
    expect(activeDocument()).toEqual(OTHER);
    expect(viewer().image).toBeNull();
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1', '2']);
    expect(zoomOf(1)).toBe(1.1);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });

  it('several documents from one dialog are all opened and the last one is shown', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), opened(OTHER)]);
    await act(() => viewer().open());
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(OTHER);
    expect(useView.getState().byDoc[1]).toEqual({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 10 });
    expect(useView.getState().byDoc[2]).toEqual({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 3 });
  });

  it('a document that is open already (the backend answers with the id it has) is brought forward, not added twice', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), opened(OTHER)]);
    await act(() => viewer().open());
    act(() => useDocuments.getState().setActive(1));
    act(() => viewer().zoomStep(1));
    act(() => viewer().goToPage(4));
    useViewer.setState({ image: { url: 'blob:report', widthPt: 612, heightPt: 792 } });
    // Opening the file again: the same id comes back, and the other document is the one that was in front.
    act(() => useDocuments.getState().setActive(2));
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT)]);
    await act(() => viewer().open());
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(REPORT);
    // Its view is what it was, not a new one at 100 % on page 1.
    expect(useView.getState().byDoc[1]).toMatchObject({ zoom: 1.1, pageIndex: 4 });
    // Nothing else changed: asking again for the one that is in front keeps the image on screen.
    useViewer.setState({ image: { url: 'blob:same', widthPt: 612, heightPt: 792 } });
    await act(() => viewer().open());
    expect(viewer().image?.url).toBe('blob:same');
  });

  it('closing the active document brings back its neighbour, and the neighbour is rendered afresh', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), opened(OTHER)]);
    await act(() => viewer().open());
    useViewer.setState({ image: { url: 'blob:other', widthPt: 612, heightPt: 792 } });
    act(() => viewer().close());
    expect(activeDocument()).toEqual(REPORT);
    expect(viewer().image).toBeNull();
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(2);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1']);
    act(() => viewer().close());
    expect(activeDocument()).toBeNull();
    expect(documentsApi.closeDocument).toHaveBeenLastCalledWith(1);
  });

  it('a file that failed to open shows its error in the banner, and the ones that opened are still opened', async () => {
    const notAPdf = { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false } as const;
    const tooMany = {
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'documents', limit: 32 },
    } as const;
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), openFailed(notAPdf), openFailed(tooMany)]);
    await act(() => viewer().open());
    expect(activeDocument()).toEqual(REPORT);
    // One banner for the whole batch: the first failure.
    expect(useUi.getState().banner).toEqual(notAPdf);
  });

  it('a close that fails is not an error for the user', async () => {
    await act(() => viewer().open());
    documentsApi.closeDocument.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
    await act(() => viewer().open());
    expect(useUi.getState().banner).toBeNull();
    expect(activeDocument()).toEqual(OTHER);
  });
});

describe('the actions', () => {
  it('do nothing without a document', () => {
    viewer().zoomStep(1);
    viewer().setZoom(2);
    viewer().resetZoom();
    viewer().zoomByWheel(-100, 0);
    viewer().goToPage(3);
    viewer().nextPage();
    viewer().previousPage();
    viewer().close();
    expect(useView.getState().byDoc).toEqual({});
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });

  describe('with a document', () => {
    beforeEach(async () => {
      await act(() => viewer().open());
    });

    it('zoomStep goes to the next preset in and out and stops at the ends', () => {
      viewer().zoomStep(1);
      expect(zoomOf()).toBe(1.1);
      viewer().zoomStep(-1);
      viewer().zoomStep(-1);
      expect(zoomOf()).toBe(0.9);
      viewer().setZoom(MAX_ZOOM);
      viewer().zoomStep(1);
      expect(zoomOf()).toBe(MAX_ZOOM);
      viewer().setZoom(MIN_ZOOM);
      viewer().zoomStep(-1);
      expect(zoomOf()).toBe(MIN_ZOOM);
    });

    it('setZoom clamps to the range, and a zoom that is not a number gives 100 %', () => {
      viewer().setZoom(100);
      expect(zoomOf()).toBe(MAX_ZOOM);
      viewer().setZoom(0);
      expect(zoomOf()).toBe(MIN_ZOOM);
      viewer().setZoom(Number.NaN);
      expect(zoomOf()).toBe(DEFAULT_ZOOM);
    });

    it('resetZoom is 100 %, and the wheel zooms in when it turns up and out when it turns down', () => {
      viewer().setZoom(2);
      viewer().resetZoom();
      expect(zoomOf()).toBe(DEFAULT_ZOOM);
      viewer().zoomByWheel(-100, 0);
      expect(zoomOf()).toBeGreaterThan(DEFAULT_ZOOM);
      viewer().resetZoom();
      viewer().zoomByWheel(100, 0);
      expect(zoomOf()).toBeLessThan(DEFAULT_ZOOM);
    });

    it('goToPage stays inside the document', () => {
      viewer().goToPage(4);
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(4);
      viewer().goToPage(99);
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(9);
      viewer().goToPage(-5);
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
    });

    it('act on the document that is open now, not on the one that was open when they were handed out', async () => {
      const { zoomStep, setZoom, goToPage } = viewer();
      documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
      await act(() => viewer().open());
      setZoom(2);
      zoomStep(1);
      goToPage(2);
      expect(useView.getState().byDoc[2]).toEqual({ zoom: 2.5, pageIndex: 2, pageCount: 3 });
    });

    it('nextPage and previousPage turn one page and stop at the first and the last', () => {
      viewer().nextPage();
      viewer().nextPage();
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(2);
      viewer().previousPage();
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(1);
      viewer().previousPage();
      viewer().previousPage();
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
      viewer().goToPage(9);
      viewer().nextPage();
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(9);
    });

    it('close forgets the document and its page, and tells the backend; a failing close is no error for the user', async () => {
      useViewer.setState({ image: { url: 'blob:old', widthPt: 612, heightPt: 792 }, rendering: true });
      documentsApi.closeDocument.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
      viewer().close();
      expect(activeDocument()).toBeNull();
      expect(viewer().image).toBeNull();
      expect(viewer().rendering).toBe(false);
      expect(useView.getState().byDoc).toEqual({});
      expect(documentsApi.closeDocument).toHaveBeenCalledWith(1);
      await act(async () => undefined);
      expect(useUi.getState().banner).toBeNull();
      // Nothing is open any more: a second close does nothing, and does not tell the backend again.
      viewer().close();
      expect(documentsApi.closeDocument).toHaveBeenCalledTimes(1);
    });

    describe('fitting the page to the canvas', () => {
      // A US Letter page, 612 x 792 pt, which is 816 x 1056 CSS px at 100 %.
      const LETTER = { url: 'blob:page', widthPt: 612, heightPt: 792 };

      it('fitWidth fills the canvas width less the scrollbar allowance, fitPage fits the whole page', () => {
        useViewer.setState({ image: LETTER });
        viewer().setViewport({ width: 816 + 16, height: 5000 });
        viewer().fitWidth();
        expect(zoomOf()).toBeCloseTo(1);
        viewer().setViewport({ width: 5000, height: 528 });
        viewer().fitPage();
        expect(zoomOf()).toBeCloseTo(0.5);
        viewer().setViewport({ width: 1632 + 16, height: 5000 });
        viewer().fitWidth();
        expect(zoomOf()).toBeCloseTo(2);
      });

      it('does nothing until the canvas has reported its size and a page has been shown', () => {
        viewer().setZoom(2);
        viewer().fitWidth();
        viewer().fitPage();
        expect(zoomOf()).toBe(2);
        viewer().setViewport({ width: 800, height: 600 });
        viewer().fitWidth();
        viewer().fitPage();
        expect(zoomOf()).toBe(2);
      });

      it('does nothing without a document', async () => {
        useViewer.setState({ image: LETTER });
        viewer().setViewport({ width: 800, height: 600 });
        viewer().close();
        useViewer.setState({ image: LETTER });
        viewer().fitWidth();
        viewer().fitPage();
        expect(useView.getState().byDoc).toEqual({});
      });

      it('setViewport keeps the same object while the size is the same, so nothing wakes for it', () => {
        viewer().setViewport({ width: 800, height: 600 });
        const first = viewer().viewport;
        viewer().setViewport({ width: 800, height: 600 });
        expect(viewer().viewport).toBe(first);
        viewer().setViewport({ width: 801, height: 600 });
        expect(viewer().viewport).toEqual({ width: 801, height: 600 });
      });
    });

    it('are the same functions after every change of state, so memoized children can hold them', () => {
      const before = viewer();
      viewer().zoomStep(1);
      viewer().goToPage(3);
      useViewer.setState({ rendering: true, image: { url: 'blob:x', widthPt: 1, heightPt: 1 } });
      const after = viewer();
      for (const name of [
        'open',
        'close',
        'zoomStep',
        'setZoom',
        'resetZoom',
        'fitWidth',
        'fitPage',
        'zoomByWheel',
        'goToPage',
        'nextPage',
        'previousPage',
        'setViewport',
      ] as const) {
        expect(after[name], name).toBe(before[name]);
      }
    });
  });

  it('selectDocId is the id of the open document and null without one', async () => {
    expect(selectActiveId(useDocuments.getState())).toBeNull();
    await act(() => viewer().open());
    expect(selectActiveId(useDocuments.getState())).toBe(1);
  });
});

describe('the render pipeline (useViewerEffects)', () => {
  /** The document is open and the hook is mounted; the clock is fake from here on. */
  async function mount() {
    await act(() => viewer().open());
    vi.useFakeTimers();
    return renderHook(() => useViewerEffects());
  }
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('renders the current page 80 ms after the document, page or zoom changed, at the scale of the zoom', async () => {
    await mount();
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
    await advance(79);
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
    await advance(1);
    expect(documentsApi.renderPage).toHaveBeenCalledTimes(1);
    // 100 % is 96 CSS px per inch, 4/3 device px per point, at a device pixel ratio of 1.
    expect(documentsApi.renderPage).toHaveBeenLastCalledWith(1, 0, expect.closeTo(4 / 3, 5));
    expect(viewer().image).toEqual({ url: 'blob:page-1', widthPt: 816 / (4 / 3), heightPt: 1056 / (4 / 3) });
    expect(viewer().rendering).toBe(false);
  });

  it('coalesces a burst of zoom steps into one render', async () => {
    await mount();
    await advance(80);
    documentsApi.renderPage.mockClear();
    for (let step = 0; step < 5; step += 1) {
      act(() => viewer().zoomStep(1));
      await advance(20);
    }
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
    await advance(80);
    expect(documentsApi.renderPage).toHaveBeenCalledTimes(1);
    expect(documentsApi.renderPage).toHaveBeenLastCalledWith(1, 0, expect.closeTo((4 / 3) * 2, 5));
  });

  it('is "rendering" from the request to the answer', async () => {
    let answer: (value: ReturnType<typeof page>) => void = () => undefined;
    await mount();
    documentsApi.renderPage.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await advance(80);
    expect(viewer().rendering).toBe(true);
    await act(async () => answer(page()));
    expect(viewer().rendering).toBe(false);
    expect(viewer().image).not.toBeNull();
  });

  describe('a cancelled render', () => {
    /** A render that is in flight and never answers on its own. */
    async function inFlight() {
      const mounted = await mount();
      let answer: (value: ReturnType<typeof page>) => void = () => undefined;
      documentsApi.renderPage.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      await advance(80);
      expect(viewer().rendering).toBe(true);
      return { ...mounted, answer: (value: ReturnType<typeof page>) => answer(value) };
    }

    it('stops being "rendering" when the document goes and nothing replaces it', async () => {
      const { answer } = await inFlight();
      act(() => useDocuments.getState().remove(REPORT.id));
      expect(viewer().rendering).toBe(false);
      // Its answer comes late and is dropped; it does not set the flag again.
      await act(async () => answer(page()));
      expect(viewer().rendering).toBe(false);
      expect(viewer().image).toBeNull();
    });

    it('stops being "rendering" when the document has no pages to render', async () => {
      await inFlight();
      documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 5, pageCount: 0, displayName: 'Empty.pdf' })]);
      await act(() => viewer().open());
      expect(activeDocument()?.id).toBe(5);
      expect(viewer().rendering).toBe(false);
    });

    it('stops being "rendering" when the hook goes', async () => {
      const { unmount } = await inFlight();
      unmount();
      expect(viewer().rendering).toBe(false);
    });

    it('stays "rendering" while a newer render has been asked for, until that one answers', async () => {
      const { answer } = await inFlight();
      const seen: boolean[] = [];
      const stop = useViewer.subscribe((state) => seen.push(state.rendering));
      act(() => viewer().goToPage(5));
      expect(viewer().rendering).toBe(true);
      await advance(79);
      expect(viewer().rendering).toBe(true);
      // The cancelled one answers: no effect on the flag, the newer render is still in flight.
      await act(async () => answer(page()));
      expect(viewer().rendering).toBe(true);
      await advance(1);
      await act(async () => answer(page()));
      expect(viewer().rendering).toBe(false);
      stop();
      // No blink in between: the flag was never cleared before the end of the newer render.
      expect(seen.indexOf(false)).toBe(seen.length - 1);
    });

    /** `renderPage` calls that stay open until the test answers or refuses them, one entry per call. */
    function pending() {
      const calls: Array<{ resolve: (value: ReturnType<typeof page>) => void; reject: (reason: unknown) => void }> = [];
      documentsApi.renderPage.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            calls.push({ resolve, reject });
          }),
      );
      return calls;
    }

    it('shows no error and does not touch the flag when the cancelled render fails late', async () => {
      await mount();
      const calls = pending();
      await advance(80);
      expect(viewer().rendering).toBe(true);
      act(() => viewer().close());
      expect(viewer().rendering).toBe(false);

      await act(async () => calls[0]?.reject({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true }));

      expect(useUi.getState().banner).toBeNull();
      expect(viewer().rendering).toBe(false);
    });

    it('never starts, and never shows "rendering", when the document is closed within the 80 ms before it', async () => {
      await mount();
      const seen: boolean[] = [];
      const stop = useViewer.subscribe((state) => seen.push(state.rendering));
      await advance(79);
      act(() => viewer().close());
      await advance(500);
      stop();
      expect(documentsApi.renderPage).not.toHaveBeenCalled();
      expect(seen).not.toContain(true);
      expect(viewer().rendering).toBe(false);
    });

    it('drops the answer of the document that was replaced, and stays "rendering" for the new one', async () => {
      await mount();
      const calls = pending();
      await advance(80);
      documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
      await act(() => viewer().open());
      expect(activeDocument()?.id).toBe(OTHER.id);
      expect(viewer().rendering).toBe(true);
      await advance(80);
      expect(calls).toHaveLength(2);
      expect(documentsApi.renderPage).toHaveBeenLastCalledWith(OTHER.id, 0, expect.any(Number));

      await act(async () => calls[0]?.resolve(page()));
      expect(viewer().image).toBeNull();
      expect(viewer().rendering).toBe(true);
      expect(URL.createObjectURL).not.toHaveBeenCalled();

      await act(async () => calls[1]?.resolve(page()));
      expect(viewer().image).not.toBeNull();
      expect(viewer().rendering).toBe(false);
    });

    it('makes no image when its answer comes after the hook has gone', async () => {
      const { unmount } = await mount();
      const calls = pending();
      await advance(80);
      unmount();

      await act(async () => calls[0]?.resolve(page()));

      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(viewer().image).toBeNull();
      expect(viewer().rendering).toBe(false);
    });
  });

  it('drops an answer that arrives after the page or zoom has changed again', async () => {
    const answers: Array<(value: ReturnType<typeof page>) => void> = [];
    await mount();
    documentsApi.renderPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    await advance(80);
    act(() => viewer().goToPage(5));
    await advance(80);
    expect(answers).toHaveLength(2);
    // The first answer is late and stale; the second one is the one that counts.
    await act(async () => answers[0]?.(page()));
    expect(viewer().image).toBeNull();
    await act(async () => answers[1]?.(page()));
    expect(viewer().image).toEqual({ url: 'blob:page-1', widthPt: 816 / (4 / 3), heightPt: 1056 / (4 / 3) });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('uses the scale the backend says it rendered at: a frame it had to make smaller still shows at the zoom', async () => {
    await mount();
    documentsApi.renderPage.mockResolvedValue(page(2));
    act(() => viewer().setZoom(4));
    await advance(80);
    expect(viewer().image).toMatchObject({ widthPt: 816 / 2, heightPt: 1056 / 2 });
  });

  it('frees the page image when the next one has replaced it, and when the hook goes', async () => {
    const { unmount } = await mount();
    await advance(80);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    act(() => viewer().zoomStep(1));
    await advance(80);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:page-1');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:page-2');
  });

  it('shows a failed render as the banner, and the next good one clears it', async () => {
    await mount();
    documentsApi.renderPage.mockRejectedValueOnce({
      code: 'engine_timeout',
      key: 'error.engine_timeout',
      retryable: true,
    });
    await advance(80);
    expect(useUi.getState().banner).toMatchObject({ code: 'engine_timeout', retryable: true });
    expect(viewer().rendering).toBe(false);
    act(() => viewer().zoomStep(1));
    await advance(80);
    expect(useUi.getState().banner).toBeNull();
  });

  it('a good render does not clear an error about opening a file: only an error of a render is its to clear', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([
      opened(REPORT),
      openFailed({ code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false }),
    ]);
    await mount();
    expect(useUi.getState().banner).toMatchObject({ code: 'not_a_pdf' });
    await advance(80);
    expect(documentsApi.renderPage).toHaveBeenCalledTimes(1);
    expect(viewer().image).not.toBeNull();
    // The page is there, the error about the other file still is too.
    expect(useUi.getState().banner).toMatchObject({ code: 'not_a_pdf' });
  });

  it('a render error that another error replaced is not cleared by a good render either', async () => {
    await mount();
    documentsApi.renderPage.mockRejectedValueOnce({
      code: 'engine_timeout',
      key: 'error.engine_timeout',
      retryable: true,
    });
    await advance(80);
    const other = { code: 'io_not_found', key: 'error.io_not_found', retryable: false } as const;
    act(() => useUi.getState().showBanner(other));
    act(() => viewer().zoomStep(1));
    await advance(80);
    expect(useUi.getState().banner).toEqual(other);
  });

  it('renders nothing for a document without pages, and nothing without a document', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 5, pageCount: 0, displayName: 'Empty.pdf' })]);
    await act(() => viewer().open());
    vi.useFakeTimers();
    renderHook(() => useViewerEffects());
    await advance(500);
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
    act(() => useDocuments.getState().remove(5));
    await advance(500);
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
  });

  it('binds no keys of its own: they belong to the command registry (src/actions)', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    await mount();
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toEqual([]);
    add.mockRestore();
  });
});
