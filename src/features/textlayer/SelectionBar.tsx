import { motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../../components';
import { usePopoverMotion } from '../../components/motion';
import { overlayOffset } from '../../components/tokens';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { markSelection } from '../annotations/create/fromSelection';
import { onAddComment } from '../../actions/commentIntent';
import { addCommentFromSelection } from './comment';
import { hasTextSelection } from './selection';

/** A text selection settles this long after the pointer was released, or after the last key of a keyboard selection. */
export const POINTER_SETTLE_MS = 150;
export const KEYBOARD_SETTLE_MS = 300;

interface Place {
  left: number;
  top: number;
  /** The bar is below the selection (it did not fit above): it grows from the top. */
  below: boolean;
}

/** The viewport rectangle of the selection (its first and last line), or `null` when it has none. */
function selectionRects(): { first: DOMRect; last: DOMRect } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || !hasTextSelection(selection)) return null;
  const rects = [...selection.getRangeAt(0).getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (first === undefined || last === undefined) return null;
  // The top of the selection is its highest line; the bottom its lowest.
  const top = rects.reduce((a, b) => (b.top < a.top ? b : a), first);
  const bottom = rects.reduce((a, b) => (b.bottom > a.bottom ? b : a), last);
  return { first: top, last: bottom };
}

/** Where the bar goes: 8 above the selection, below it when there is no room, clamped into the canvas inset by 8. */
export function placeBar(
  selection: { first: Pick<DOMRect, 'top' | 'left'>; last: Pick<DOMRect, 'bottom'> },
  canvas: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>,
  bar: { width: number; height: number },
  gap: number,
): Place | null {
  const above = selection.first.top - gap - bar.height;
  const below = selection.last.bottom + gap;
  // Out of the canvas (scrolled away): no bar.
  if (selection.last.bottom < canvas.top || selection.first.top > canvas.bottom) return null;
  const fitsAbove = above >= canvas.top + gap;
  const top = fitsAbove ? above : below;
  const maxLeft = Math.max(canvas.left + gap, canvas.right - gap - bar.width);
  const left = Math.min(Math.max(selection.first.left, canvas.left + gap), maxLeft);
  return { left, top: Math.min(top, Math.max(canvas.top + gap, canvas.bottom - gap - bar.height)), below: !fitsAbove };
}

export interface SelectionBarProps {
  docId: number | null;
  /** The canvas's scrolling region: the bar stays inside it and hides when the selection scrolls out. */
  region: RefObject<HTMLElement | null>;
}

/**
 * The bar over a text selection (DESIGN 3.59 section 1): Highlight, Comment, Copy (DESIGN v2 3.2). It appears when the selection has settled
 * (150 ms after the pointer, 300 ms after the last key), never takes the focus, and hides when the selection goes, the tool changes,
 * Esc is pressed, or the selection scrolls out of the canvas. Primary+Shift+M adds a comment while it shows.
 */
export function SelectionBar({ docId, region }: SelectionBarProps) {
  const t = useT();
  const select = useUi((state) => state.activeTool === 'select');
  const motionProps = usePopoverMotion();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<ReturnType<typeof selectionRects>>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const pointerDown = useRef(false);
  const timer = useRef<number | null>(null);

  const settle = useCallback((delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setRects(selectionRects());
    }, delay);
  }, []);

  useEffect(() => {
    if (!select || docId === null) return;
    const element = region.current;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && barRef.current?.contains(event.target) === true) return;
      pointerDown.current = true;
      // A new gesture starts: the old bar goes.
      setRects(null);
    };
    const onUp = () => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      settle(POINTER_SETTLE_MS);
    };
    const onChange = () => {
      if (pointerDown.current) return;
      if (!hasTextSelection(window.getSelection())) {
        setRects(null);
        return;
      }
      settle(KEYBOARD_SETTLE_MS);
    };
    const onScroll = () => setRects((current) => (current === null ? current : selectionRects()));
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('selectionchange', onChange);
    element?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('selectionchange', onChange);
      element?.removeEventListener('scroll', onScroll);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [select, docId, region, settle]);

  // Esc at the selection level hides the bar (the text keys clear the selection too).
  useEffect(() => {
    if (rects === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRects(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rects]);

  const add = useCallback(() => {
    if (docId === null) return;
    setRects(null);
    void addCommentFromSelection(docId);
  }, [docId]);

  // Edit → Add comment and Primary+Shift+M arrive through the action registry (DESIGN 3.56); they act on any text selection.
  useEffect(() => {
    if (docId === null) return;
    return onAddComment(() => {
      if (hasTextSelection(window.getSelection())) add();
    });
  }, [docId, add]);

  // The place needs the bar's own size, so it is measured once the bar is in the page.
  useLayoutEffect(() => {
    const canvas = region.current?.getBoundingClientRect();
    const bar = barRef.current;
    if (rects === null || canvas === undefined || bar === null) {
      setPlace(null);
      return;
    }
    setPlace(placeBar(rects, canvas, { width: bar.offsetWidth, height: bar.offsetHeight }, overlayOffset()));
  }, [rects, region]);

  if (!select || docId === null || rects === null) return null;
  const hidden = place === null;
  return createPortal(
    <motion.div
      {...motionProps}
      ref={barRef}
      role="toolbar"
      aria-label={t('comments.selectionBar')}
      // The bar is placed after it is measured; until then it is invisible, never shown in the wrong place.
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: hidden ? 'hidden' : 'visible',
        transformOrigin: place?.below === true ? 'top left' : 'bottom left',
      }}
      // Taking a pointer on the bar must not collapse the selection it acts on.
      onPointerDown={(event) => event.preventDefault()}
      className="bg-panel border border-border-subtle shadow-floating fixed z-popover flex h-control-md items-center gap-1 rounded-md p-1 text-md text-text"
    >
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setRects(null);
          void markSelection(docId, 'highlight');
        }}
      >
        {t('selection.mark')}
      </Button>
      <Button size="sm" variant="ghost" aria-keyshortcuts="Control+Shift+M Meta+Shift+M" onClick={add}>
        {t('selection.comment')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          // The `copy` event puts the page's own text on the clipboard (`copySelection`).
          if (!document.execCommand('copy')) {
            void navigator.clipboard?.writeText(window.getSelection()?.toString() ?? '').catch(() => undefined);
          }
          setRects(null);
        }}
      >
        {t('selection.copy')}
      </Button>
    </motion.div>,
    document.body,
  );
}
