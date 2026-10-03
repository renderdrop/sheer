// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { useView } from '../../stores/view';
import { resetViewer, showDocument } from './viewer.testutil';
import { useViewer } from './useViewer';

const anchor = () => useView.getState().byDoc[1]?.anchor ?? null;
const page = () => useView.getState().byDoc[1]?.pageIndex;

beforeEach(() => {
  resetViewer();
  showDocument({ id: 1, pageCount: 5, displayName: 'a.pdf' }, { viewport: { width: 800, height: 600 } });
});

describe('goToPoint', () => {
  it('lands a point of the page below the top padding', () => {
    useViewer.getState().goToPoint(2, 100);
    expect(page()).toBe(2);
    expect(anchor()?.yPt).toBe(100);
    expect(anchor()?.viewY).toBeGreaterThan(0);
  });

  it('clamps a y beyond the page to the page height', () => {
    useViewer.getState().goToPoint(1, 1e9);
    expect(anchor()?.yPt).toBe(792);
  });

  it('goes to the top of the page for a non-finite or negative y', () => {
    for (const y of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      useViewer.getState().goToPoint(3, y);
      expect(page()).toBe(3);
      expect(anchor()?.yPt).toBe(0);
    }
  });

  it('still changes the page when the canvas has not been measured', () => {
    useViewer.setState({ viewport: null });
    useViewer.getState().goToPoint(4, 50);
    expect(page()).toBe(4);
    expect(anchor()).toBeNull();
  });

  it('clamps the page index', () => {
    useViewer.getState().goToPoint(99, 10);
    expect(page()).toBe(4);
  });
});
