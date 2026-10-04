import { animate, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { toAppError } from '../../api/errors';
import type { RenderPriority } from '../../api/render';
import { planPage, tilesIn, TILE_SIZE_PX, tileRect, type PagePlan, type TileIndex } from '../../engine/buckets';
import { imageKey, type CacheEntry, type ImageId } from '../../engine/renderCache';
import { renderScheduler, type RenderScheduler } from '../../engine/renderScheduler';
import { useT } from '../../i18n';
import { DURATION, ENTER_SCALE, FADE_END_SLACK_MS, SPRING } from '../../lib/motion';
import { pageRevOf, useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { AnnotationLayer } from '../annotations/layer/AnnotationLayer';
import { CropLayer } from '../crop/CropLayer';
import { FormLayer } from '../forms/FormLayer';
import { InsertLayer } from '../insert/InsertLayer';
import { RedactLayer } from '../redact/RedactLayer';
import { usePageText } from '../textlayer/cache';
import type { PageLayerProps } from './pageLayer';
import { PageOverlay } from '../textlayer/PageOverlay';
import { runsOf } from '../textlayer/runs';
import { hasFileRotation } from './fileRotation';
import { clearRenderFailure, showRenderFailure } from './renderFailure';
import { readViewRect, subscribeViewRect } from './scrollBridge';
import { boxToPage, normalizeRotation, swapsSides, type Rotation } from './transform';

/**
 * How long a page that already shows a lower resolution image of itself waits, after its zoom bucket changed, before it asks for
 * the sharper one: a wheel zoom or a held key passes through several buckets in a moment, and only the one it stops at is worth
 * rendering. A page with nothing to show asks at once.
 */
export const BUCKET_SETTLE_MS = 80;

/** A request that came back withdrawn is asked again this many times, `RENDER_RETRY_MS` times the attempt apart. */
export const RENDER_RETRIES = 5;
export const RENDER_RETRY_MS = 200;

/** How many earlier revisions of a page are looked at for a stand-in while the image of the new one is on its way. */
const STAND_IN_REVS = 8;

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
  /**
   * The page's id (ADR-036): what the backend, the render cache, the overlays and their stores call it. It stays the same page
   * through moves; `pageIndex` is only where it sits now. The position by default (a document whose pages were never changed).
   */
  pageId?: number;
  /** The page's own revision (`PageSlotInfo.rev`: a rotation raises it); part of the cache key, so a rotated page renders anew. */
  slotRev?: number;
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
  /**
   * The view rotation in degrees (DESIGN 3.20). `width` and `height` are the box as it is shown, so with a quarter turn they are
   * the page's sides swapped; `widthPt` and `heightPt` stay the page as it is drawn (the file's rotation applied).
   */
  rotation?: number;
}

const tileKeyOf = (tile: TileIndex) => `${tile[0]},${tile[1]}`;

/**
 * The tiles of `plan` that the viewport (as the scroll bridge last published it) shows or is about to: a key for them, `''`
 * when the page is not tiled. A string, so `useSyncExternalStore` can tell whether it changed. The page's box is where it sits
 * in the content, in px.
 */
function visibleTilesKey(
  plan: PagePlan,
  left: number,
  top: number,
  width: number,
  height: number,
  rotation: Rotation,
): string {
  if (!plan.tiled || width <= 0 || height <= 0) return '';
  const view = readViewRect();
  // The viewport in the page's own pixels: its position relative to the page's box, scaled from CSS px to pixels of the bucket.
  // A view rotation turns the page inside its box, so the viewport is turned back into the unrotated image first.
  const [innerW, innerH] = swapsSides(rotation) ? [height, width] : [width, height];
  const seen = boxToPage(
    { x: view.left - left, y: view.top - top, w: view.right - view.left, h: view.bottom - view.top },
    [innerW, innerH],
    rotation,
  );
  const toX = plan.width / innerW;
  const toY = plan.height / innerH;
  const tiles = tilesIn(plan, {
    x0: seen.x * toX - TILE_LOOKAHEAD_PX,
    y0: seen.y * toY - TILE_LOOKAHEAD_PX,
    x1: (seen.x + seen.w) * toX + TILE_LOOKAHEAD_PX,
    y1: (seen.y + seen.h) * toY + TILE_LOOKAHEAD_PX,
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
        transition: instant ? undefined : `opacity ${FADE_MS[over]}ms var(--ease-out)`,
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
  pageId = pageIndex,
  slotRev = 0,
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
  rotation: rotationProp = 0,
}: PageViewProps) {
  const t = useT();
  const rotation = normalizeRotation(rotationProp);
  const { cache } = scheduler;
  // What this page pins in the cache: its own object, so it does not release what another page holds.
  const [owner] = useState(() => ({}));
  const plan = useMemo(() => planPage(widthPt, heightPt, bucket), [widthPt, heightPt, bucket]);
  const wholeBucket = plan.tiled ? plan.underlayBucket : plan.bucket;
  const tiledBucket = plan.bucket;

  // The cache changes without React knowing: the version of this page's entries is what tells the page to look again.
  const subscribeToPage = useCallback(
    (notify: () => void) => cache.subscribe(docId, pageId, notify),
    [cache, docId, pageId],
  );
  const cacheVersion = useSyncExternalStore(
    subscribeToPage,
    () => cache.version(docId, pageId),
    () => 0,
  );
  const tilesKey = useSyncExternalStore(
    subscribeViewRect,
    () => visibleTilesKey(plan, left, top, width, height, rotation),
    () => '',
  );
  const tiles = useMemo(() => parseTiles(tilesKey), [tilesKey]);

  // An annotation of the file that was changed makes the page's pixels stale: the images of the new revision are asked for, and the
  // old ones stand in until they arrive.
  const rev = useAnnotations((state) => pageRevOf(state, docId, pageId));
  const standInFor = (bucket: number, except?: string): CacheEntry | undefined => {
    for (let q = slotRev; q >= Math.max(0, slotRev - STAND_IN_REVS); q -= 1) {
      for (let r = rev; r >= Math.max(0, rev - STAND_IN_REVS); r -= 1) {
        const found = cache.best(docId, pageId, r, bucket, except, q);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const wholeId: ImageId = { docId, page: pageId, rev, slotRev, bucket: wholeBucket };
  const exact = cache.get(imageKey(wholeId));
  // What the cache had when the page mounted shows without a fade; what arrives later fades in (MOTION 4.3).
  const [atMount] = useState(() => new Set<string>(exact === undefined ? [] : [exact.key]));
  // The exact image covers the stand-in only once it has decoded and faded in (below), so the page is never blank in between.
  const [covered, setCovered] = useState<string | null>(exact?.key ?? null);
  const standIn = exact === undefined || covered !== exact.key ? standInFor(wholeBucket, exact?.key) : undefined;
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

  // Ask for what is missing: the page, or the underlay and the tiles near the viewport. The cache version is a dependency: a save drops
  // the document's images (the file was loaded again), and the page must ask again for what it showed, not keep a thumbnail as stand-in.
  useEffect(() => {
    const whole: ImageId = { docId, page: pageId, rev, slotRev, bucket: wholeBucket };
    const wanted: ImageId[] = [whole];
    for (const tile of tiles) wanted.push({ ...whole, bucket: tiledBucket, tile });
    const missing = wanted.filter((id) => !cache.has(imageKey(id)));
    if (missing.length === 0) return;
    let current = true;
    const timers = new Set<number>();
    const ask = (ids: readonly ImageId[], attempt: number) => {
      for (const id of ids) {
        scheduler.request(id, priority).then(
          (entry) => {
            if (entry !== null) {
              clearRenderFailure();
              return;
            }
            // Withdrawn (a viewport hint overtook it, as after an edit that swaps the page) and nothing stored: the effect's inputs
            // did not change, so nothing else would ask again, and the stand-in (a soft image of an older revision) would stay.
            if (!current || cache.isDropped(docId) || cache.has(imageKey(id)) || attempt >= RENDER_RETRIES) return;
            const timer = window.setTimeout(
              () => {
                timers.delete(timer);
                if (current) ask([id], attempt + 1);
              },
              RENDER_RETRY_MS * (attempt + 1),
            );
            timers.add(timer);
          },
          (caught: unknown) => {
            if (current) showRenderFailure(toAppError(caught));
          },
        );
      }
    };
    // Something to show meanwhile makes the wait cheap; without it the page is blank until the image arrives.
    let hasSomething = false;
    for (let q = slotRev; q >= Math.max(0, slotRev - STAND_IN_REVS) && !hasSomething; q -= 1) {
      for (let r = rev; r >= Math.max(0, rev - STAND_IN_REVS) && !hasSomething; r -= 1) {
        hasSomething = cache.best(docId, pageId, r, wholeBucket, undefined, q) !== undefined;
      }
    }
    const timer = hasSomething ? window.setTimeout(() => ask(missing, 0), BUCKET_SETTLE_MS) : undefined;
    if (timer === undefined) ask(missing, 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
      for (const pending of timers) window.clearTimeout(pending);
    };
  }, [scheduler, cache, docId, pageId, rev, slotRev, wholeBucket, tiledBucket, tiles, priority, cacheVersion]);

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
  // The images sit in a surface that is turned by the view rotation (the box is as large as the turned page).
  const [surfaceW, surfaceH] = swapsSides(rotation) ? [height, width] : [width, height];
  const surface =
    rotation === 0
      ? { left: 0, top: 0, width: '100%', height: '100%' }
      : {
          left: (width - surfaceW) / 2,
          top: (height - surfaceH) / 2,
          width: surfaceW,
          height: surfaceH,
          transform: `rotate(${rotation}deg)`,
        };

  // The text of the page (DESIGN 3.17), fetched once the page is on screen. A page with text is a group, one without stays an image.
  const text = usePageText(docId, pageId, priority === 'visible');
  const hasText = text.status === 'ready' && runsOf(text.layer).length > 0;
  const noText = text.status === 'ready' && !hasText;
  const interactive = useUi((state) => state.activeTool === 'select');

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

  const layer: PageLayerProps = {
    docId,
    pageIndex: pageId,
    boxWidth: width,
    boxHeight: height,
    widthPt,
    heightPt,
    rotation,
    ready: text.layer !== null || hasFileRotation(docId, pageId),
  };

  return (
    <div
      ref={pageRef}
      role={hasText ? 'group' : 'img'}
      aria-label={t('canvas.pageImage', { page: pageIndex + 1, total: pageCount })}
      aria-description={noText ? t('text.noText') : undefined}
      data-page={pageIndex + 1}
      className="absolute z-canvas-page bg-page shadow-floating"
      style={{ left, top, width, height }}
    >
      <div className="absolute" style={surface}>
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
      <PageOverlay
        docId={docId}
        pageIndex={pageId}
        boxWidth={width}
        boxHeight={height}
        widthPt={widthPt}
        heightPt={heightPt}
        rotation={rotation}
        layer={text.layer}
        interactive={interactive}
      />
      <AnnotationLayer
        docId={docId}
        pageIndex={pageId}
        boxWidth={width}
        boxHeight={height}
        widthPt={widthPt}
        heightPt={heightPt}
        rotation={rotation}
        visible={priority === 'visible'}
        ready={text.layer !== null || hasFileRotation(docId, pageId)}
      />
      {/* After the annotations, so a field is above them (layer 3, DESIGN 3.32). */}
      <FormLayer
        docId={docId}
        pageIndex={pageId}
        boxWidth={width}
        boxHeight={height}
        widthPt={widthPt}
        heightPt={heightPt}
        rotation={rotation}
        ready={text.layer !== null || hasFileRotation(docId, pageId)}
      />
      {/* M5 layers (layer 3, DESIGN 3.36 to 3.38); each renders nothing outside its tool or mode. */}
      <InsertLayer {...layer} />
      <RedactLayer {...layer} />
      <CropLayer {...layer} />
    </div>
  );
});
