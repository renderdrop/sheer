import { useEffect, useState, type RefObject } from 'react';

/** A box in the px of its origin element. */
export interface TrackedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The box of `target` relative to `origin`, both read from the layout right now; `null` for an element that is not laid out. */
export function relativeRect(target: Element, origin: Element): TrackedRect | null {
  const t = target.getBoundingClientRect();
  if (t.width === 0 && t.height === 0) return null;
  const o = origin.getBoundingClientRect();
  return { left: t.left - o.left, top: t.top - o.top, width: t.width, height: t.height };
}

const same = (a: TrackedRect | null, b: TrackedRect | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

/**
 * Where the element matching `selector` is, relative to `origin`, always from the current geometry (F19.24 c): nothing is cached
 * between reads. It is read again, once per frame, on scroll (any scroller), window resize, size changes of the origin, its scroll
 * region and the element, and nodes added to or removed from the region (a page that was drawn after the frame was asked for).
 * `null` while there is no selector or no such element.
 */
export function useTrackedRect(origin: RefObject<HTMLElement | null>, selector: string | null): TrackedRect | null {
  const [rect, setRect] = useState<TrackedRect | null>(null);
  useEffect(() => {
    const root = origin.current;
    if (selector === null || root === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to track: the frame goes
      setRect((old) => (old === null ? old : null));
      return;
    }
    const region = root.closest<HTMLElement>('[role="region"]') ?? root;
    let frame = 0;
    let observed: Element | null = null;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
    const read = () => {
      frame = 0;
      const target = document.querySelector(selector);
      if (target !== observed) {
        if (observed !== null) resize?.unobserve(observed);
        if (target !== null) resize?.observe(target);
        observed = target;
      }
      const next = target === null ? null : relativeRect(target, root);
      setRect((old) => (same(old, next) ? old : next));
    };
    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(read);
    }
    read();
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    resize?.observe(root);
    if (region !== root) resize?.observe(region);
    const mutation = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    mutation?.observe(region, { childList: true, subtree: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [origin, selector]);
  return rect;
}
