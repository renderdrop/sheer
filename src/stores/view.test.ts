// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import { NO_VIEW, useDocView, useDocViewValue, useView } from './view';

const reset = () => useView.setState({ byDoc: {} });

beforeEach(reset);
afterEach(reset);

describe('the view store', () => {
  it('a new document starts at 100 % on its first page', () => {
    useView.getState().open(7, 12);
    expect(useView.getState().byDoc[7]).toEqual({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 12 });
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
    expect(useView.getState().byDoc[1]).toEqual({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 10 });
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

describe('useDocView', () => {
  it('is NO_VIEW without a document or for one that is not registered, and follows the store', () => {
    const none = renderHook(() => useDocView(null));
    expect(none.result.current).toBe(NO_VIEW);
    const unknown = renderHook(() => useDocView(5));
    expect(unknown.result.current).toBe(NO_VIEW);

    const known = renderHook(() => useDocView(5));
    act(() => useView.getState().open(5, 8));
    expect(known.result.current).toEqual({ zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 8 });
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
