import { CircleAlert, GripVertical, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

import { getImageBatchPreview, type BatchItem } from '../../api/imagesToPdf';
import { Icon, IconButton } from '../../components';
import { announce } from '../../components/SuccessPulse';
import { useT } from '../../i18n';
import { moveEntry } from '../jobs/MergeSheet';

/** The long side of a thumbnail request: twice the 40 px row tile, for dense screens. */
const THUMB_PX = 96;

/** At most this many preview requests are in flight; the rest wait in a queue. */
export const MAX_PREVIEWS_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: Array<() => void> = [];

function pump() {
  while (inFlight < MAX_PREVIEWS_IN_FLIGHT) {
    const start = waiting.shift();
    if (start === undefined) return;
    start();
  }
}

/** Runs `task` when a slot is free; the returned function drops it if still queued (a started task just has its result ignored). */
function schedulePreview(task: () => Promise<void>): () => void {
  let started = false;
  const start = () => {
    started = true;
    inFlight += 1;
    void task().finally(() => {
      inFlight -= 1;
      pump();
    });
  };
  waiting.push(start);
  pump();
  return () => {
    if (started) return;
    const at = waiting.indexOf(start);
    if (at >= 0) waiting.splice(at, 1);
  };
}

/** True once the element has entered the scroll root's view (always true where IntersectionObserver is missing). */
function useVisible(target: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = target.current;
    if (seen || el === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (hits) => {
        if (hits.some((hit) => hit.isIntersecting)) setSeen(true);
      },
      { root: root.current },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen, target, root]);
  return seen;
}

/** A thumbnail from the backend through an object URL that is revoked when it goes. Loaded when visible, through the request cap. A failure is reported once (unreadable). */
function Thumb({
  batch,
  index,
  onFail,
  root,
}: {
  batch: number;
  index: number;
  onFail: (index: number) => void;
  root: RefObject<HTMLElement | null>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const visible = useVisible(box, root);
  const fail = useRef(onFail);
  useEffect(() => {
    fail.current = onFail;
  });
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let made: string | null = null;
    const drop = schedulePreview(() =>
      getImageBatchPreview(batch, index, THUMB_PX)
        .then((frame) => {
          if (cancelled) return;
          made = URL.createObjectURL(new Blob([frame.data], { type: 'image/png' }));
          setUrl(made);
        })
        .catch(() => {
          if (!cancelled) fail.current(index);
        }),
    );
    return () => {
      cancelled = true;
      drop();
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [batch, index, visible]);
  return (
    <span ref={box} className="flex size-full items-center justify-center">
      {url === null ? null : <img src={url} alt="" className="size-full object-contain" />}
    </span>
  );
}

interface Props {
  batch: number;
  entries: readonly BatchItem[];
  onChange: (next: BatchItem[]) => void;
  /** Batch indices that could not be decoded; they block Create until removed. */
  failed: ReadonlySet<number>;
  onFail: (index: number) => void;
  disabled: boolean;
}

const ROW = 'h-[calc(var(--space-12)+var(--space-2))]';

/**
 * The reorderable list of images (DESIGN 3.43): drag by the grip, Alt+Up/Down, Delete removes. Indices are the batch's own. The drag
 * has no animation (only the lifted row dims and a marker shows the landing place), so reduced motion needs no other fallback.
 */
export function ImageList({ batch, entries, onChange, failed, onFail, disabled }: Props) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ index: number; over: number } | null>(null);

  // Focus follows a moved or neighbouring row.
  useEffect(() => {
    if (focusIndex === null) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)?.focus();
  }, [focusIndex, entries]);

  if (entries.length === 0) {
    return (
      <div
        className={`mt-4 flex min-h-[calc((var(--space-12)+var(--space-2))*2)] items-center justify-center rounded-card border border-divider text-center text-md text-text-muted`}
      >
        {t('img2pdf.empty')}
      </div>
    );
  }

  const remove = (position: number) => {
    if (disabled) return;
    const next = entries.filter((_, i) => i !== position);
    onChange(next);
    setFocusIndex(next[Math.min(position, next.length - 1)]?.index ?? null);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length || from === to) return;
    onChange(moveEntry(entries, from, to));
    setFocusIndex(entries[from]?.index ?? null);
    announce(t('organize.moved', { n: to + 1 }));
  };

  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, position: number) => {
    if (event.target !== event.currentTarget || disabled) return;
    const up = event.key === 'ArrowUp';
    if (event.altKey && (up || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(position, position + (up ? -1 : 1));
    } else if (up || event.key === 'ArrowDown') {
      event.preventDefault();
      const target = entries[position + (up ? -1 : 1)];
      if (target !== undefined) setFocusIndex(target.index);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(position);
    }
  };

  // Pointer drag by the grip: the marker shows where the row would land.
  const overPosition = (clientY: number): number => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    let over = rows.length - 1;
    for (const [position, row] of rows.entries()) {
      const box = row.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) {
        over = position;
        break;
      }
    }
    return Math.max(0, over);
  };
  const startDrag = (event: PointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0 || disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ index, over: overPosition(event.clientY) });
  };
  const dragMove = (event: PointerEvent<HTMLElement>) => {
    if (drag !== null) setDrag({ ...drag, over: overPosition(event.clientY) });
  };
  const endDrag = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    if (drag === null) return;
    const from = entries.findIndex((entry) => entry.index === drag.index);
    const to = overPosition(event.clientY);
    setDrag(null);
    if (commit && from >= 0) move(from, to);
  };

  const tabStop =
    focusIndex !== null && entries.some((entry) => entry.index === focusIndex) ? focusIndex : entries[0]?.index;

  return (
    <div
      ref={list}
      role="listbox"
      aria-label={t('img2pdf.list')}
      aria-orientation="vertical"
      className="relative mt-4 flex max-h-[calc((var(--space-12)+var(--space-2))*5+var(--space-2)*4)] flex-col gap-2 overflow-y-auto"
    >
      {entries.map((entry, position) => {
        const bad = failed.has(entry.index);
        return (
          <div key={entry.index} className="relative">
            {drag !== null && drag.over === position && drag.index !== entry.index && (
              <span aria-hidden="true" className="absolute inset-x-0 -top-1 h-insert-marker rounded-full bg-accent" />
            )}
            <div
              role="option"
              aria-selected={false}
              aria-invalid={bad ? true : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              data-index={entry.index}
              tabIndex={entry.index === tabStop ? 0 : -1}
              onKeyDown={(event) => onRowKey(event, position)}
              className={`flex ${ROW} items-center gap-2 rounded-card border border-divider bg-surface-solid px-2 ${
                drag?.index === entry.index ? 'opacity-60' : ''
              }`}
            >
              <span
                aria-hidden="true"
                onPointerDown={(event) => startDrag(event, entry.index)}
                onPointerMove={dragMove}
                onPointerUp={(event) => endDrag(event, true)}
                onPointerCancel={(event) => endDrag(event, false)}
                className="flex shrink-0 cursor-grab touch-none items-center text-text-muted"
              >
                <Icon icon={GripVertical} />
              </span>
              <span className="flex h-10 w-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-divider bg-page text-error-text forced-colors:border-text">
                {bad ? (
                  <Icon icon={CircleAlert} />
                ) : (
                  <Thumb batch={batch} index={entry.index} onFail={onFail} root={list} />
                )}
              </span>
              <span className="flex min-w-0 flex-auto flex-col">
                <span className="truncate font-semibold">{entry.name}</span>
                <span className={`truncate text-sm ${bad ? 'text-error-text' : 'text-text-muted'}`}>
                  {bad
                    ? t('img2pdf.unreadable')
                    : entry.width > 0 && entry.height > 0
                      ? t('img2pdf.dims', { w: entry.width, h: entry.height })
                      : ''}
                </span>
              </span>
              <IconButton
                size="sm"
                icon={X}
                label={t('img2pdf.remove', { name: entry.name })}
                tabIndex={-1}
                disabled={disabled}
                onClick={() => remove(position)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
