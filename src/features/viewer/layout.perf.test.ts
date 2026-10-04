import { describe, expect, it } from 'vitest';

import type { PageSize } from '../../api/render';
import { thumbnailMetricsFor, ThumbnailLayout } from '../thumbnails/layout';
import { MAX_MOUNTED_PAGES, PageLayout, buildMetrics, pageWindow } from './layout';

/** Mixed page sizes so nothing can be computed in closed form. */
const sizesOf = (count: number): PageSize[] =>
  Array.from({ length: count }, (_, i): PageSize => (i % 7 === 0 ? [842, 595] : [612, 792 + (i % 5)]));

describe('layout performance budget (500 and 5 000 pages)', () => {
  for (const count of [500, 5000]) {
    it(`builds metrics and scrolls ${count} pages in O(visible) per frame`, () => {
      const sizes = sizesOf(count);
      const started = performance.now();
      const metrics = buildMetrics(sizes, 'continuous');
      const layout = new PageLayout(metrics, { zoom: 1, gap: 12, viewport: { width: 1000, height: 800 }, current: 0 });
      const buildMs = performance.now() - started;
      expect(buildMs).toBeLessThan(50);

      const frames = 2000;
      const scrollStarted = performance.now();
      let mounted = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        const top = (frame / frames) * Math.max(0, layout.height - 800);
        const window = pageWindow(layout, top, 800);
        mounted = Math.max(mounted, window.visible.length + window.near.length);
        layout.currentPageAt(top, 800);
      }
      const perFrameMs = (performance.now() - scrollStarted) / frames;
      expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_PAGES);
      // The budget for the whole frame is 16 ms; layout may use a small fraction of it, independent of the page count.
      expect(perFrameMs).toBeLessThan(0.5);
    });
  }

  it('thumbnail list lookups for 5 000 pages stay O(log n) and visible-sized', () => {
    const spacing = { pad: 4, labelGap: 4, labelHeight: 16, gap: 4 };
    const layout = new ThumbnailLayout(thumbnailMetricsFor(sizesOf(5000)), 140, spacing);
    const started = performance.now();
    let widest = 0;
    for (let at = 0; at < 2000; at += 1) {
      const top = (at / 2000) * layout.height;
      const range = layout.itemsIn(top, top + 800);
      if (range !== null) widest = Math.max(widest, range.last - range.first + 1);
    }
    expect(performance.now() - started).toBeLessThan(200);
    expect(widest).toBeLessThan(60);
  });
});
