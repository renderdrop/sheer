// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useView } from '../../stores/view';
import { resetViewer, showDocument } from './viewer.testutil';
import { useViewer } from './useViewer';

vi.mock('../../api/documents', () => ({ openDocumentDialog: vi.fn(), closeDocument: vi.fn() }));
vi.mock('../../api/render', () => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));

const DOC = { id: 1, pageCount: 4, displayName: 'Report.pdf' };

beforeEach(() => {
  resetViewer();
  showDocument(DOC, {
    sizes: Array.from({ length: 4 }, () => [600, 800] as [number, number]),
    viewport: { width: 900, height: 700 },
  });
});
afterEach(() => resetViewer());

const page = () => useView.getState().byDoc[DOC.id]?.pageIndex;

describe('go to page', () => {
  it('goes to a page', () => {
    useViewer.getState().goToPage(2);
    expect(page()).toBe(2);
  });
  it('clamps a page past the end and below the start', () => {
    useViewer.getState().goToPage(99);
    expect(page()).toBe(3);
    useViewer.getState().goToPage(-5);
    expect(page()).toBe(0);
  });
  it('ignores a number that is not one, and truncates a fraction', () => {
    useViewer.getState().goToPage(2);
    useViewer.getState().goToPage(Number.NaN);
    expect(page()).toBe(2);
    useViewer.getState().goToPage(1.9);
    expect(page()).toBe(1);
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
