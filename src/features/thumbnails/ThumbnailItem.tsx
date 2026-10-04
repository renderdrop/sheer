import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { bucketFor } from '../../engine/buckets';
import { imageKey, type ImageId } from '../../engine/renderCache';
import { renderScheduler, type RenderScheduler } from '../../engine/renderScheduler';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { useView } from '../../stores/view';

/**
 * How long a thumbnail that is in view waits before it asks for its image: scrolling fast through a long document passes
 * hundreds of cells, and only the ones it stops at are worth a render. A cell that is gone again before this has passed asks for
 * nothing.
 */
export const THUMBNAIL_ASK_DELAY_MS = 80;

/** Images that were shown before are kept decoded, bounded, oldest first. */
const MAX_WARM_IMAGES = 128;
const warm = new Map<string, HTMLImageElement>();

/** Keeps a decoded copy of `src` around, so a cell that mounts again (the panel reopened) paints it on its first frame. */
function keepWarm(src: string): void {
  warm.delete(src);
  if (typeof Image === 'undefined') return;
  const image = new Image();
  image.src = src;
  // `decode` is missing in some embedders (jsdom): the image then just stays loaded.
  if (typeof image.decode === 'function') image.decode().catch(() => undefined);
  warm.set(src, image);
  while (warm.size > MAX_WARM_IMAGES) {
    const oldest = warm.keys().next();
    if (oldest.done === true) break;
    warm.delete(oldest.value);
  }
}

/** The thumbnail's picture: a frame shown before appears at once, one that never was fades in when it has loaded. */
function ThumbnailImage({ src }: { src: string }) {
  const [fresh] = useState(() => !warm.has(src));
  const [ready, setReady] = useState(!fresh);
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      decoding="sync"
      onLoad={() => {
        if (!warm.has(src)) keepWarm(src);
        setReady(true);
      }}
      className={cx(
        'absolute inset-0 size-full max-w-none select-none',
        fresh && 'transition-opacity duration-base',
        !ready && 'opacity-0',
      )}
    />
  );
}

/**
 * Everything is a number, a string or a flag, never an object: the list builds its layout anew whenever its width changes, and a
 * prop that is a new object each time would make the memoization below worthless.
 */
export interface ThumbnailItemProps {
  docId: number;
  /** Zero-based. */
  index: number;
  /** The page's id and its revision (`PageSlotInfo`): the cell shows the page that sits at `index`, whichever it is. Default: the file's page. */
  pageId?: number;
  pageRev?: number;
  pageCount: number;
  /** Where the cell sits in the list and how tall it is, in px. */
  top: number;
  height: number;
  /** The thumbnail's size in px (its placeholder, before the image is there). */
  thumbWidth: number;
  thumbHeight: number;
  /** The page's size in points: what the bucket of its image follows. */
  widthPt: number;
  /** The display's pixel ratio. */
  pixelRatio: number;
  /** In view (or just outside it): it asks for its image. A cell that is only mounted for the focus does not. */
  active: boolean;
  /**
   * Whether this is the list's tab stop while focus is inside the list (the cell the user moved to), `null` while it is not:
   * then the tab stop is the current page.
   */
  focusStop: boolean | null;
  onActivate: (index: number) => void;
  /** The scheduler and its cache; the app's by default. */
  scheduler?: RenderScheduler;
}

/**
 * One cell of the thumbnails list (DESIGN 3.9): a white placeholder of the page's shape with the best image the render cache has
 * of the page on it, and the page number in a pill under it. It is an `option` of the list's `listbox`.
 *
 * It asks for its image at the `thumbnail` priority (the lowest the canvas does not preempt), at the bucket that fits its size;
 * the cache is the canvas's, so a page that is on screen already has an image to show, and the thumbnail's own is there for the
 * canvas to use at a low zoom.
 *
 * It follows by itself whether it is the current page (a subscription to one boolean of the view store), so a page change renders
 * the two cells that change and no other. Memoized, with plain props (`ThumbnailItemProps`), for the same reason.
 */
export const ThumbnailItem = memo(function ThumbnailItem({
  docId,
  index,
  pageId = index,
  pageRev = 0,
  pageCount,
  top,
  height,
  thumbWidth,
  thumbHeight,
  widthPt,
  pixelRatio,
  active,
  focusStop,
  onActivate,
  scheduler = renderScheduler,
}: ThumbnailItemProps) {
  const t = useT();
  const { cache } = scheduler;
  const selected = useView((state) => state.byDoc[docId]?.pageIndex === index);
  const bucket = bucketFor(thumbWidth / (widthPt * CSS_PX_PER_PT), pixelRatio);
  // What this cell pins in the cache: its own object, so it does not release what another cell or page holds.
  const [owner] = useState(() => ({}));

  // The cache changes without React knowing: the version of this page's entries is what tells the cell to look again.
  const subscribeToPage = useCallback(
    (notify: () => void) => cache.subscribe(docId, pageId, notify),
    [cache, docId, pageId],
  );
  const version = useSyncExternalStore(
    subscribeToPage,
    () => cache.version(docId, pageId),
    () => 0,
  );

  const exact = cache.get(imageKey({ docId, page: pageId, rev: 0, slotRev: pageRev, bucket }));
  // Until the right size is there, any image of the page does: the canvas's, or a thumbnail of another size.
  const shown = exact ?? cache.best(docId, pageId, 0, bucket, undefined, pageRev);
  const shownKey = shown?.key ?? '';

  // The image this cell shows is not evicted while it does. (An effect: the cache is outside React, and pins are its state.)
  useEffect(() => {
    cache.pin(owner, shownKey === '' ? [] : [shownKey]);
  }, [cache, owner, shownKey]);
  useEffect(() => () => cache.unpin(owner), [cache, owner]);

  // Ask for what is missing, once the cell has stayed in view for a moment. Nothing is asked in the name of a failure: a
  // thumbnail that cannot be rendered stays a blank page, and the page's own render reports what is wrong.
  useEffect(() => {
    if (!active) return;
    const id: ImageId = { docId, page: pageId, rev: 0, slotRev: pageRev, bucket };
    if (cache.has(imageKey(id))) return;
    const timer = window.setTimeout(() => {
      scheduler.request(id, 'thumbnail').catch(() => undefined);
    }, THUMBNAIL_ASK_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `version` re-checks after the cache changed (an entry was evicted, or a render of this page arrived).
  }, [active, scheduler, cache, docId, pageId, pageRev, bucket, version]);

  const tabStop = focusStop ?? selected;

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-current={selected ? 'page' : undefined}
      aria-label={t('thumbnails.page', { page: index + 1 })}
      aria-posinset={index + 1}
      aria-setsize={pageCount}
      data-index={index}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onActivate(index)}
      className={cx(
        'absolute inset-x-0 flex cursor-pointer select-none flex-col items-center gap-1 rounded-sm p-1 transition-colors',
        selected ? 'bg-selected' : 'hover:bg-control-hover active:bg-control-pressed',
      )}
      style={{ top, height }}
    >
      <div
        // The thumbnail: radius 4 inside the cell's 8 and its 4 px padding (concentric), the page's shadow, and for the current
        // page a 2 px accent ring. The ring is a shape as well as a color: it is there or it is not, and under forced colors it is
        // still drawn in the system highlight.
        className={cx(
          'pulse-target shrink-0 rounded-sm bg-page shadow-page [--pulse-radius:var(--radius-sm)]',
          selected && 'outline-2 outline-accent',
        )}
        data-thumb-page={pageId}
        style={{ width: thumbWidth, height: thumbHeight }}
      >
        <div className="size-full overflow-hidden rounded-sm">
          {shown !== undefined && <ThumbnailImage key={shown.key} src={cache.urlOf(shown)} />}
        </div>
      </div>
      <span
        aria-hidden="true"
        className={cx(
          'inline-flex h-4 min-w-6 items-center justify-center rounded-pill px-2 text-xs tabular-nums',
          selected ? 'bg-accent text-on-accent' : 'bg-tile text-tile-icon',
        )}
      >
        {index + 1}
      </span>
    </div>
  );
});
