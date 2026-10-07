// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { fileRotationOf, hasFileRotation } from '../viewer/fileRotation';
import {
  CACHE_BUDGET_UNITS,
  MAX_FAILED_PAGES,
  clearTextCache,
  dropDocumentText,
  loadLayer,
  peekLayer,
  usePageText,
} from './cache';

const textApi = vi.hoisted(() => ({ getTextLayer: vi.fn() }));
vi.mock('../../api/text', () => textApi);

const layerOf = (text: string) => ({ text, boxes: new Float32Array(4 * text.length), truncated: false });

beforeEach(() => {
  clearTextCache();
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 5, displayName: 'a.pdf' });
  textApi.getTextLayer
    .mockReset()
    .mockImplementation((_doc: number, page: number) => Promise.resolve(layerOf(`page ${page}`)));
});

afterEach(() => {
  resetDocuments();
});

describe('the text layer cache', () => {
  it('reads a page once, also when it is asked for twice at the same time', async () => {
    const [a, b] = await Promise.all([loadLayer(1, 2), loadLayer(1, 2)]);
    expect(a).toBe(b);
    expect(await loadLayer(1, 2)).toBe(a);
    expect(textApi.getTextLayer).toHaveBeenCalledTimes(1);
    expect(peekLayer(1, 2)).toBe(a);
    expect(peekLayer(1, 3)).toBeUndefined();
  });

  it('forgets the text of one document, failures included, so the next read asks again', async () => {
    useDocuments.getState().add({ id: 2, pageCount: 1, displayName: 'b.pdf' });
    await loadLayer(1, 0);
    await loadLayer(2, 0);
    textApi.getTextLayer.mockRejectedValueOnce(new Error('no'));
    await loadLayer(1, 1);
    dropDocumentText(1);
    expect(peekLayer(1, 0)).toBeUndefined();
    expect(peekLayer(2, 0)).toBeDefined();
    expect(await loadLayer(1, 1)).not.toBeNull();
  });

  it('a page that cannot be read is null, and not an error', async () => {
    textApi.getTextLayer.mockRejectedValueOnce(new Error('no'));
    expect(await loadLayer(1, 0)).toBeNull();
  });

  it('keeps the amount of text bounded: the layer used longest ago goes first', async () => {
    const big = 'x'.repeat(CACHE_BUDGET_UNITS / 2 + 1);
    textApi.getTextLayer.mockImplementation(() => Promise.resolve(layerOf(big)));
    await loadLayer(1, 0);
    await loadLayer(1, 1);
    expect(peekLayer(1, 0)).toBeUndefined();
    expect(peekLayer(1, 1)).toBeDefined();
  });

  it('forgets the layers of a closed document, and does not keep one that arrives after the close', async () => {
    await loadLayer(1, 0);
    act(() => useDocuments.getState().remove(1));
    expect(peekLayer(1, 0)).toBeUndefined();
    await loadLayer(1, 1);
    expect(peekLayer(1, 1)).toBeUndefined();
  });
});

describe('what is kept besides the layers', () => {
  it('records the rotation of a page when its layer arrives, and forgets it with the document', async () => {
    textApi.getTextLayer.mockResolvedValueOnce({ ...layerOf('turned'), rotation: 270 });
    expect(hasFileRotation(1, 0)).toBe(false);
    await loadLayer(1, 0);
    expect(hasFileRotation(1, 0)).toBe(true);
    expect(fileRotationOf(1, 0)).toBe(270);
    act(() => useDocuments.getState().remove(1));
    expect(hasFileRotation(1, 0)).toBe(false);
  });

  it('remembers at most MAX_FAILED_PAGES failed pages: the oldest is asked again', async () => {
    useDocuments.getState().add({ id: 2, pageCount: 5000, displayName: 'b.pdf' });
    textApi.getTextLayer.mockRejectedValue(new Error('no'));
    for (let page = 0; page < MAX_FAILED_PAGES + 3; page += 1) await loadLayer(2, page);
    const { result: oldest } = renderHook(() => usePageText(2, 0, false));
    const { result: newest } = renderHook(() => usePageText(2, MAX_FAILED_PAGES + 2, false));
    expect(oldest.current.status).toBe('idle');
    expect(newest.current.status).toBe('failed');
  });

  it('drops the failures and listeners of a closed document', async () => {
    textApi.getTextLayer.mockRejectedValue(new Error('no'));
    await loadLayer(1, 0);
    const { result, unmount } = renderHook(() => usePageText(1, 0, false));
    expect(result.current.status).toBe('failed');
    act(() => useDocuments.getState().remove(1));
    unmount();
    useDocuments.getState().add({ id: 1, pageCount: 5, displayName: 'a.pdf' });
    const again = renderHook(() => usePageText(1, 0, false));
    expect(again.result.current.status).toBe('idle');
  });
});

describe('usePageText', () => {
  it('fetches only once the page is enabled, and then reports the layer', async () => {
    const { result, rerender } = renderHook(({ enabled }) => usePageText(1, 0, enabled), {
      initialProps: { enabled: false },
    });
    expect(result.current.status).toBe('idle');
    expect(textApi.getTextLayer).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.layer?.text).toBe('page 0');
    expect(textApi.getTextLayer).toHaveBeenCalledTimes(1);
  });

  it('reports a failure, and starts over for another page', async () => {
    textApi.getTextLayer.mockRejectedValueOnce(new Error('no'));
    const { result, rerender } = renderHook(({ page }) => usePageText(1, page, true), { initialProps: { page: 0 } });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    rerender({ page: 1 });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.layer?.text).toBe('page 1');
  });
});
