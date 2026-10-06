// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { back, forward, jumpTo, pushView } from './actions';
import { useMarks } from './marks';
import { useHistoryStore } from './store';

const viewer = vi.hoisted(() => ({
  state: { viewport: { width: 800, height: 600 }, goToPoint: vi.fn(), goToPage: vi.fn() },
}));
vi.mock('../viewer/useViewer', () => ({ useViewer: { getState: () => viewer.state } }));

beforeEach(() => {
  resetDocuments();
  useHistoryStore.setState({ byDoc: {} });
  useMarks.setState({ mark: null });
  usePages.setState({ slotsByDoc: {}, byDoc: {} });
  usePages.getState().set(
    1,
    Array.from({ length: 10 }, () => [612, 792] as [number, number]),
  );
  useDocuments.getState().add({ id: 1, pageCount: 10, displayName: 'a.pdf' });
  useView.setState({ byDoc: {} });
  useView.getState().open(1, 10);
  useView.getState().setZoom(1, 1.5);
  viewer.state.goToPoint.mockReset();
});

describe('history actions', () => {
  it('jumpTo pushes the view it leaves, scrolls to the point and goes back to the exact view', () => {
    useView.getState().setPage(1, 2);
    jumpTo(1, { pageId: 7, rect: { x: 10, y: 100, w: 50, h: 12 } }, { pageId: 2, rect: { x: 1, y: 2, w: 3, h: 4 } });
    expect(viewer.state.goToPoint).toHaveBeenCalledWith(7, 100);
    const [saved] = useHistoryStore.getState().byDoc[1]?.back ?? [];
    expect(saved).toMatchObject({ pageId: 0, zoom: 1.5, fit: 'none', origin: { pageId: 2 } });

    useView.getState().setZoom(1, 3);
    back(1);
    const view = useView.getState().byDoc[1];
    expect(view?.zoom).toBe(1.5);
    expect(view?.anchor).toMatchObject({ page: 0, yPt: 0 });
    expect(useMarks.getState().mark).toMatchObject({ kind: 'origin', pageId: 2 });
    expect(useHistoryStore.getState().byDoc[1]?.forward).toHaveLength(1);

    forward(1);
    expect(useHistoryStore.getState().byDoc[1]?.back).toHaveLength(1);
  });

  it('a page target scrolls without a band', () => {
    jumpTo(1, { pageId: 4 });
    expect(useMarks.getState().mark).toBeNull();
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(4);
  });

  it('ignores a target page that is gone', () => {
    jumpTo(1, { pageId: 99 });
    expect(useHistoryStore.getState().byDoc[1]).toBeUndefined();
  });

  it('pushView saves the view for outline rows and the page field', () => {
    pushView(1);
    expect(useHistoryStore.getState().byDoc[1]?.back).toHaveLength(1);
  });

  it('restores a fit mode through setFit', () => {
    useView.getState().setFit(1, 'width', 1.2);
    pushView(1);
    useView.getState().setZoom(1, 2);
    back(1);
    expect(useView.getState().byDoc[1]).toMatchObject({ fit: 'width', zoom: 1.2 });
  });
});
