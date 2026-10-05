// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RenderCache, type CacheEntry } from './renderCache';
import { useLastImage } from './useLastImage';

function setup() {
  const created: string[] = [];
  const revoked: string[] = [];
  const cache = new RenderCache({
    createUrl: () => {
      created.push(`blob:${created.length + 1}`);
      return `blob:${created.length}`;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  const entry = (width: number, height: number): CacheEntry =>
    ({ key: `k${width}x${height}`, blob: new Blob(['x']), width, height, bytes: 1 }) as CacheEntry;
  return { cache, created, revoked, entry };
}

describe('useLastImage', () => {
  it('leases a URL in an effect once the entry is lost and releases it when a live one is back', () => {
    const { cache, created, revoked, entry } = setup();
    const a = entry(100, 200);
    const { result, rerender } = renderHook(({ e }) => useLastImage(cache, e), {
      initialProps: { e: a as CacheEntry | undefined },
    });
    expect(result.current).toBeUndefined();
    rerender({ e: undefined });
    expect(result.current?.src).toBe('blob:1');
    expect(created).toEqual(['blob:1']);
    rerender({ e: a });
    expect(result.current).toBeUndefined();
    expect(revoked).toEqual(['blob:1']);
  });

  it('releases the lease when the page goes', () => {
    const { cache, revoked, entry } = setup();
    const { rerender, unmount } = renderHook(({ e }) => useLastImage(cache, e), {
      initialProps: { e: entry(100, 200) as CacheEntry | undefined },
    });
    rerender({ e: undefined });
    unmount();
    expect(revoked).toEqual(['blob:1']);
  });

  it('does not keep an image of another shape (turned page): it would be stretched', () => {
    const { cache, created, entry } = setup();
    const { result, rerender } = renderHook(({ e, a }) => useLastImage(cache, e, a), {
      initialProps: { e: entry(100, 200) as CacheEntry | undefined, a: 0.5 },
    });
    rerender({ e: undefined, a: 2 });
    expect(result.current).toBeUndefined();
    expect(created).toEqual([]);
  });
});
