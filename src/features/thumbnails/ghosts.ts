import { useLayoutEffect, useRef, useState } from 'react';

import { tokenMs } from './motion';

/** At most this many removed pages leave a ghost at once: a delete of hundreds of pages needs no hundred fading cards. */
export const MAX_GHOSTS = 24;

export interface Ghost<T> {
  /** The removed page's id. */
  id: number;
  data: T;
}

/**
 * MOTION spell 9: the pages that left `slots` since the last render, each as a ghost for `--motion-base-exit`. `describe` is
 * called with the slot and its place before the change, by the closure of the render that still had it (its old layout), and
 * returns what the ghost is drawn from, or `null` for none. A page that comes back (undo) loses its ghost at once.
 */
export function useDeleteGhosts<S extends { id: number }, T>(
  slots: readonly S[],
  describe: (slot: S, index: number) => T | null,
): { ghosts: readonly Ghost<T>[]; moving: boolean } {
  const [ghosts, setGhosts] = useState<readonly Ghost<T>[]>([]);
  /** The neighbours slide for `--motion-base` after a removal: the list's cells transition their position only then. */
  const [moving, setMoving] = useState(false);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const before = useRef<{ slots: readonly S[]; describe: (slot: S, index: number) => T | null } | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Every render: the closure of the render that still had the pages is what `describe` is made from.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = { slots, describe };
    if (previous === null || previous.slots === slots) return;
    const alive = new Set(slots.map((slot) => slot.id));
    const gone: Ghost<T>[] = [];
    previous.slots.forEach((slot, index) => {
      if (alive.has(slot.id) || gone.length >= MAX_GHOSTS) return;
      const data = previous.describe(slot, index);
      if (data !== null) gone.push({ id: slot.id, data });
    });
    setGhosts((current) => {
      const kept = current.filter((ghost) => !alive.has(ghost.id) && !gone.some((g) => g.id === ghost.id));
      if (gone.length === 0 && kept.length === current.length) return current;
      return [...kept, ...gone];
    });
    if (gone.length === 0) return;
    setMoving(true);
    if (moveTimer.current !== null) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(
      () => {
        moveTimer.current = null;
        setMoving(false);
      },
      tokenMs('--motion-base', 160),
    );
    const ids = new Set(gone.map((ghost) => ghost.id));
    const timer = setTimeout(
      () => {
        timers.current.delete(timer);
        setGhosts((current) => current.filter((ghost) => !ids.has(ghost.id)));
      },
      tokenMs('--motion-base-exit', 120),
    );
    timers.current.add(timer);
  });

  useLayoutEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
      if (moveTimer.current !== null) clearTimeout(moveTimer.current);
    },
    [],
  );
  return { ghosts, moving };
}
