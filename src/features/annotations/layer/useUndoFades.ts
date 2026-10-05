import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Annotation } from '../../../api/annotations';
import { onUndoCue } from '../../../stores/undoCue';
import { tokenMs } from '../../thumbnails/motion';

export interface UndoFades {
  /** Items an undo removed: drawn as ghosts, fading out. */
  leaving: readonly Annotation[];
  /** Ids of items an undo or a redo brought back: they fade in. */
  entering: ReadonlySet<number>;
}

const NONE: UndoFades = { leaving: [], entering: new Set() };

/** What one page's layer fades (MOTION spell 7); an external store, so that the render that shows a change already knows of it. */
class FadeStore {
  snapshot: UndoFades = NONE;
  list: readonly Annotation[] = [];
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly get = (): UndoFades => this.snapshot;
  setList(list: readonly Annotation[]): void {
    this.list = list;
  }
  set(next: UndoFades): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The fades of undo and redo on page `pageIndex` of `docId`: an item the undo removes stays as a ghost for `--motion-fast-exit`
 * and fades out, an item a redo (or the undo of a delete) brings back fades in over `--motion-fast`. A plain command is no cue.
 * `list` is the page's annotations as drawn now (what a ghost is made from).
 */
export function useUndoFades(docId: number, pageIndex: number, list: readonly Annotation[]): UndoFades {
  const [store] = useState(() => new FadeStore());
  useEffect(() => {
    store.setList(list);
  }, [store, list]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onUndoCue((cueDoc, _kind, changes) => {
      if (cueDoc !== docId) return;
      const before = store.list;
      const lost = before.filter(
        (a) => changes.removed.includes(a.id) && a.sync !== 'clean' && a.state === undefined && a.kind !== 'opaque',
      );
      const back = changes.upserted.filter((a) => a.pageId === pageIndex && !before.some((b) => b.id === a.id));
      if (lost.length === 0 && back.length === 0) return;
      const lostIds = new Set(lost.map((a) => a.id));
      const backIds = new Set(back.map((a) => a.id));
      store.set({
        leaving: [...store.snapshot.leaving, ...lost],
        entering: new Set([...store.snapshot.entering, ...backIds]),
      });
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          store.set({
            leaving: store.snapshot.leaving.filter((a) => !lostIds.has(a.id)),
            entering: new Set([...store.snapshot.entering].filter((id) => !backIds.has(id))),
          });
        },
        Math.max(tokenMs('--motion-fast', 120), tokenMs('--motion-fast-exit', 80)),
      );
      timers.add(timer);
    });
    return () => {
      off();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [store, docId, pageIndex]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
