import { DURATION, EASE_OUT, ENTER_SCALE } from '../../lib/motion';

/** What the last pass saw: the stacked top of every mounted bubble, the thread ids that existed, and the geometry it was laid out in. */
export interface RestackState {
  tops: Map<number, number>;
  ids: Set<number>;
  /** Changes with zoom, page width, rotation or column mode: those move bubbles with the page and are never animated. */
  key: string | null;
}

export const newRestackState = (): RestackState => ({ tops: new Map(), ids: new Set(), key: null });

const running = new WeakMap<Element, Animation>();

/**
 * Bubble re-stack (MOTION spell 22, FLIP): after a render, a mounted bubble whose stacked top moved (another was selected, added,
 * resized or resolved) slides from its old position with `translateY` over `--motion-base`; a bubble whose thread is new fades in
 * from 0.98 over `--motion-slow`. A scroll or zoom (`key` changes) and bubbles that only scrolled into the mounted window are
 * recorded, never animated. A move that interrupts another retargets from where the bubble is on screen. Reduced motion: bubbles
 * jump and a new one fades in over `--motion-fast`. Elements are `[data-item]` with `data-top`.
 */
export function restack(
  root: HTMLElement,
  state: RestackState,
  key: string,
  threadIds: readonly number[],
  reduce: boolean,
): void {
  const animatable = state.key === key;
  const tops = new Map<number, number>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-item]')) {
    const id = Number(element.dataset.item);
    const top = Number(element.dataset.top);
    if (!Number.isFinite(id) || !Number.isFinite(top) || typeof element.animate !== 'function') continue;
    tops.set(id, top);
    if (!animatable) continue;
    const before = state.tops.get(id);
    const live = running.get(element);
    if (before === undefined) {
      if (state.ids.has(id)) continue;
      live?.cancel();
      const frames = reduce
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: `scale(${ENTER_SCALE})` },
            { opacity: 1, transform: 'scale(1)' },
          ];
      const seconds = reduce ? DURATION.fast : DURATION.slow;
      running.set(
        element,
        element.animate(frames, { duration: seconds * 1000, easing: `cubic-bezier(${EASE_OUT.join(', ')})` }),
      );
      continue;
    }
    if (reduce) continue;
    // Where it is drawn right now (an animation may be under way), against where it is laid out.
    let residual = 0;
    if (live !== undefined) {
      const drawn = element.getBoundingClientRect().top;
      live.cancel();
      residual = drawn - element.getBoundingClientRect().top;
    }
    const delta = before - top + residual;
    if (Math.abs(delta) < 0.5) continue;
    const animation = element.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
      duration: DURATION.base * 1000,
      easing: `cubic-bezier(${EASE_OUT.join(', ')})`,
    });
    running.set(element, animation);
  }
  state.tops = tops;
  state.ids = new Set(threadIds);
  state.key = key;
}
