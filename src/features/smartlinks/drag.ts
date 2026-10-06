import { useEffect } from 'react';
import { create } from 'zustand';

import { isDrag } from './model';

/**
 * Whether a text selection is being dragged (DESIGN 3.11 L9: links are hidden meanwhile). A press on the page that moves
 * `DRAG_PX` or more with the primary button down starts it; the release ends it. One set of window listeners serves every page.
 */
export const useSelectionDrag = create<{ dragging: boolean }>()(() => ({ dragging: false }));

let users = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  let down: { x: number; y: number } | null = null;
  const end = () => {
    down = null;
    if (useSelectionDrag.getState().dragging) useSelectionDrag.setState({ dragging: false });
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const inText = event.target instanceof Element && event.target.closest('[data-text-page]') !== null;
    down = inText ? { x: event.clientX, y: event.clientY } : null;
  };
  const onMove = (event: PointerEvent) => {
    if (down === null || (event.buttons & 1) === 0) return;
    if (!useSelectionDrag.getState().dragging && isDrag(down, { x: event.clientX, y: event.clientY })) {
      useSelectionDrag.setState({ dragging: true });
    }
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  window.addEventListener('blur', end);
  return () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    window.removeEventListener('blur', end);
    end();
  };
}

/** Keeps the listeners of the drag tracker while a layer that needs them is mounted. */
export function useTrackSelectionDrag(): boolean {
  useEffect(() => {
    users += 1;
    if (users === 1) stop = start();
    return () => {
      users -= 1;
      if (users === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
  return useSelectionDrag((state) => state.dragging);
}
