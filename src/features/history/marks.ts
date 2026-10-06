import { create } from 'zustand';

import type { Rect } from './store';

/** A transient mark on a page: the target band of a jump (L6) or the outline of the origin run after a return (L7). */
export interface Mark {
  kind: 'band' | 'origin';
  docId: number;
  pageId: number;
  /** View-space page points (rotation applied), top-left origin. */
  rect: Rect;
  /** Counts up: a new mark restarts the pulse. */
  nonce: number;
  /** The hold is over: the mark fades out. */
  fading: boolean;
}

/** The band's hold (L6), the outline's hold (`--hold-outline`) and `--motion-fast-exit`, in ms. */
export const BAND_HOLD_MS = 1200;
export const OUTLINE_HOLD_MS = 1000;
export const FADE_MS = 80;

interface MarkState {
  mark: Mark | null;
}

export const useMarks = create<MarkState>()(() => ({ mark: null }));

let nonce = 0;
let timers: number[] = [];

function clearTimers(): void {
  for (const timer of timers) window.clearTimeout(timer);
  timers = [];
}

/** Shows a mark and takes it away again: held, then faded out. One mark at a time; a newer one replaces it. */
export function showMark(kind: Mark['kind'], docId: number, pageId: number, rect: Rect): void {
  clearTimers();
  nonce += 1;
  const mine = nonce;
  useMarks.setState({ mark: { kind, docId, pageId, rect, nonce: mine, fading: false } });
  const hold = kind === 'band' ? BAND_HOLD_MS : OUTLINE_HOLD_MS;
  timers.push(
    window.setTimeout(() => {
      const current = useMarks.getState().mark;
      if (current?.nonce === mine) useMarks.setState({ mark: { ...current, fading: true } });
    }, hold),
    window.setTimeout(() => {
      if (useMarks.getState().mark?.nonce === mine) useMarks.setState({ mark: null });
    }, hold + FADE_MS),
  );
}

export function clearMark(): void {
  clearTimers();
  useMarks.setState({ mark: null });
}
