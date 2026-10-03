// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CSS_PX_PER_PT } from '../../lib/zoom';
import { setup } from '../../test/render';
import { useView } from '../../stores/view';
import { useViewer } from '../viewer/useViewer';
import { ViewerCanvas } from '../viewer/ViewerCanvas';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { ViewerStatusBar } from './ViewerStatusBar';

const documentsApi = vi.hoisted(() => ({ openDocumentDialog: vi.fn(), closeDocument: vi.fn() }));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => renderApi);

const VIEWPORT = { width: 900, height: 700 };
const STRIDE = 792 * CSS_PX_PER_PT + 16;
const NBSP = String.fromCharCode(0xa0);

const region = () => screen.getByRole('region', { name: 'Document' });
const scrollTo = (top: number) => {
  region().scrollTop = top;
  fireEvent.scroll(region());
};
/** What the page button of the status bar says: "3 / 500". */
const pageButton = () => screen.getByRole('button', { name: /Go to page/ }).textContent;

beforeEach(() => {
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  renderApi.renderPage.mockReset().mockImplementation(() => new Promise(() => undefined));
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  resetViewer();
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  resetViewer();
});

function mount(pageCount: number, viewport = VIEWPORT) {
  showDocument({ id: 1, pageCount, displayName: 'Book.pdf' }, { viewport });
  return setup(
    <>
      <ViewerCanvas />
      <ViewerStatusBar />
    </>,
  );
}

describe('the page in the status bar follows the scroll position of the canvas', () => {
  it('"1 / 500" at the top, the page most of the viewport is on while scrolling, and the last page at the end', () => {
    mount(500);
    expect(pageButton()).toBe('1 / 500');
    scrollTo(41 * STRIDE);
    expect(pageButton()).toBe('42 / 500');
    // Less than half of page 42 is left in the viewport: the next page is the one most of it is on.
    scrollTo(41 * STRIDE + 792 * CSS_PX_PER_PT - 100);
    expect(pageButton()).toBe('43 / 500');
    const content = region().firstElementChild as HTMLElement;
    scrollTo(Number.parseFloat(content.style.height) - VIEWPORT.height);
    expect(pageButton()).toBe('500 / 500');
    scrollTo(0);
    expect(pageButton()).toBe('1 / 500');
  });

  it('is "1 / 1" for a document of one page', () => {
    mount(1);
    scrollTo(250);
    expect(pageButton()).toBe('1 / 1');
  });

  it('follows a jump to a page, and the zoom readout follows the zoom', () => {
    mount(500);
    act(() => useViewer.getState().goToPage(120));
    expect(pageButton()).toBe('121 / 500');
    act(() => useViewer.getState().zoomStep(1));
    expect(screen.getByRole('button', { name: /Zoom level/ }).textContent).toBe(`108${NBSP}%`);
    // The page stays what the scroll position says after the zoom: the point in the middle of the viewport is kept.
    expect(pageButton()).toBe('121 / 500');
  });

  it('in a spread it is the left page of the pair shown, also for the lone last page of an odd count', () => {
    mount(5, { width: 2400, height: 1200 });
    act(() => useViewer.getState().setScrollMode('spread'));
    expect(pageButton()).toBe('1 / 5');
    act(() => useViewer.getState().nextPage());
    expect(pageButton()).toBe('3 / 5');
    act(() => useViewer.getState().nextPage());
    expect(pageButton()).toBe('5 / 5');
    act(() => useViewer.getState().nextPage());
    expect(pageButton()).toBe('5 / 5');
  });
});

describe('the zoom readout of a freshly opened document', () => {
  it('shows no zoom until the opening zoom is committed, then exactly the committed zoom', () => {
    // Fit width of a 900 px viewport is below 100 %, so the committed zoom differs from the default.
    const readout = () => screen.getByRole('button', { name: /Zoom level/ }).textContent;
    mount(3);
    act(() => useView.getState().open(1, 3, true));
    expect(readout()).toBe('–');
    act(() => useView.getState().setFit(1, 'width', 0.93));
    expect(readout()).toBe(`93${NBSP}%`);
    act(() => useView.getState().settleOpening(1));
    expect(readout()).toBe(`93${NBSP}%`);
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
