// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CSS_PX_PER_PT } from '../../lib/zoom';
import { useView } from '../../stores/view';
import { fitZoomFor, type Metrics } from './layout';
import { layoutFor, metricsOfDocument, pageGap } from './model';
import { resetViewer, showDocument } from './viewer.testutil';
import { useViewer } from './useViewer';

vi.mock('../../api/documents', () => ({ openDocumentDialog: vi.fn(), closeDocument: vi.fn() }));
vi.mock('../../api/render', () => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));

const DOC = { id: 1, pageCount: 4, displayName: 'Report.pdf' };
const VIEWPORT = { width: 900, height: 700 };

beforeEach(() => {
  resetViewer();
  showDocument(DOC, {
    sizes: [
      [600, 800],
      [600, 800],
      [600, 800],
      [800, 600],
    ],
    viewport: VIEWPORT,
  });
});

afterEach(() => {
  resetViewer();
});

const view = () => useView.getState().byDoc[DOC.id];

describe('view rotation (DESIGN 3.20)', () => {
  it('turns by quarter turns, clockwise and counter-clockwise, and wraps', () => {
    useViewer.getState().rotateView(90);
    expect(view()?.rotation).toBe(90);
    useViewer.getState().rotateView(90);
    useViewer.getState().rotateView(90);
    useViewer.getState().rotateView(90);
    expect(view()?.rotation).toBe(0);
    useViewer.getState().rotateView(-90);
    expect(view()?.rotation).toBe(270);
  });

  it('resets, and does nothing at rest, for an angle that is not a number or without a document', () => {
    useViewer.getState().rotateView(180);
    useViewer.getState().resetRotation();
    expect(view()?.rotation).toBe(0);
    const before = view();
    useViewer.getState().resetRotation();
    useViewer.getState().rotateView(Number.NaN);
    expect(view()).toBe(before);
    resetViewer();
    expect(() => useViewer.getState().rotateView(90)).not.toThrow();
  });

  it('lays the pages out turned: width and height swap, so the layout is as wide as the tall page was', () => {
    const upright = layoutFor(DOC.id, VIEWPORT)?.box(0);
    useViewer.getState().rotateView(90);
    const turned = layoutFor(DOC.id, VIEWPORT)?.box(0);
    expect(upright?.width).toBeCloseTo(600 * CSS_PX_PER_PT);
    expect(turned?.width).toBeCloseTo(800 * CSS_PX_PER_PT);
    expect(turned?.height).toBeCloseTo(600 * CSS_PX_PER_PT);
    // A half turn keeps the sides.
    useViewer.getState().rotateView(90);
    expect(layoutFor(DOC.id, VIEWPORT)?.box(0)?.width).toBeCloseTo(600 * CSS_PX_PER_PT);
  });

  it('keeps the page the reader is on at the top, and asks the canvas to scroll there', () => {
    useViewer.getState().goToPage(2);
    useView.getState().consumeAnchor(DOC.id);
    useViewer.getState().rotateView(90);
    expect(view()?.pageIndex).toBe(2);
    expect(view()?.anchor).toMatchObject({ page: 2, yPt: 0, viewY: 0 });
  });

  it('makes a fit again for the turned pages', () => {
    useViewer.getState().setViewport({ width: 1000, height: 700 });
    const upright = fitZoomFor(
      'width',
      metricsOfDocument(DOC.id) as Metrics,
      0,
      { width: 1000, height: 700 },
      pageGap(),
    );
    useView.getState().setFit(DOC.id, 'width', upright ?? 1, null);
    useViewer.getState().rotateView(90);
    const after = view()?.zoom ?? 0;
    expect(view()?.fit).toBe('width');
    // Page 0 is 600 wide upright and 800 wide turned: the same width needs a smaller zoom.
    expect(after).toBeLessThan(upright ?? 0);
    expect(after).toBeCloseTo(((upright ?? 0) * 600) / 800, 2);
  });
});
