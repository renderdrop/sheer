import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useUi } from '../../stores/ui';
import { useLesen } from './lesen';
import { animationsOff } from './zoomMotion';

/** The lens: a circle of this diameter in CSS px (MOTION spell 13), showing the page at this many times its size. */
export const LENS_SIZE = 160;
export const LENS_ZOOM = 2;

/** Where the page content sits inside the lens so that the page point (`x`, `y`) is at its centre. */
export function lensOffset(x: number, y: number): { x: number; y: number } {
  return { x: LENS_SIZE / 2 - x * LENS_ZOOM, y: LENS_SIZE / 2 - y * LENS_ZOOM };
}

/** The page and the pointer's place on it, `null` where the pointer is not on a page. */
function pageAt(element: Element | null, clientX: number, clientY: number) {
  const page = element?.closest<HTMLElement>('[data-page]') ?? null;
  if (page === null) return null;
  const box = page.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { page, box, x: clientX - box.left, y: clientY - box.top };
}

/** A copy of the page's bitmaps (the surface: the image, its stand-in and its tiles), shown at full opacity and without a fade. */
function cloneBitmaps(page: HTMLElement): HTMLElement | null {
  const surface = page.firstElementChild;
  if (!(surface instanceof HTMLElement) || surface.querySelector('img') === null) return null;
  const copy = surface.cloneNode(true) as HTMLElement;
  for (const image of copy.querySelectorAll('img')) {
    image.style.opacity = '1';
    image.style.transition = 'none';
    image.style.willChange = '';
  }
  copy.querySelectorAll('[role], [aria-label]').forEach((node) => node.removeAttribute('role'));
  return copy;
}

/** What identifies the bitmaps shown: when it changes the lens's copy is made anew (a sharper image or tile arrived). */
function bitmapKey(page: HTMLElement): string {
  const surface = page.firstElementChild;
  if (!(surface instanceof HTMLElement)) return '';
  const sources: string[] = [];
  for (const image of surface.querySelectorAll('img')) sources.push(image.currentSrc || image.src);
  return `${page.dataset.page ?? ''}|${Math.round(page.offsetWidth)}x${Math.round(page.offsetHeight)}|${sources.join(',')}`;
}

/**
 * The magnifier (Lesen mode, MOTION spell 13): a round lens with the page at 2x under the pointer. It shows while the Magnifier
 * tool is active and the pointer is over a page, and anywhere over the canvas while Z is held. It follows the pointer in the
 * same event (no easing) by moving one transform, and is drawn from copies of the bitmaps the page already shows, tiles
 * included, so a move asks the engine for nothing. It is decoration: `aria-hidden`, no pointer events.
 */
export function Magnifier({ region }: { region: RefObject<HTMLElement | null> }) {
  const tool = useUi((state) => state.activeTool);
  const zHeld = useLesen((state) => state.zHeld);
  const spaceHand = useLesen((state) => state.spaceHand);
  const reduce = useReducedMotion() === true || animationsOff();
  const lens = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const armed = (tool === 'magnifier' || zHeld) && !spaceHand;

  useEffect(() => {
    const element = region.current;
    const lensElement = lens.current;
    const holder = content.current;
    if (!armed || element === null || lensElement === null || holder === null) return;
    let shown = '';
    let visible = false;
    const show = (on: boolean) => {
      if (on === visible) return;
      visible = on;
      lensElement.style.opacity = on ? '1' : '0';
      lensElement.style.transition = reduce
        ? 'none'
        : `opacity var(${on ? '--motion-fast' : '--motion-fast-exit'}) var(--ease-out)`;
    };
    const update = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX < box.left + element.clientWidth &&
        event.clientY >= box.top &&
        event.clientY < box.top + element.clientHeight;
      const hit = inside
        ? pageAt(document.elementFromPoint(event.clientX, event.clientY), event.clientX, event.clientY)
        : null;
      // The tool shows the lens over a page only; Z holds it anywhere on the canvas.
      if (!inside || (hit === null && !useLesen.getState().zHeld)) {
        show(false);
        return;
      }
      lensElement.style.transform = `translate(${event.clientX - LENS_SIZE / 2}px, ${event.clientY - LENS_SIZE / 2}px)`;
      if (hit === null) {
        holder.replaceChildren();
        shown = '';
      } else {
        const key = bitmapKey(hit.page);
        if (key !== shown) {
          shown = key;
          holder.replaceChildren();
          const copy = cloneBitmaps(hit.page);
          if (copy !== null) {
            const page = document.createElement('div');
            page.className = 'absolute left-0 top-0 bg-page';
            page.style.width = `${hit.page.offsetWidth}px`;
            page.style.height = `${hit.page.offsetHeight}px`;
            page.style.transformOrigin = '0 0';
            page.dataset.lensPage = '';
            page.append(copy);
            holder.append(page);
          }
        }
        const page = holder.firstElementChild;
        if (page instanceof HTMLElement) {
          // The page's own px: the box on screen may be scaled by a zoom in flight, its layout size is what the copy has.
          const sx = hit.page.offsetWidth / hit.box.width;
          const at = lensOffset(hit.x * sx, hit.y * sx);
          page.style.transform = `translate(${at.x}px, ${at.y}px) scale(${LENS_ZOOM})`;
        }
      }
      show(true);
    };
    const leave = () => show(false);
    const onLeaveDocument = (event: MouseEvent) => {
      if (event.relatedTarget === null) show(false);
    };
    window.addEventListener('pointermove', update, { passive: true });
    element.addEventListener('pointerleave', leave);
    document.addEventListener('mouseout', onLeaveDocument);
    return () => {
      window.removeEventListener('pointermove', update);
      element.removeEventListener('pointerleave', leave);
      document.removeEventListener('mouseout', onLeaveDocument);
      lensElement.style.opacity = '0';
      holder.replaceChildren();
    };
  }, [armed, region, reduce]);

  return createPortal(
    <div
      ref={lens}
      aria-hidden="true"
      data-magnifier=""
      className="pointer-events-none fixed left-0 top-0 z-drag overflow-hidden rounded-full border border-solid bg-page-area shadow-floating"
      style={{
        width: LENS_SIZE,
        height: LENS_SIZE,
        opacity: 0,
        borderColor: 'var(--color-ink)',
        boxSizing: 'border-box',
      }}
    >
      <div ref={content} className="absolute inset-0" />
    </div>,
    document.body,
  );
}
