// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDevicePixelRatio } from './useDevicePixelRatio';

/** A `matchMedia` that remembers each query and its listeners, so a test can say "the ratio changed". */
function fakeMatchMedia() {
  const queries: Array<{ media: string; listeners: Set<() => void> }> = [];
  vi.stubGlobal('matchMedia', (media: string) => {
    const query = { media, listeners: new Set<() => void>() };
    queries.push(query);
    return {
      matches: true,
      media,
      addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
    };
  });
  const live = () => queries.filter((query) => query.listeners.size > 0);
  return { queries, live };
}

afterEach(() => vi.unstubAllGlobals());

describe('useDevicePixelRatio', () => {
  it('is the ratio of the display now', () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    fakeMatchMedia();
    expect(renderHook(() => useDevicePixelRatio()).result.current).toBe(1.5);
  });

  it('falls back to 1 for a ratio that is not a usable number', () => {
    fakeMatchMedia();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      vi.stubGlobal('devicePixelRatio', bad);
      expect(renderHook(() => useDevicePixelRatio()).result.current, `${bad}`).toBe(1);
    }
  });

  it('watches a media query for the ratio it has, and follows a change of it', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const media = fakeMatchMedia();
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(media.live().map((query) => query.media)).toEqual(['(resolution: 1dppx)']);

    // The window moves to a monitor with twice the pixels: the query for 1 stops matching.
    vi.stubGlobal('devicePixelRatio', 2);
    act(() => media.queries[0]?.listeners.forEach((listener) => listener()));
    expect(result.current).toBe(2);
    // The query is made again for the new ratio, so the next move is heard too, and the old one is let go.
    expect(media.live().map((query) => query.media)).toEqual(['(resolution: 2dppx)']);

    vi.stubGlobal('devicePixelRatio', 1.25);
    act(() => media.live()[0]?.listeners.forEach((listener) => listener()));
    expect(result.current).toBe(1.25);
    expect(media.live().map((query) => query.media)).toEqual(['(resolution: 1.25dppx)']);
  });

  it('lets go of its query when the component goes away', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const media = fakeMatchMedia();
    const { unmount } = renderHook(() => useDevicePixelRatio());
    expect(media.live()).toHaveLength(1);
    unmount();
    expect(media.live()).toHaveLength(0);
  });

  it('does not render again when the ratio is heard to change but is the same', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const media = fakeMatchMedia();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useDevicePixelRatio();
    });
    const before = renders;
    act(() => media.queries[0]?.listeners.forEach((listener) => listener()));
    expect(renders).toBe(before);
  });
});
