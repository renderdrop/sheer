import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { toAppError } from '../../api/errors';
import type { RenderPriority } from '../../api/render';
import { planPage, tilesIn, TILE_SIZE_PX, tileRect, type PagePlan, type TileIndex } from '../../engine/buckets';
import { imageKey, type CacheEntry, type ImageId } from '../../engine/renderCache';
import { renderScheduler, type RenderScheduler } from '../../engine/renderScheduler';
import { useT } from '../../i18n';
import { clearRenderFailure, showRenderFailure } from './renderFailure';
import { readViewRect, subscribeViewRect } from './scrollBridge';

/**
 * How long a page that already shows a lower resolution image of itself waits, after its zoom bucket changed, before it asks for
 * the sharper one: a wheel zoom or a held key passes through several buckets in a moment, and only the one it stops at is worth
 * rendering. A page with nothing to show asks at once.
 */
export const BUCKET_SETTLE_MS = 80;

/** The revision of a page's pixels (the backend's `pageRev`); pages cannot change until M2, so it is always 0. */
const PAGE_REV = 0;

/** A tiled page also renders the tiles this far (in px of its bucket) beyond the viewport, so scrolling does not show blanks. */
const TILE_LOOKAHEAD_PX = TILE_SIZE_PX / 2;

/**
 * Everything is a number, a string or a flag, never an object: the canvas builds its layout objects anew whenever it renders, and
 * a prop that is a new object each time would make the memoization below worthless (it compares props one by one, by identity).
 */
export interface PageViewProps {
  docId: number;
  /** Zero-based. */
  pageIndex: number;
  pageCount: number;
  /** Where the page sits in the content, and how large it is shown, in px (the page's `PageBox`). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The page's size in points. */
  widthPt: number;
  heightPt: number;
  /** The bucket for the current zoom on this display (`bucketFor`). */
  bucket: number;
  /** On screen, or only close to it. */
  priority: Extract<RenderPriority, 'visible' | 'near'>;
  /** The scheduler and its cache; the app's by default. */
  scheduler?: RenderScheduler;
}

const tileKeyOf = (tile: TileIndex) => `${tile[0]},${tile[1]}`;

/**
 * The tiles of `plan` that the viewport (as the scroll bridge last published it) shows or is about to: a key for them, `''`
 * when the page is not tiled. A string, so `useSyncExternalStore` can tell whether it changed. The page's box is where it sits
 * in the content, in px.
 */
function visibleTilesKey(plan: PagePlan, left: number, top: number, width: number, height: number): string {
  if (!plan.tiled || width <= 0 || height <= 0) return '';
  const view = readViewRect();
  // The viewport in the page's own pixels: its position relative to the page's box, scaled from CSS px to pixels of the bucket.
  const toX = plan.width / width;
  const toY = plan.height / height;
  const tiles = tilesIn(plan, {
    x0: (view.left - left) * toX - TILE_LOOKAHEAD_PX,
    y0: (view.top - top) * toY - TILE_LOOKAHEAD_PX,
    x1: (view.right - left) * toX + TILE_LOOKAHEAD_PX,
    y1: (view.bottom - top) * toY + TILE_LOOKAHEAD_PX,
  });
  return tiles.map(tileKeyOf).join(';');
}

function parseTiles(key: string): TileIndex[] {
  if (key === '') return [];
  return key.split(';').map((part) => {
    const [column = '0', row = '0'] = part.split(',');
    return [Number(column), Number(row)] as const;
  });
}

const FILL = 'absolute max-w-none select-none';

/**
 * One page of the canvas (ADR-002 §5): a white placeholder of the page's size, with the best image the cache has of it on top, and
 * a request for the exact one. The image is scaled by the browser to the page's size, so the best cached bucket (a lower or higher
 * resolution of the same page) shows at once, and the sharp one replaces it when it has arrived and been decoded. A page that is too
 * large at its bucket for one frame is a low resolution underlay with tiles over it, only the tiles near the viewport.
 *
 * It is memoized and takes everything as props (plain values, see `PageViewProps`), so it renders when its own box, size, zoom
 * bucket or images change, not when the canvas renders for another reason or scrolls; a tiled page follows the viewport itself,
 * through the scroll bridge.
 */
export const PageView = memo(function PageView({
  docId,
  pageIndex,
  pageCount,
  left,
  top,
  width,
  height,
  widthPt,
  heightPt,
  bucket,
  priority,
  scheduler = renderScheduler,
}: PageViewProps) {
  const t = useT();
  const { cache } = scheduler;
  // What this page pins in the cache: its own object, so it does not release what another page holds.
  const [owner] = useState(() => ({}));
  const plan = useMemo(() => planPage(widthPt, heightPt, bucket), [widthPt, heightPt, bucket]);
  const wholeBucket = plan.tiled ? plan.underlayBucket : plan.bucket;
  const tiledBucket = plan.bucket;

  // The cache changes without React knowing: the version of this page's entries is what tells the page to look again.
  const subscribeToPage = useCallback(
    (notify: () => void) => cache.subscribe(docId, pageIndex, notify),
    [cache, docId, pageIndex],
  );
  useSyncExternalStore(
    subscribeToPage,
    () => cache.version(docId, pageIndex),
    () => 0,
  );
  const tilesKey = useSyncExternalStore(
    subscribeViewRect,
    () => visibleTilesKey(plan, left, top, width, height),
    () => '',
  );
  const tiles = useMemo(() => parseTiles(tilesKey), [tilesKey]);

  const wholeId: ImageId = { docId, page: pageIndex, rev: PAGE_REV, bucket: wholeBucket };
  const exact = cache.get(imageKey(wholeId));
  // The exact image covers the stand-in only once the browser has decoded it (below), so the page is never blank in between.
  const [decoded, setDecoded] = useState<string | null>(null);
  const standIn =
    exact === undefined || decoded !== exact.key
      ? cache.best(docId, pageIndex, PAGE_REV, wholeBucket, exact?.key)
      : undefined;
  const tileEntries = tiles.flatMap((tile) => {
    const entry = cache.get(imageKey({ ...wholeId, bucket: plan.bucket, tile }));
    return entry === undefined ? [] : [{ tile, entry }];
  });

  // The images this page shows are not evicted while it does. (An effect: the cache is outside React, and pins are its state.)
  const shown = [exact, standIn, ...tileEntries.map(({ entry }) => entry)].flatMap((entry) =>
    entry ? [entry.key] : [],
  );
  const shownKey = shown.join('|');
  useEffect(() => {
    cache.pin(owner, shownKey === '' ? [] : shownKey.split('|'));
  }, [cache, owner, shownKey]);
  useEffect(() => () => cache.unpin(owner), [cache, owner]);

  // Ask for what is missing: the page, or the underlay and the tiles near the viewport.
  useEffect(() => {
    const whole: ImageId = { docId, page: pageIndex, rev: PAGE_REV, bucket: wholeBucket };
    const wanted: ImageId[] = [whole];
    for (const tile of tiles) wanted.push({ ...whole, bucket: tiledBucket, tile });
    const missing = wanted.filter((id) => !cache.has(imageKey(id)));
    if (missing.length === 0) return;
    let current = true;
    const ask = () => {
      for (const id of missing) {
        scheduler.request(id, priority).then(
          (entry) => {
            if (entry !== null) clearRenderFailure();
          },
          (caught: unknown) => {
            if (current) showRenderFailure(toAppError(caught));
          },
        );
      }
    };
    // Something to show meanwhile makes the wait cheap; without it the page is blank until the image arrives.
    const hasSomething = cache.best(docId, pageIndex, PAGE_REV, wholeBucket) !== undefined;
    const timer = hasSomething ? window.setTimeout(ask, BUCKET_SETTLE_MS) : undefined;
    if (timer === undefined) ask();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [scheduler, cache, docId, pageIndex, wholeBucket, tiledBucket, tiles, priority]);

  const image = (entry: CacheEntry, style: object, onLoad?: () => void) => (
    <img
      key={entry.key}
      src={cache.urlOf(entry)}
      alt=""
      draggable={false}
      decoding="async"
      className={FILL}
      style={style}
      onLoad={onLoad}
    />
  );
  const whole = { inset: 0, width: '100%', height: '100%' };

  return (
    <div
      role="img"
      aria-label={t('canvas.pageImage', { page: pageIndex + 1, total: pageCount })}
      data-page={pageIndex + 1}
      className="absolute z-canvas-page bg-page shadow-page"
      style={{ left, top, width, height }}
    >
      {standIn !== undefined && image(standIn, whole)}
      {exact !== undefined && image(exact, whole, () => setDecoded(exact.key))}
      {tileEntries.map(({ tile, entry }) => {
        const rect = tileRect(plan, tile);
        return image(entry, {
          left: `${(rect.x0 / plan.width) * 100}%`,
          top: `${(rect.y0 / plan.height) * 100}%`,
          width: `${((rect.x1 - rect.x0) / plan.width) * 100}%`,
          height: `${((rect.y1 - rect.y0) / plan.height) * 100}%`,
        });
      })}
    </div>
  );
});
