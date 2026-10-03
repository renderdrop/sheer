// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScrollAnchor } from '../features/viewer/layout';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import { NO_VIEW, useDocView, useDocViewValue, useView } from './view';

const reset = () => useView.setState({ byDoc: {} });

beforeEach(reset);
afterEach(reset);

describe('the view store', () => {
  it('a new document starts at 100 % on its first page, scrolling continuously, with nothing to scroll to', () => {
    useView.getState().open(7, 12);
    expect(useView.getState().byDoc[7]).toEqual({
      zoom: DEFAULT_ZOOM,
      fit: 'none',
      scrollMode: 'continuous',
      pageIndex: 0,
      pageCount: 12,
      anchor: null,
      opening: false,
    });
  });

  it('a page count that is negative or fractional becomes a whole count of at least 0', () => {
    const { open } = useView.getState();
    open(1, -4);
    open(2, 2.9);
    expect(useView.getState().byDoc[1]?.pageCount).toBe(0);
    expect(useView.getState().byDoc[2]?.pageCount).toBe(2);
  });

  it('opening a document that is already registered starts its view over at 100 % on page 1', () => {
    const { open, setZoom, setPage } = useView.getState();
    open(1, 10);
    setZoom(1, 2);
    setPage(1, 7);
    open(1, 10);
    expect(useView.getState().byDoc[1]).toEqual({
      zoom: DEFAULT_ZOOM,
      fit: 'none',
      scrollMode: 'continuous',
      pageIndex: 0,
      pageCount: 10,
      anchor: null,
      opening: false,
    });
  });

  it('the last page of a one-page document is page 0, and an infinite page changes nothing', () => {
    const { open, setPage } = useView.getState();
    open(1, 1);
    setPage(1, 5);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
    open(2, 9);
    setPage(2, 4);
    setPage(2, Number.POSITIVE_INFINITY);
    expect(useView.getState().byDoc[2]?.pageIndex).toBe(4);
  });

  it('keeps a view per document', () => {
    const { open, setZoom, setPage } = useView.getState();
    open(1, 10);
    open(2, 3);
    setZoom(1, 2);
    setPage(1, 4);
    setPage(2, 2);
    expect(useView.getState().byDoc[1]).toMatchObject({ zoom: 2, pageIndex: 4 });
    expect(useView.getState().byDoc[2]).toMatchObject({ zoom: DEFAULT_ZOOM, pageIndex: 2 });
  });

  it('clamps the zoom to the zoom range', () => {
    const { open, setZoom } = useView.getState();
    open(1, 1);
    setZoom(1, 100);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MAX_ZOOM);
    setZoom(1, 0.001);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MIN_ZOOM);
    setZoom(1, Number.NaN);
    expect(useView.getState().byDoc[1]?.zoom).toBe(DEFAULT_ZOOM);
  });

  it('clamps the page to the document', () => {
    const { open, setPage } = useView.getState();
    open(1, 5);
    setPage(1, 99);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(4);
    setPage(1, -3);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
    setPage(1, 2.9);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(2);
    setPage(1, Number.NaN);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(2);
  });

  it('a document without pages keeps page 0', () => {
    const { open, setPage } = useView.getState();
    open(1, 0);
    setPage(1, 3);
    expect(useView.getState().byDoc[1]).toMatchObject({ pageIndex: 0, pageCount: 0 });
  });

  it('ignores an unknown document and forgets a closed one', () => {
    const { open, close, setZoom, setPage } = useView.getState();
    setZoom(9, 2);
    setPage(9, 2);
    expect(useView.getState().byDoc).toEqual({});
    open(1, 2);
    open(2, 2);
    close(1);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['2']);
    close(1); // closing twice is fine
    expect(Object.keys(useView.getState().byDoc)).toEqual(['2']);
  });

  it('an unchanged value does not notify subscribers', () => {
    useView.getState().open(1, 3);
    let calls = 0;
    const stop = useView.subscribe(() => (calls += 1));
    useView.getState().setZoom(1, DEFAULT_ZOOM);
    useView.getState().setPage(1, 0);
    expect(calls).toBe(0);
    useView.getState().setZoom(1, 2);
    expect(calls).toBe(1);
    stop();
  });
});

const ANCHOR: ScrollAnchor = { page: 3, xPt: 10, yPt: 20, viewX: 100, viewY: 200 };

describe('fit, scroll mode and the anchor', () => {
  it('a zoom the user chose ends a fit, and carries the anchor the canvas keeps in place', () => {
    const { open, setFit, setZoom } = useView.getState();
    open(1, 10);
    setFit(1, 'width', 1.37, ANCHOR);
    expect(useView.getState().byDoc[1]).toMatchObject({ zoom: 1.37, fit: 'width', anchor: ANCHOR });
    setFit(1, 'page', 0.8);
    expect(useView.getState().byDoc[1]).toMatchObject({ zoom: 0.8, fit: 'page', anchor: null });
    setZoom(1, 1.5, ANCHOR);
    expect(useView.getState().byDoc[1]).toMatchObject({ zoom: 1.5, fit: 'none', anchor: ANCHOR });
  });

  it('a fit is clamped to the zoom range like any zoom', () => {
    const { open, setFit } = useView.getState();
    open(1, 1);
    setFit(1, 'width', 50);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MAX_ZOOM);
    setFit(1, 'page', 0.001);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MIN_ZOOM);
  });

  it('a jump to a page sets the page and the anchor, and the anchor is consumed once the canvas has scrolled', () => {
    const { open, setPage, consumeAnchor } = useView.getState();
    open(1, 10);
    setPage(1, 6, ANCHOR);
    expect(useView.getState().byDoc[1]).toMatchObject({ pageIndex: 6, anchor: ANCHOR });
    consumeAnchor(1);
    expect(useView.getState().byDoc[1]).toMatchObject({ pageIndex: 6, anchor: null });
    // Consuming nothing changes nothing.
    let calls = 0;
    const stop = useView.subscribe(() => (calls += 1));
    consumeAnchor(1);
    consumeAnchor(99);
    expect(calls).toBe(0);
    stop();
  });

  it('the page the canvas reports is not a request to scroll: it leaves the anchor alone', () => {
    const { open, setZoom, reportPage } = useView.getState();
    open(1, 10);
    setZoom(1, 2, ANCHOR);
    reportPage(1, 5);
    expect(useView.getState().byDoc[1]).toMatchObject({ pageIndex: 5, anchor: ANCHOR });
    reportPage(1, 99);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(9);
    reportPage(1, Number.NaN);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(9);
  });

  it('the scroll mode is per document, keeps the page, and may bring a fit up to date with its zoom', () => {
    const { open, setPage, setScrollMode, setFit } = useView.getState();
    open(1, 10);
    open(2, 10);
    setPage(1, 4);
    setScrollMode(1, 'spread', ANCHOR);
    expect(useView.getState().byDoc[1]).toMatchObject({ scrollMode: 'spread', pageIndex: 4, anchor: ANCHOR, zoom: 1 });
    expect(useView.getState().byDoc[2]?.scrollMode).toBe('continuous');
    setFit(1, 'page', 0.9);
    setScrollMode(1, 'single', null, 0.6);
    expect(useView.getState().byDoc[1]).toMatchObject({ scrollMode: 'single', zoom: 0.6, fit: 'page' });
    setScrollMode(1, 'continuous', null, 99);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MAX_ZOOM);
  });

  it('scrolling does not end a fit or change the zoom: the page the canvas reports is only the page', () => {
    const { open, setFit, reportPage } = useView.getState();
    open(1, 10);
    setFit(1, 'width', 1.37);
    for (const page of [1, 4, 9, 3]) reportPage(1, page);
    expect(useView.getState().byDoc[1]).toMatchObject({ fit: 'width', zoom: 1.37, pageIndex: 3 });
  });

  it('the zoom limits are exact and a zoom at a limit is a zoom, not an error', () => {
    const { open, setZoom, setFit } = useView.getState();
    open(1, 3);
    setZoom(1, MAX_ZOOM);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MAX_ZOOM);
    setZoom(1, MAX_ZOOM + 1e-9);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MAX_ZOOM);
    setZoom(1, MIN_ZOOM);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MIN_ZOOM);
    setZoom(1, MIN_ZOOM - 1e-9);
    expect(useView.getState().byDoc[1]?.zoom).toBe(MIN_ZOOM);
    setFit(1, 'page', Number.NEGATIVE_INFINITY);
    expect(useView.getState().byDoc[1]?.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(useView.getState().byDoc[1]?.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('a spread of a single page document keeps page 0, whatever is asked', () => {
    const { open, setScrollMode, setPage, reportPage } = useView.getState();
    open(1, 1);
    setScrollMode(1, 'spread');
    setPage(1, 1);
    reportPage(1, 5);
    expect(useView.getState().byDoc[1]).toMatchObject({ scrollMode: 'spread', pageIndex: 0 });
  });

  it('an unknown document is ignored by all of them', () => {
    const { setFit, setPage, setScrollMode, reportPage, consumeAnchor } = useView.getState();
    setFit(9, 'width', 2);
    setPage(9, 2, ANCHOR);
    setScrollMode(9, 'spread');
    reportPage(9, 1);
    consumeAnchor(9);
    expect(useView.getState().byDoc).toEqual({});
  });
});

describe('useDocView', () => {
  it('is NO_VIEW without a document or for one that is not registered, and follows the store', () => {
    const none = renderHook(() => useDocView(null));
    expect(none.result.current).toBe(NO_VIEW);
    const unknown = renderHook(() => useDocView(5));
    expect(unknown.result.current).toBe(NO_VIEW);

    const known = renderHook(() => useDocView(5));
    act(() => useView.getState().open(5, 8));
    expect(known.result.current).toMatchObject({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 8 });
    act(() => useView.getState().setPage(5, 3));
    expect(known.result.current.pageIndex).toBe(3);
  });
});

describe('useDocViewValue', () => {
  it('re-renders only when the value it selects changes', () => {
    useView.getState().open(5, 10);
    let renders = 0;
    const zoom = renderHook(() => {
      renders += 1;
      return useDocViewValue(5, (view) => view.zoom);
    });
    expect(zoom.result.current).toBe(DEFAULT_ZOOM);
    const first = renders;
    act(() => useView.getState().setPage(5, 4));
    act(() => useView.getState().setPage(5, 7));
    expect(renders).toBe(first);
    act(() => useView.getState().setZoom(5, 2));
    expect(zoom.result.current).toBe(2);
    expect(renders).toBe(first + 1);
  });

  it('a boolean derived from the view flips once at the limit and not on the way to it', () => {
    useView.getState().open(5, 10);
    let renders = 0;
    const atMax = renderHook(() => {
      renders += 1;
      return useDocViewValue(5, (view) => view.zoom >= MAX_ZOOM);
    });
    const first = renders;
    for (const zoom of [1.25, 2, 3, 3.9]) act(() => useView.getState().setZoom(5, zoom));
    expect(renders).toBe(first);
    act(() => useView.getState().setZoom(5, MAX_ZOOM));
    expect(atMax.result.current).toBe(true);
    expect(renders).toBe(first + 1);
  });

  it('is the value of NO_VIEW for no document and for one that is not registered', () => {
    expect(renderHook(() => useDocViewValue(null, (view) => view.zoom)).result.current).toBe(NO_VIEW.zoom);
    expect(renderHook(() => useDocViewValue(99, (view) => view.pageCount)).result.current).toBe(0);
  });
});
