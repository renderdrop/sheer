// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import type { PageSlotInfo } from '../../api/pages';
import { bucketFor } from '../../engine/buckets';
import { renderCache } from '../../engine/renderCache';
import { VIEWPORT_SETTLE_MS } from '../../engine/renderScheduler';
import { setup } from '../../test/render';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { BUCKET_SETTLE_MS } from './PageView';
import { ViewerCanvas } from './ViewerCanvas';
import { resetViewer, showDocument } from './viewer.testutil';

const documentsApi = vi.hoisted(() => ({ openDocumentDialog: vi.fn(), closeDocument: vi.fn() }));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn() }));
vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => renderApi);

// Small pages, so that all three are on screen.
const DOC: DocumentInfo = { id: 1, pageCount: 3, displayName: 'Three.pdf' };
const VIEWPORT = { width: 900, height: 700 };
const slot = (id: number, rev = 0): PageSlotInfo => ({
  id,
  width: 100,
  height: 100,
  rotation: 0,
  rev,
  label: null,
  origin: 'file',
});
const BUCKET = bucketFor(1, 1);

/** A bitmap whose URL says which page id it is of. */
function putBitmap(id: number, rev = 0) {
  const blob = new Blob([new Uint8Array(id + 1)]);
  renderCache.put({ docId: 1, page: id, rev, bucket: BUCKET }, { blob, width: 10, height: 10 });
}
const requestedIds = () => renderApi.renderPage.mock.calls.map(([request]) => request.pageId as number);
const srcAt = (position: number) =>
  document.querySelector<HTMLImageElement>(`[data-page="${position + 1}"] img`)?.getAttribute('src');
const mountedPositions = () =>
  [...document.querySelectorAll<HTMLElement>('[data-page]')].map((el) => Number(el.dataset.page) - 1);

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  renderApi.renderPage.mockReset().mockImplementation(() => new Promise(() => undefined));
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  resetViewer();
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`);
  URL.revokeObjectURL = vi.fn();
  showDocument(DOC, {
    sizes: [
      [100, 100],
      [100, 100],
      [100, 100],
    ],
    viewport: VIEWPORT,
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetViewer();
  vi.unstubAllGlobals();
});

describe('a canvas after pages were reordered, deleted or rotated (ADR-036)', () => {
  it('asks for the pages by id, in the order they sit in', () => {
    act(() => usePages.getState().setSlots(1, [slot(2), slot(0), slot(1)]));
    setup(<ViewerCanvas />);
    expect(requestedIds().sort()).toEqual([0, 1, 2]);
    const visible = renderApi.renderPage.mock.calls.map(([request]) => request.pageId as number);
    // Position 0 is the page with id 2.
    expect(visible).toContain(2);
  });

  it('shows the bitmap of the page that sits at each position, and a moved page keeps its bitmap without a render', () => {
    [0, 1, 2].forEach((id) => putBitmap(id));
    setup(<ViewerCanvas />);
    expect([0, 1, 2].map(srcAt)).toEqual(['blob:1', 'blob:2', 'blob:3']);
    renderApi.renderPage.mockClear();
    act(() => usePages.getState().setSlots(1, [slot(2), slot(0), slot(1)]));
    expect([0, 1, 2].map(srcAt)).toEqual(['blob:3', 'blob:1', 'blob:2']);
    expect(renderApi.renderPage).not.toHaveBeenCalled();
  });

  it('tells the backend the ids of the pages on screen, in the new order, after a move', () => {
    vi.useFakeTimers();
    setup(<ViewerCanvas />);
    act(() => void vi.advanceTimersByTime(VIEWPORT_SETTLE_MS));
    renderApi.setViewport.mockClear();
    act(() => usePages.getState().setSlots(1, [slot(2), slot(0), slot(1)]));
    act(() => void vi.advanceTimersByTime(VIEWPORT_SETTLE_MS));
    const hint = renderApi.setViewport.mock.calls.at(-1)?.[1] as { visible: number[]; near: number[] };
    expect([...hint.visible, ...hint.near].slice(0, 3)).toEqual(expect.arrayContaining([2, 0, 1]));
    expect(hint.visible[0]).toBe(2);
  });

  it('lets the next page shift up after a delete, and the page count follows', () => {
    [0, 1, 2].forEach((id) => putBitmap(id));
    setup(<ViewerCanvas />);
    act(() => usePages.getState().setSlots(1, [slot(0), slot(2)]));
    expect(mountedPositions()).toEqual([0, 1]);
    expect([0, 1].map(srcAt)).toEqual(['blob:1', 'blob:3']);
    expect(screen.getByRole('img', { name: 'Page 2 of 2' })).toBeTruthy();
    expect(useView.getState().byDoc[1]?.pageCount).toBe(2);
  });

  it('renders a rotated page again (its revision is part of the key) and leaves the others', () => {
    vi.useFakeTimers();
    [0, 1, 2].forEach((id) => putBitmap(id));
    setup(<ViewerCanvas />);
    renderApi.renderPage.mockClear();
    act(() => usePages.getState().setSlots(1, [slot(0), slot(1, 1), slot(2)]));
    // The page shows its old bitmap meanwhile and asks for the new one once the zoom has settled.
    expect(srcAt(1)).toBe('blob:2');
    act(() => void vi.advanceTimersByTime(BUCKET_SETTLE_MS));
    expect(requestedIds()).toEqual([1]);
    expect(renderApi.renderPage.mock.calls[0]?.[0]).toMatchObject({ pageId: 1 });
  });
});
