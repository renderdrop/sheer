// @vitest-environment jsdom
import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { selectDocId, useViewer, useViewerEffects } from './useViewer';

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
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue(REPORT);
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
    expect(viewer().doc).toEqual(REPORT);
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
    documentsApi.openDocumentDialog.mockResolvedValue(null);
    await act(() => viewer().open());
    expect(viewer().doc).toBeNull();
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
    expect(viewer().doc).toEqual(REPORT);
    expect(viewer().opening).toBe(false);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });

  it('a second document replaces the first: its view is dropped and the backend is told to close it', async () => {
    await act(() => viewer().open());
    useViewer.setState({ image: { url: 'blob:old', widthPt: 612 } });
    documentsApi.openDocumentDialog.mockResolvedValue(OTHER);
    await act(() => viewer().open());
    expect(viewer().doc).toEqual(OTHER);
    expect(viewer().image).toBeNull();
    expect(Object.keys(useView.getState().byDoc)).toEqual(['2']);
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(1);
  });

  it('a close that fails is not an error for the user', async () => {
    await act(() => viewer().open());
    documentsApi.closeDocument.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    documentsApi.openDocumentDialog.mockResolvedValue(OTHER);
    await act(() => viewer().open());
    expect(useUi.getState().banner).toBeNull();
    expect(viewer().doc).toEqual(OTHER);
  });
});

describe('the actions', () => {
  it('do nothing without a document', () => {
    viewer().zoomStep(1);
    viewer().setZoom(2);
    viewer().resetZoom();
    viewer().zoomByWheel(-100, 0);
    viewer().goToPage(3);
    expect(useView.getState().byDoc).toEqual({});
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
      documentsApi.openDocumentDialog.mockResolvedValue(OTHER);
      await act(() => viewer().open());
      setZoom(2);
      zoomStep(1);
      goToPage(2);
      expect(useView.getState().byDoc[2]).toEqual({ zoom: 2.5, pageIndex: 2, pageCount: 3 });
    });

    it('are the same functions after every change of state, so memoized children can hold them', () => {
      const before = viewer();
      viewer().zoomStep(1);
      viewer().goToPage(3);
      useViewer.setState({ rendering: true, image: { url: 'blob:x', widthPt: 1 } });
      const after = viewer();
      for (const name of ['open', 'zoomStep', 'setZoom', 'resetZoom', 'zoomByWheel', 'goToPage'] as const) {
        expect(after[name], name).toBe(before[name]);
      }
    });
  });

  it('selectDocId is the id of the open document and null without one', async () => {
    expect(selectDocId(viewer())).toBeNull();
    await act(() => viewer().open());
    expect(selectDocId(viewer())).toBe(1);
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
    expect(viewer().image).toEqual({ url: 'blob:page-1', widthPt: 816 / (4 / 3) });
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
    expect(viewer().image).toEqual({ url: 'blob:page-1', widthPt: 816 / (4 / 3) });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('uses the scale the backend says it rendered at: a frame it had to make smaller still shows at the zoom', async () => {
    await mount();
    documentsApi.renderPage.mockResolvedValue(page(2));
    act(() => viewer().setZoom(4));
    await advance(80);
    expect(viewer().image?.widthPt).toBe(816 / 2);
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

  it('renders nothing for a document without pages, and nothing without a document', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue({ id: 5, pageCount: 0, displayName: 'Empty.pdf' });
    await act(() => viewer().open());
    vi.useFakeTimers();
    renderHook(() => useViewerEffects());
    await advance(500);
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
    act(() => useViewer.setState({ doc: null }));
    await advance(500);
    expect(documentsApi.renderPage).not.toHaveBeenCalled();
  });

  describe('the keys', () => {
    it('Ctrl or Cmd with O, plus, equals, minus, underscore and 0 are bound, and nothing else is', async () => {
      await mount();
      const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
      key({ key: '+', ctrlKey: true });
      expect(zoomOf()).toBe(1.1);
      key({ key: '=', metaKey: true });
      expect(zoomOf()).toBe(1.25);
      key({ key: '-', ctrlKey: true });
      key({ key: '_', ctrlKey: true });
      expect(zoomOf()).toBe(1);
      key({ key: '0', ctrlKey: true });
      expect(zoomOf()).toBe(1);
      viewer().setZoom(3);
      key({ key: '0', metaKey: true });
      expect(zoomOf()).toBe(1);
      // Without the modifier, or with another key: nothing.
      key({ key: '+' });
      key({ key: 'z', ctrlKey: true });
      expect(zoomOf()).toBe(1);
      documentsApi.openDocumentDialog.mockClear();
      key({ key: 'o', ctrlKey: true });
      key({ key: 'O', metaKey: true });
      key({ key: 'o' });
      expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    });

    it('the shortcut is taken from the browser (preventDefault), and the listener goes with the hook', async () => {
      const { unmount } = await mount();
      const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      unmount();
      const later = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true });
      window.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);
    });

    it('binds once: a zoom step does not add a listener', async () => {
      const add = vi.spyOn(window, 'addEventListener');
      await mount();
      const bound = add.mock.calls.filter(([type]) => type === 'keydown').length;
      act(() => viewer().zoomStep(1));
      act(() => viewer().goToPage(2));
      expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(bound);
      add.mockRestore();
    });
  });
});
