import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { cx } from '../../components/cx';
import { pulse } from '../../components/SuccessPulse';
import { bucketFor } from '../../engine/buckets';
import { imageKey, type ImageId } from '../../engine/renderCache';
import { renderScheduler, type RenderScheduler } from '../../engine/renderScheduler';
import { useT } from '../../i18n';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { THUMBNAIL_ASK_DELAY_MS } from '../thumbnails/ThumbnailItem';
import type { Slot } from './source';

/** The size a page takes inside the square thumbnail box: it fits whole, as turned, and is never larger than the box. */
export function fitInBox(
  slot: Pick<Slot, 'width' | 'height' | 'rotation'>,
  box: number,
): { width: number; height: number } {
  const turned = slot.rotation === 90 || slot.rotation === 270;
  const w = turned ? slot.height : slot.width;
  const h = turned ? slot.width : slot.height;
  if (!(w > 0) || !(h > 0)) return { width: box, height: box };
  const scale = box / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface OrganizeCellProps {
  docId: number;
  slot: Slot;
  /** Zero-based place in the document. */
  index: number;
  total: number;
  left: number;
  top: number;
  thumb: number;
  width: number;
  height: number;
  pixelRatio: number;
  selected: boolean;
  /** Whether this cell is the grid's tab stop. */
  tabStop: boolean;
  /** Mounted for its image (in or near the view). */
  active: boolean;
  /** A page that is being dragged: it fades to .4. */
  dragged: boolean;
  /** Pulses once when this changes to a new number (an inserted page). */
  pulseKey: number;
  scheduler?: RenderScheduler;
}

/**
 * One cell of the organize grid (DESIGN 3.28): the page, as turned, in a square box with its shadow, over the label pill. An
 * `option` of the grid's `listbox`. It sits at `translate(left, top)`: a move of the order changes the translate and the CSS
 * transition does the reflow (reduced motion: the global rule turns it into nothing). Its image comes from the shared render cache
 * at the thumbnail priority, keyed by the page's id and revision so that a reorder never shows another page's picture.
 */
export const OrganizeCell = memo(function OrganizeCell({
  docId,
  slot,
  index,
  total,
  left,
  top,
  thumb,
  width,
  height,
  pixelRatio,
  selected,
  tabStop,
  active,
  dragged,
  pulseKey,
  scheduler = renderScheduler,
}: OrganizeCellProps) {
  const t = useT();
  const { cache } = scheduler;
  const size = fitInBox(slot, thumb);
  const turned = slot.rotation === 90 || slot.rotation === 270;
  const widthPt = turned ? slot.height : slot.width;
  const bucket = bucketFor(size.width / ((widthPt > 0 ? widthPt : 1) * CSS_PX_PER_PT), pixelRatio);
  const [owner] = useState(() => ({}));
  const page = slot.id;

  const subscribe = useCallback((notify: () => void) => cache.subscribe(docId, page, notify), [cache, docId, page]);
  const version = useSyncExternalStore(
    subscribe,
    () => cache.version(docId, page),
    () => 0,
  );
  const exact = cache.get(imageKey({ docId, page, rev: 0, slotRev: slot.rev, bucket }));
  const shown = exact ?? cache.best(docId, page, 0, bucket, undefined, slot.rev);
  const shownKey = shown?.key ?? '';
  const [loaded, setLoaded] = useState<string>('');

  useEffect(() => {
    cache.pin(owner, shownKey === '' ? [] : [shownKey]);
  }, [cache, owner, shownKey]);
  useEffect(() => () => cache.unpin(owner), [cache, owner]);

  useEffect(() => {
    if (!active) return;
    const id: ImageId = { docId, page, rev: 0, slotRev: slot.rev, bucket };
    if (cache.has(imageKey(id))) return;
    const timer = window.setTimeout(() => {
      scheduler.request(id, 'thumbnail').catch(() => undefined);
    }, THUMBNAIL_ASK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, scheduler, cache, docId, page, slot.rev, bucket, version]);

  // An inserted page pulses once (MOTION 4.7); the announcement is the command's own.
  const pageRef = useRef<HTMLDivElement | null>(null);
  const pulsed = useRef(0);
  useEffect(() => {
    if (pulseKey === 0 || pulseKey === pulsed.current || pageRef.current === null) return;
    pulsed.current = pulseKey;
    pulse(pageRef.current, '');
  }, [pulseKey]);

  const label = slot.label ?? String(index + 1);
  const number = slot.label !== null && slot.label !== String(index + 1) ? `${slot.label} · ${index + 1}` : label;

  return (
    <div
      role="option"
      id={`organize-${docId}-${page}`}
      aria-selected={selected}
      aria-label={t('organize.page', { label: slot.label ?? String(index + 1), n: index + 1, total })}
      aria-posinset={index + 1}
      aria-setsize={total}
      data-page-id={page}
      data-index={index}
      tabIndex={tabStop ? 0 : -1}
      className={cx(
        'absolute start-0 top-0 flex touch-none cursor-pointer select-none flex-col items-center gap-1 rounded-sm p-0-5 transition-[transform,opacity,background-color] duration-base ease-spring',
        selected ? 'bg-selected' : 'hover:bg-control-hover',
        dragged && 'opacity-40',
      )}
      style={{ transform: `translate(${left}px, ${top}px)`, width, height }}
    >
      <div className="flex shrink-0 items-center justify-center" style={{ width: thumb, height: thumb }}>
        <div
          ref={pageRef}
          className="pulse-target relative overflow-hidden rounded-xs bg-page shadow-page [--pulse-radius:var(--radius-xs)]"
          style={{ width: size.width, height: size.height }}
        >
          {shown !== undefined && (
            <img
              key={shown.key}
              src={cache.urlOf(shown)}
              alt=""
              draggable={false}
              decoding="sync"
              onLoad={() => setLoaded(shown.key)}
              className={cx(
                'absolute inset-0 size-full max-w-none select-none transition-opacity duration-base',
                loaded !== shown.key && 'opacity-0',
              )}
            />
          )}
        </div>
      </div>
      <span
        aria-hidden="true"
        className={cx(
          'inline-flex h-(--pill-height) min-w-3 items-center justify-center rounded-pill px-1 text-xs tabular-nums',
          selected ? 'bg-accent text-on-accent' : 'bg-tile text-tile-icon',
        )}
      >
        {number}
      </span>
    </div>
  );
});
