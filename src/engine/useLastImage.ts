import { useEffect, useState } from 'react';
import type { CacheEntry, RenderCache } from './renderCache';

/** The largest relative difference between the retained image's aspect ratio and the box's that is still shown (no visible stretch). */
const ASPECT_TOLERANCE = 0.02;

/**
 * The image that was on screen until the cache lost it (a save loads the file again and drops the document's images): while `entry`
 * is `undefined`, the last one it had is returned with a URL of its own, so the old bitmap stays up until a new one has been
 * decoded and takes over (no blank frame, no skeleton). `undefined` while `entry` is there, or when there never was one.
 * `aspect` (width / height of the box the image is stretched into): a retained image of another shape (the page was turned) is not
 * shown, it would be stretched.
 */
export function useLastImage(
  cache: RenderCache,
  entry: CacheEntry | undefined,
  aspect?: number,
): { key: string; src: string } | undefined {
  const [last, setLast] = useState<CacheEntry | undefined>(entry);
  if (entry !== undefined && entry !== last) setLast(entry);
  const fits =
    last === undefined ||
    aspect === undefined ||
    !(aspect > 0) ||
    Math.abs(last.width / last.height / aspect - 1) <= ASPECT_TOLERANCE;
  const lostEntry = entry === undefined && fits ? last : undefined;
  // The lease: made in an effect when the entry is lost, revoked when a live one is back or the page goes (the entry's own URL died
  // with it). The URL is state, so render stays pure.
  const [lease, setLease] = useState<{ blob: Blob; url: string } | null>(null);
  const blob = lostEntry?.blob;
  useEffect(() => {
    if (blob === undefined) return;
    const url = cache.leaseUrl(blob);
    // The URL only exists once the effect made it, and the cache is outside React: this is the sync point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLease({ blob, url });
    return () => {
      cache.releaseUrl(url);
      setLease(null);
    };
  }, [cache, blob]);
  return lostEntry === undefined || lease === null || lease.blob !== lostEntry.blob
    ? undefined
    : { key: lostEntry.key, src: lease.url };
}
