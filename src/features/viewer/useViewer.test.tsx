// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { renderCache } from '../../engine/renderCache';
import { renderScheduler } from '../../engine/renderScheduler';
import { CSS_PX_PER_PT, DEFAULT_ZOOM, FIT_SCROLLBAR_PX, MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { activeDocument, openFailed, opened } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { registerScrollSource } from './scrollBridge';
import { resetViewer, sizes } from './viewer.testutil';
import { useViewer, useViewerEffects } from './useViewer';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));
const renderApi = vi.hoisted(() => ({
  renderPage: vi.fn(),
  setViewport: vi.fn(),
  getPageSizes: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => renderApi);

const uiInitial = useUi.getState();

const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };
const OTHER: DocumentInfo = { id: 2, pageCount: 3, displayName: 'Other.pdf' };

function reset() {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  renderApi.renderPage.mockReset().mockImplementation(() => new Promise(() => undefined));
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes
    .mockReset()
    .mockImplementation((docId: number) =>
      Promise.resolve(sizes(docId === OTHER.id ? OTHER.pageCount : REPORT.pageCount)),
    );
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  reset();
});

const viewer = () => useViewer.getState();
const zoomOf = (id = REPORT.id) => useView.getState().byDoc[id]?.zoom;
const viewOf = (id = REPORT.id) => useView.getState().byDoc[id];

describe('opening a document', () => {
  it('registers it with a view at 100 % on the first page, continuous, and asks for the size of its pages', async () => {
    await act(() => viewer().open());
    expect(activeDocument()).toEqual(REPORT);
    expect(viewOf()).toEqual({
      zoom: DEFAULT_ZOOM,
      fit: 'none',
      scrollMode: 'continuous',
      pageIndex: 0,
      pageCount: 10,
      anchor: null,
      opening: true,
    });
    expect(viewer().opening).toBe(false);
    expect(renderApi.getPageSizes).toHaveBeenCalledWith(1);
    expect(usePages.getState().byDoc[1]).toEqual(sizes(10));
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
    documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
    await act(() => viewer().open());
    expect(activeDocument()).toEqual(OTHER);
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1', '2']);
    expect(zoomOf(1)).toBe(1.1);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    expect(Object.keys(usePages.getState().byDoc)).toEqual(['1', '2']);
  });

  it('several documents from one dialog are all opened and the last one is shown', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), opened(OTHER)]);
    await act(() => viewer().open());
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(OTHER);
    expect(viewOf(1)).toMatchObject({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 10 });
    expect(viewOf(2)).toMatchObject({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 3 });
  });

  it('a document that is open already (the backend answers with the id it has) is brought forward, not added twice', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), opened(OTHER)]);
    await act(() => viewer().open());
    act(() => useDocuments.getState().setActive(1));
    act(() => viewer().zoomStep(1));
    act(() => viewer().goToPage(4));
    // Opening the file again: the same id comes back, and the other document is the one that was in front.
    act(() => useDocuments.getState().setActive(2));
    renderApi.getPageSizes.mockClear();
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT)]);
    await act(() => viewer().open());
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(REPORT);
    // Its view is what it was, not a new one at 100 % on page 1, and its pages are not measured again.
    expect(viewOf(1)).toMatchObject({ zoom: 1.1, pageIndex: 4 });
    expect(renderApi.getPageSizes).not.toHaveBeenCalled();
  });

  it('closing the active document brings back its neighbour', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT), opened(OTHER)]);
    await act(() => viewer().open());
    act(() => viewer().close());
    expect(activeDocument()).toEqual(REPORT);
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(2);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1']);
    expect(Object.keys(usePages.getState().byDoc)).toEqual(['1']);
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
    act(() => viewer().close());
    await act(async () => undefined);
    expect(useUi.getState().banner).toBeNull();
  });

  it('shows the error when the sizes of the pages cannot be had, and keeps the document', async () => {
    renderApi.getPageSizes.mockRejectedValue({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true });
    await act(() => viewer().open());
    expect(useUi.getState().banner).toMatchObject({ code: 'engine_timeout' });
    expect(activeDocument()).toEqual(REPORT);
    expect(usePages.getState().byDoc).toEqual({});
    // The opening zoom is never decided without sizes: the readouts must not stay on the dash.
    expect(viewOf(1)?.opening).toBe(false);
  });

  it('forgets the sizes that arrive after the document was closed', async () => {
    let answer: (value: unknown) => void = () => undefined;
    renderApi.getPageSizes.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(() => viewer().open());
    act(() => viewer().close());
    await act(async () => answer(sizes(10)));
    expect(usePages.getState().byDoc).toEqual({});
    // And an error that arrives late is not shown either.
    let fail: (reason: unknown) => void = () => undefined;
    renderApi.getPageSizes.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    documentsApi.openDocumentDialog.mockResolvedValue([opened(REPORT)]);
    await act(() => viewer().open());
    act(() => viewer().close());
    await act(async () => fail({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true }));
    expect(useUi.getState().banner).toBeNull();
  });
});

describe('closing', () => {
  it('drops the document’s images and what is in flight for it, and its viewport', async () => {
    await act(() => viewer().open());
    const dropped = vi.spyOn(renderScheduler, 'dropDocument');
    act(() => viewer().close());
    expect(dropped).toHaveBeenCalledWith(1);
    expect(renderCache.isDropped(1)).toBe(true);
    dropped.mockRestore();
  });
});

describe('the actions', () => {
  it('do nothing without a document', () => {
    viewer().zoomStep(1);
    viewer().setZoom(2);
    viewer().resetZoom();
    viewer().zoomByWheel(-100, 0);
    viewer().zoomBy(2);
    viewer().fitWidth();
    viewer().fitPage();
    viewer().setScrollMode('single');
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

    it('zoomBy multiplies the zoom (a pinch), within the range, and a factor that is not one does nothing', () => {
      viewer().zoomBy(1.5);
      expect(zoomOf()).toBeCloseTo(1.5);
      viewer().zoomBy(0.5);
      expect(zoomOf()).toBeCloseTo(0.75);
      viewer().zoomBy(1e9);
      expect(zoomOf()).toBe(MAX_ZOOM);
      for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
        viewer().setZoom(1);
        viewer().zoomBy(bad);
        expect(zoomOf(), `${bad}`).toBe(1);
      }
    });

    it('a zoom that changes nothing is not a request to scroll: the view is the same object', () => {
      viewer().setViewport({ width: 900, height: 700 });
      const before = viewOf();
      viewer().setZoom(DEFAULT_ZOOM);
      viewer().resetZoom();
      viewer().zoomBy(1);
      viewer().zoomStep(-1);
      viewer().zoomStep(1);
      viewer().zoomStep(-1);
      expect(zoomOf()).toBe(0.9);
      expect(before?.zoom).toBe(1);
      viewer().setZoom(MAX_ZOOM);
      const atMax = viewOf();
      viewer().zoomStep(1);
      viewer().zoomBy(2);
      expect(viewOf()).toBe(atMax);
    });

    it('goToPage stays inside the document', () => {
      viewer().goToPage(4);
      expect(viewOf()?.pageIndex).toBe(4);
      viewer().goToPage(99);
      expect(viewOf()?.pageIndex).toBe(9);
      viewer().goToPage(-5);
      expect(viewOf()?.pageIndex).toBe(0);
      viewer().goToPage(Number.NaN);
      expect(viewOf()?.pageIndex).toBe(0);
    });

    it('act on the document that is open now, not on the one that was open when they were handed out', async () => {
      const { zoomStep, setZoom, goToPage } = viewer();
      documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
      await act(() => viewer().open());
      setZoom(2);
      zoomStep(1);
      goToPage(2);
      expect(viewOf(2)).toMatchObject({ zoom: 2.5, pageIndex: 2, pageCount: 3 });
    });

    it('nextPage and previousPage turn one page and stop at the first and the last', () => {
      viewer().nextPage();
      viewer().nextPage();
      expect(viewOf()?.pageIndex).toBe(2);
      viewer().previousPage();
      expect(viewOf()?.pageIndex).toBe(1);
      viewer().previousPage();
      viewer().previousPage();
      expect(viewOf()?.pageIndex).toBe(0);
      viewer().goToPage(9);
      viewer().nextPage();
      expect(viewOf()?.pageIndex).toBe(9);
    });

    it('turning at the last page does not snap it back to its top: nothing is asked of the canvas', () => {
      viewer().setViewport({ width: 900, height: 700 });
      viewer().goToPage(9);
      useView.getState().consumeAnchor(1);
      viewer().nextPage();
      expect(viewOf()?.anchor).toBeNull();
      viewer().goToPage(0);
      useView.getState().consumeAnchor(1);
      viewer().previousPage();
      expect(viewOf()?.anchor).toBeNull();
    });

    it('close forgets the document and its pages, and tells the backend; a failing close is no error for the user', async () => {
      useViewer.setState({ rendering: true });
      documentsApi.closeDocument.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
      viewer().close();
      expect(activeDocument()).toBeNull();
      expect(useView.getState().byDoc).toEqual({});
      expect(usePages.getState().byDoc).toEqual({});
      expect(documentsApi.closeDocument).toHaveBeenCalledWith(1);
      await act(async () => undefined);
      expect(useUi.getState().banner).toBeNull();
      // Nothing is open any more: a second close does nothing, and does not tell the backend again.
      viewer().close();
      expect(documentsApi.closeDocument).toHaveBeenCalledTimes(1);
    });

    it('are the same functions after every change of state, so memoized children can hold them', () => {
      const before = viewer();
      viewer().zoomStep(1);
      viewer().goToPage(3);
      viewer().setScrollMode('single');
      useViewer.setState({ rendering: true });
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
        'zoomBy',
        'setScrollMode',
        'goToPage',
        'nextPage',
        'previousPage',
        'setViewport',
      ] as const) {
        expect(after[name], name).toBe(before[name]);
      }
    });

    describe('fitting the page to the canvas', () => {
      // A US Letter page, 612 x 792 pt, which is 816 x 1056 CSS px at 100 %.
      it('fitWidth fills the canvas width less the scrollbar allowance, fitPage fits the whole page', () => {
        viewer().setViewport({ width: 816 + FIT_SCROLLBAR_PX, height: 5000 });
        viewer().fitWidth();
        expect(zoomOf()).toBeCloseTo(1);
        viewer().setViewport({ width: 5000, height: 528 });
        viewer().fitPage();
        expect(zoomOf()).toBeCloseTo(0.5);
        viewer().setViewport({ width: 1632 + FIT_SCROLLBAR_PX, height: 5000 });
        viewer().fitWidth();
        expect(zoomOf()).toBeCloseTo(2);
      });

      it('fits the page that is the current one, which may be a landscape page', () => {
        usePages.getState().set(1, [...sizes(4), [792, 612], ...sizes(5)]);
        viewer().setViewport({ width: 816 + FIT_SCROLLBAR_PX, height: 5000 });
        viewer().goToPage(4);
        viewer().fitWidth();
        expect(zoomOf()).toBeCloseTo(816 / (792 * CSS_PX_PER_PT));
      });

      it('is a mode, not a one-time zoom: it follows the size of the window until the user zooms by hand', () => {
        viewer().setViewport({ width: 816 + FIT_SCROLLBAR_PX, height: 5000 });
        viewer().fitWidth();
        expect(viewOf()).toMatchObject({ fit: 'width' });
        viewer().setViewport({ width: 1632 + FIT_SCROLLBAR_PX, height: 5000 });
        expect(zoomOf()).toBeCloseTo(2);
        viewer().setViewport({ width: 408 + FIT_SCROLLBAR_PX, height: 5000 });
        expect(zoomOf()).toBeCloseTo(0.5);
        expect(viewOf()?.fit).toBe('width');
        // A change of height does not move a width fit.
        const before = viewOf();
        viewer().setViewport({ width: 408 + FIT_SCROLLBAR_PX, height: 300 });
        expect(viewOf()).toBe(before);
        // Fit page follows both.
        viewer().fitPage();
        viewer().setViewport({ width: 5000, height: 528 });
        expect(zoomOf()).toBeCloseTo(0.5);
        viewer().setViewport({ width: 5000, height: 1056 });
        expect(zoomOf()).toBeCloseTo(1);
        // And a zoom of any other kind ends it.
        viewer().zoomStep(1);
        expect(viewOf()?.fit).toBe('none');
        viewer().setViewport({ width: 5000, height: 528 });
        expect(zoomOf()).toBe(1.1);
      });

      it('100 % and the zoom menu end a fit as well', () => {
        viewer().setViewport({ width: 816 + FIT_SCROLLBAR_PX, height: 5000 });
        viewer().fitWidth();
        viewer().resetZoom();
        expect(viewOf()).toMatchObject({ fit: 'none', zoom: 1 });
        viewer().fitWidth();
        viewer().setZoom(1.25);
        expect(viewOf()).toMatchObject({ fit: 'none', zoom: 1.25 });
        viewer().fitWidth();
        viewer().zoomByWheel(-50, 0);
        expect(viewOf()?.fit).toBe('none');
      });

      it('does nothing until the canvas has reported its size', () => {
        viewer().setZoom(2);
        viewer().fitWidth();
        viewer().fitPage();
        expect(zoomOf()).toBe(2);
        expect(viewOf()?.fit).toBe('none');
      });

      it('does nothing without a document', () => {
        viewer().setViewport({ width: 800, height: 600 });
        viewer().close();
        viewer().fitWidth();
        viewer().fitPage();
        expect(useView.getState().byDoc).toEqual({});
      });

      it('fit page shows the page from its top, fit width keeps what is in the middle of the viewport', () => {
        viewer().setViewport({ width: 900, height: 700 });
        viewer().goToPage(3);
        useView.getState().consumeAnchor(1);
        viewer().fitPage();
        expect(viewOf()?.anchor).toMatchObject({ page: 3, yPt: 0, viewY: 0 });
        useView.getState().consumeAnchor(1);
        viewer().fitWidth();
        expect(viewOf()?.anchor).toMatchObject({ viewX: 450, viewY: 350 });
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

    describe('around a point', () => {
      it('a zoom without a focus is around the middle of the viewport; with one, around that point', () => {
        viewer().setViewport({ width: 900, height: 700 });
        viewer().zoomStep(1);
        expect(viewOf()?.anchor).toMatchObject({ viewX: 450, viewY: 350 });
        useView.getState().consumeAnchor(1);
        viewer().zoomByWheel(-100, 0, { x: 100, y: 200 });
        expect(viewOf()?.anchor).toMatchObject({ viewX: 100, viewY: 200 });
        useView.getState().consumeAnchor(1);
        viewer().zoomBy(1.1, { x: 5, y: 6 });
        expect(viewOf()?.anchor).toMatchObject({ viewX: 5, viewY: 6 });
      });

      it('reads where the canvas is scrolled to from the canvas', () => {
        viewer().setViewport({ width: 900, height: 700 });
        const stop = registerScrollSource(() => ({ left: 0, top: 3 * (792 * CSS_PX_PER_PT + 16) }));
        viewer().zoomStep(1);
        stop();
        // The middle of the viewport is 350 px into the fourth page's slot.
        expect(viewOf()?.anchor?.page).toBe(3);
        expect(viewOf()?.anchor?.yPt).toBeCloseTo(350 / CSS_PX_PER_PT);
      });

      it('builds on a request to scroll that the canvas has not carried out yet, not on where it still is', () => {
        viewer().setViewport({ width: 900, height: 700 });
        const stop = registerScrollSource(() => ({ left: 0, top: 0 }));
        viewer().goToPage(5);
        // The canvas has not scrolled yet (it still reports 0), and a zoom comes in: the point it keeps is the one on page 5.
        viewer().zoomStep(1);
        stop();
        expect(viewOf()?.anchor?.page).toBe(5);
      });

      it('has no anchor until the canvas has a size', () => {
        viewer().zoomStep(1);
        expect(viewOf()).toMatchObject({ zoom: 1.1, anchor: null });
      });
    });

    describe('the scroll modes', () => {
      it('changes how pages are laid out and keeps the page, the zoom and the other documents', async () => {
        documentsApi.openDocumentDialog.mockResolvedValue([opened(OTHER)]);
        await act(() => viewer().open());
        act(() => useDocuments.getState().setActive(1));
        viewer().goToPage(4);
        viewer().setScrollMode('spread');
        expect(viewOf()).toMatchObject({ scrollMode: 'spread', pageIndex: 4, zoom: 1 });
        expect(viewOf(2)?.scrollMode).toBe('continuous');
        viewer().setScrollMode('single');
        expect(viewOf()?.scrollMode).toBe('single');
        viewer().setScrollMode('continuous');
        expect(viewOf()).toMatchObject({ scrollMode: 'continuous', pageIndex: 4 });
      });

      it('asks the canvas to show the top of the current page in the new layout', () => {
        viewer().setViewport({ width: 900, height: 700 });
        viewer().goToPage(6);
        useView.getState().consumeAnchor(1);
        viewer().setScrollMode('single');
        expect(viewOf()?.anchor).toMatchObject({ page: 6, yPt: 0, viewY: 0 });
      });

      it('does nothing when the mode is the one that is on', () => {
        viewer().setViewport({ width: 900, height: 700 });
        const before = viewOf();
        viewer().setScrollMode('continuous');
        expect(viewOf()).toBe(before);
      });

      it('makes a fit again for the new mode: a spread is two pages wide', () => {
        viewer().setViewport({ width: 2 * 816 + 16 + FIT_SCROLLBAR_PX, height: 5000 });
        viewer().fitWidth();
        expect(zoomOf()).toBeCloseTo(2 + 0, 1);
        viewer().setScrollMode('spread');
        expect(viewOf()).toMatchObject({ fit: 'width', scrollMode: 'spread' });
        expect(zoomOf()).toBeCloseTo(1);
      });

      it('turns a spread two pages at a time and a single page one', () => {
        viewer().setViewport({ width: 2400, height: 1200 });
        viewer().setScrollMode('spread');
        viewer().nextPage();
        expect(viewOf()?.pageIndex).toBe(2);
        viewer().nextPage();
        viewer().nextPage();
        expect(viewOf()?.pageIndex).toBe(6);
        viewer().previousPage();
        expect(viewOf()?.pageIndex).toBe(4);
        viewer().setScrollMode('single');
        viewer().nextPage();
        expect(viewOf()?.pageIndex).toBe(5);
        // The last pair is pages 8 and 9: from there there is nowhere to go.
        viewer().goToPage(9);
        viewer().setScrollMode('spread');
        viewer().nextPage();
        expect(viewOf()?.pageIndex).toBe(9);
      });
    });
  });

  it('selectDocId is the id of the open document and null without one', async () => {
    expect(selectActiveId(useDocuments.getState())).toBeNull();
    await act(() => viewer().open());
    expect(selectActiveId(useDocuments.getState())).toBe(1);
  });
});

describe('"rendering" (useViewerEffects)', () => {
  /** The scheduler has `count` renders in flight: the stand-ins never answer, the test settles them. */
  function startRenders(count: number) {
    const settle: Array<() => void> = [];
    renderApi.renderPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(() => resolve({ data: new Uint8Array([1]), width: 10, height: 10 }));
        }),
    );
    for (let page = 0; page < count; page += 1) {
      void renderScheduler.request({ docId: 1, page, rev: 0, bucket: 2 }, 'visible');
    }
    return settle;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    renderCache.admit(1);
  });

  it('says so once a render has lasted a moment, and stops when the last one is over', async () => {
    renderHook(() => useViewerEffects());
    const settle = startRenders(2);
    expect(viewer().rendering).toBe(false);
    act(() => vi.advanceTimersByTime(249));
    expect(viewer().rendering).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(viewer().rendering).toBe(true);
    await act(async () => settle[0]?.());
    expect(viewer().rendering).toBe(true);
    await act(async () => settle[1]?.());
    expect(viewer().rendering).toBe(false);
  });

  it('does not blink for renders that are over in a moment', async () => {
    renderHook(() => useViewerEffects());
    const seen: boolean[] = [];
    const stop = useViewer.subscribe((state) => seen.push(state.rendering));
    const settle = startRenders(1);
    act(() => vi.advanceTimersByTime(100));
    await act(async () => settle[0]?.());
    act(() => vi.advanceTimersByTime(1000));
    stop();
    expect(seen).not.toContain(true);
    expect(viewer().rendering).toBe(false);
  });

  it('starts out right when it mounts while a render is already going', () => {
    startRenders(1);
    renderHook(() => useViewerEffects());
    act(() => vi.advanceTimersByTime(250));
    expect(viewer().rendering).toBe(true);
  });

  it('stops being "rendering" when the hook goes', () => {
    const { unmount } = renderHook(() => useViewerEffects());
    startRenders(1);
    act(() => vi.advanceTimersByTime(250));
    expect(viewer().rendering).toBe(true);
    unmount();
    expect(viewer().rendering).toBe(false);
    // And it does not come back for a render that is still going.
    act(() => vi.advanceTimersByTime(1000));
    expect(viewer().rendering).toBe(false);
  });

  it('binds no keys of its own: they belong to the command registry (src/actions)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    renderHook(() => useViewerEffects());
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toEqual([]);
    add.mockRestore();
  });
});
