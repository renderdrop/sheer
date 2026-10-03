import { animate, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { toAppError } from '../../api/errors';
import type { RenderPriority } from '../../api/render';
import { planPage, tilesIn, TILE_SIZE_PX, tileRect, type PagePlan, type TileIndex } from '../../engine/buckets';
import { imageKey, type CacheEntry, type ImageId } from '../../engine/renderCache';
import { renderScheduler, type RenderScheduler } from '../../engine/renderScheduler';
import { useT } from '../../i18n';
import { DURATION, ENTER_SCALE, FADE_END_SLACK_MS, SPRING } from '../../lib/motion';
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
  /**
   * How the page appears when it mounts (MOTION 4.6): `scale` is the first page of a document that opened without a source to fly
   * from (opacity and scale .96 to 1, slow); `fade` is the first page under a clone (opacity, slow). Read once, at mount.
   */
  entrance?: 'scale' | 'fade';
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

const FADE_MS = { first: DURATION.base * 1000, sharp: DURATION.fast * 1000 } as const;

interface FadeImageProps {
  src: string;
  style: object;
  /** Shown at full opacity from the start: it was in the cache when the page mounted (no fade, MOTION 4.3). */
  instant: boolean;
  /** `first`: the image fades over the placeholder (base); `sharp`: it fades over a stand-in (fast). */
  over: 'first' | 'sharp';
  /** The image has faded in completely: what it covered can go. */
  onShown?: () => void;
}

/** An image of a page that fades in (opacity only) once the browser has decoded it. */
function FadeImage({ src, style, instant, over, onShown }: FadeImageProps) {
  const [on, setOn] = useState(instant);
  const [fading, setFading] = useState(false);
  const shown = useRef(onShown);
  useEffect(() => {
    shown.current = onShown;
  });
  useEffect(() => {
    if (instant) shown.current?.();
  }, [instant]);
  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => {
      setFading(false);
      shown.current?.();
    }, FADE_MS[over] + FADE_END_SLACK_MS);
    return () => window.clearTimeout(timer);
  }, [fading, over]);
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      className={FILL}
      style={{
        ...style,
        opacity: on ? 1 : 0,
        transition: instant ? undefined : `opacity ${FADE_MS[over]}ms var(--ease-spring)`,
        willChange: fading ? 'opacity' : undefined,
      }}
      onLoad={() => {
        if (on) return;
        setOn(true);
        setFading(true);
      }}
    />
  );
}

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
  entrance,
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
  // What the cache had when the page mounted shows without a fade; what arrives later fades in (MOTION 4.3).
  const [atMount] = useState(() => new Set<string>(exact === undefined ? [] : [exact.key]));
  // The exact image covers the stand-in only once it has decoded and faded in (below), so the page is never blank in between.
  const [covered, setCovered] = useState<string | null>(exact?.key ?? null);
  const standIn =
    exact === undefined || covered !== exact.key
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

  // A stand-in is under the image that arrives: that one fades fast; over the bare placeholder it fades at base.
  const image = (
    entry: CacheEntry,
    style: object,
    over: 'first' | 'sharp',
    onShown?: () => void,
    shownAlready = false,
  ) => (
    <FadeImage
      key={entry.key}
      src={cache.urlOf(entry)}
      style={style}
      instant={shownAlready || atMount.has(entry.key)}
      over={over}
      onShown={onShown}
    />
  );
  const whole = { inset: 0, width: '100%', height: '100%' };

  const pageRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion() === true;
  const [entering] = useState(entrance);
  // A layout effect: the page starts invisible before its first paint.
  useLayoutEffect(() => {
    const element = pageRef.current;
    if (element === null || entering === undefined) return;
    const scaled = entering === 'scale' && !reduce;
    const controls = animate(
      element,
      scaled ? { opacity: [0, 1], scale: [ENTER_SCALE, 1] } : { opacity: [0, 1] },
      reduce ? SPRING.base : SPRING.slow,
    );
    element.style.willChange = scaled ? 'transform, opacity' : 'opacity';
    controls.then(
      () => {
        element.style.willChange = '';
        element.style.opacity = '';
        element.style.transform = '';
      },
      () => undefined,
    );
    return () => controls.stop();
  }, [entering, reduce]);

  return (
    <div
      ref={pageRef}
      role="img"
      aria-label={t('canvas.pageImage', { page: pageIndex + 1, total: pageCount })}
      data-page={pageIndex + 1}
      className="absolute z-canvas-page bg-page shadow-page"
      style={{ left, top, width, height }}
    >
      {standIn !== undefined && image(standIn, whole, 'first', undefined, true)}
      {exact !== undefined &&
        image(exact, whole, standIn === undefined ? 'first' : 'sharp', () => setCovered(exact.key))}
      {tileEntries.map(({ tile, entry }) => {
        const rect = tileRect(plan, tile);
        return image(
          entry,
          {
            left: `${(rect.x0 / plan.width) * 100}%`,
            top: `${(rect.y0 / plan.height) * 100}%`,
            width: `${((rect.x1 - rect.x0) / plan.width) * 100}%`,
            height: `${((rect.y1 - rect.y0) / plan.height) * 100}%`,
          },
          'sharp',
        );
      })}
    </div>
  );
});
