// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { GESTURE_IDLE_MS, createZoomMotion, nextStop, snapZoom, velocityOf, type ZoomMotionHost } from './zoomMotion';

describe('nextStop', () => {
  it('walks the presets and the fit zooms as one list', () => {
    expect(nextStop(1, 1, [])).toBe(1.1);
    expect(nextStop(1, 1, [1.05])).toBe(1.05);
    expect(nextStop(1.05, 1, [1.05])).toBe(1.1);
    expect(nextStop(1, -1, [0.95])).toBe(0.95);
  });

  it('stops at the limits and ignores a fit zoom outside them', () => {
    expect(nextStop(MAX_ZOOM, 1, [9])).toBe(MAX_ZOOM);
    expect(nextStop(MIN_ZOOM, -1, [])).toBe(MIN_ZOOM);
  });
});

describe('snapZoom', () => {
  const stops = [
    { zoom: 1, fit: 'none' as const },
    { zoom: 1.4, fit: 'width' as const },
    { zoom: 0.8, fit: 'page' as const },
  ];

  it('takes each target within +-3 % and keeps the fit mode of it', () => {
    expect(snapZoom(1.02, stops)).toEqual({ zoom: 1, fit: 'none' });
    expect(snapZoom(0.98, stops)).toEqual({ zoom: 1, fit: 'none' });
    expect(snapZoom(1.4 * 1.03, stops)).toEqual({ zoom: 1.4, fit: 'width' });
    expect(snapZoom(0.8 * 0.97, stops)).toEqual({ zoom: 0.8, fit: 'page' });
  });

  it('keeps a zoom outside the bands exactly', () => {
    expect(snapZoom(1.031, stops)).toEqual({ zoom: 1.031, fit: 'none' });
    expect(snapZoom(0.969, stops)).toEqual({ zoom: 0.969, fit: 'none' });
    expect(snapZoom(1.2, stops)).toEqual({ zoom: 1.2, fit: 'none' });
    expect(snapZoom(0.8 * 1.04, stops)).toEqual({ zoom: 0.8 * 1.04, fit: 'none' });
  });
});

describe('velocityOf', () => {
  it('is the slope of the log zoom over the last 100 ms, per second', () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([[0, 0]])).toBe(0);
    expect(
      velocityOf([
        [0, 0],
        [50, 0.1],
        [100, 0.2],
      ]),
    ).toBeCloseTo(2);
    // Older samples than the window do not count.
    expect(
      velocityOf([
        [0, 0],
        [400, 5],
        [450, 5.1],
        [500, 5.2],
      ]),
    ).toBeCloseTo(2);
  });
});

describe('the zoom motion', () => {
  let content: HTMLDivElement;
  let zoom: number;
  let commits: [number, string, { x: number; y: number } | undefined][];
  let reduced: boolean;
  let host: ZoomMotionHost;

  beforeEach(() => {
    vi.useFakeTimers();
    content = document.createElement('div');
    zoom = 1;
    commits = [];
    reduced = true;
    host = {
      zoom: () => zoom,
      fitStops: () => ({ width: 1.4, page: 0.8 }),
      commit: (next, fit, focus) => {
        commits.push([next, fit, focus]);
        zoom = next;
      },
      content: () => content,
      scroll: () => ({ left: 10, top: 100 }),
      center: () => ({ x: 400, y: 300 }),
      reduced: () => reduced,
    };
  });

  afterEach(() => vi.useRealTimers());

  it('commits at once when there is nothing to scale', () => {
    const motion = createZoomMotion({ ...host, content: () => null });
    motion.gesture(1.5, { x: 1, y: 2 });
    expect(commits).toEqual([[1.5, 'none', { x: 1, y: 2 }]]);
  });

  it('scales the content around the pointer while a gesture runs, and commits once, snapped, when it stops', () => {
    const motion = createZoomMotion(host);
    motion.gesture(1.01, { x: 200, y: 50 });
    motion.gesture(1.015, { x: 200, y: 50 });
    // The origin is a point of the content: the pointer plus the scroll position.
    expect(content.style.transformOrigin).toBe('210px 150px');
    expect(content.style.transform).toBe(`scale(${1.01 * 1.015})`);
    expect(content.style.willChange).toBe('transform');
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(GESTURE_IDLE_MS);
    // 1.025 is within the band of 100 %: the zoom snaps to it. Reduced motion commits at once.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.[0]).toBe(1);
    expect(commits[0]?.[1]).toBe('none');
    expect(commits[0]?.[2]).toEqual({ x: 200, y: 50 });
    motion.settle();
    expect(content.style.transform).toBe('');
    expect(content.style.willChange).toBe('');
    expect(motion.active()).toBe(false);
  });

  it('clamps a gesture to the zoom range', () => {
    const motion = createZoomMotion(host);
    motion.gesture(100, { x: 0, y: 0 });
    expect(content.style.transform).toBe(`scale(${MAX_ZOOM})`);
  });

  it('commits a fit step as a fit mode', () => {
    const motion = createZoomMotion(host);
    motion.gesture(1.42, { x: 0, y: 0 });
    vi.advanceTimersByTime(GESTURE_IDLE_MS);
    expect(commits[0]?.slice(0, 2)).toEqual([1.4, 'width']);
  });

  it('steps through the presets and the fit zooms, around the viewport centre by default, at once with reduced motion', () => {
    const motion = createZoomMotion(host);
    motion.step(1);
    expect(commits[0]).toEqual([1.1, 'none', { x: 400, y: 300 }]);
    motion.settle();
    zoom = 1.25;
    motion.step(1);
    expect(commits[1]?.slice(0, 2)).toEqual([1.4, 'width']);
  });

  it('goes to a zoom (fit commands) and commits it with its fit mode', () => {
    const motion = createZoomMotion(host);
    motion.animateTo(0.8, 'page', 'slow');
    expect(commits[0]?.slice(0, 2)).toEqual([0.8, 'page']);
  });

  it('snaps a slider value at gesture end: inside the band to the target, outside kept exactly', () => {
    const motion = createZoomMotion(host);
    motion.snapTo(1.025);
    expect(commits[0]?.slice(0, 2)).toEqual([1, 'none']);
    motion.settle();
    motion.snapTo(0.79);
    expect(commits[1]?.slice(0, 2)).toEqual([0.8, 'page']);
    motion.settle();
    motion.snapTo(1.2);
    expect(commits[2]?.slice(0, 2)).toEqual([1.2, 'none']);
  });

  it('settle is safe when nothing runs', () => {
    expect(() => createZoomMotion(host).settle()).not.toThrow();
  });
});

describe('zoom steps past a fit step', () => {
  it('opened at 100 %: in lands on fit width, in again goes on to the next stop; a layout in between does not cut it short', () => {
    let zoom = 1;
    const content = document.createElement('div');
    const motion = createZoomMotion({
      zoom: () => zoom,
      fitStops: () => ({ width: 1.08, page: 0.6 }),
      commit: (next) => {
        zoom = next;
      },
      content: () => content,
      scroll: () => ({ left: 0, top: 0 }),
      center: () => ({ x: 0, y: 0 }),
      reduced: () => true,
    });
    motion.step(1);
    expect(zoom).toBe(1.08);
    motion.settle();
    motion.step(1);
    expect(zoom).toBe(1.1);
  });

  it('settle while a zoom runs (not committing) leaves it alone', () => {
    const content = document.createElement('div');
    const motion = createZoomMotion({
      zoom: () => 1,
      fitStops: () => ({ width: null, page: null }),
      commit: () => undefined,
      content: () => content,
      scroll: () => ({ left: 0, top: 0 }),
      center: () => ({ x: 0, y: 0 }),
      reduced: () => true,
    });
    motion.gesture(1.2, { x: 0, y: 0 });
    motion.settle();
    expect(motion.active()).toBe(true);
  });
});

describe('cancel', () => {
  it('stops a gesture in flight: no commit, no transform, nothing running', () => {
    vi.useFakeTimers();
    try {
      const content = document.createElement('div');
      const commit = vi.fn();
      const motion = createZoomMotion({
        zoom: () => 1,
        fitStops: () => ({ width: null, page: null }),
        commit,
        content: () => content,
        scroll: () => ({ left: 0, top: 0 }),
        center: () => ({ x: 0, y: 0 }),
        reduced: () => true,
      });
      motion.gesture(1.2, { x: 5, y: 5 });
      expect(content.style.transform).not.toBe('');
      motion.cancel();
      vi.advanceTimersByTime(GESTURE_IDLE_MS * 5);
      expect(commit).not.toHaveBeenCalled();
      expect(content.style.transform).toBe('');
      expect(content.style.willChange).toBe('');
      expect(motion.active()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
