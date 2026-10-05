import { useEffect, useMemo, useState } from 'react';
import type { CacheEntry, RenderCache } from './renderCache';

/**
 * The image that was on screen until the cache lost it (a save loads the file again and drops the document's images): while `entry`
 * is `undefined`, the last one it had is returned with a URL of its own, so the old bitmap stays up until a new one has been
 * decoded and takes over (no blank frame, no skeleton). `undefined` while `entry` is there, or when there never was one.
 */
export function useLastImage(
  cache: RenderCache,
  entry: CacheEntry | undefined,
): { key: string; src: string } | undefined {
  const [last, setLast] = useState<CacheEntry | undefined>(entry);
  if (entry !== undefined && entry !== last) setLast(entry);
  const lostEntry = entry === undefined ? last : undefined;
  // The lease: made when the entry is lost, revoked when a live one is back or the page goes (the entry's own URL died with it).
  const url = useMemo(() => (lostEntry === undefined ? null : cache.leaseUrl(lostEntry.blob)), [cache, lostEntry]);
  useEffect(() => {
    if (url === null) return;
    return () => cache.releaseUrl(url);
  }, [cache, url]);
  return lostEntry === undefined || url === null ? undefined : { key: lostEntry.key, src: url };
}
