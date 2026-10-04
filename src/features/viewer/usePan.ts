import { useEffect, type RefObject } from 'react';

import { useUi } from '../../stores/ui';
import { effectiveTool, useLesen } from './lesen';

/**
 * The hand (Lesen mode): a drag on the canvas pans its scroll region. The listener runs in the capture phase, so no layer under
 * the pointer (text, annotations, fields, creation tools) sees the gesture while the hand is the tool, active or held with Space.
 * The cursor is `grab`, `grabbing` during the drag.
 */
/** The cursor is set on the DOM node itself, outside React. */
function setCursor(node: HTMLElement, value: string): void {
  node.style.cursor = value;
}

export function usePan(region: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = region.current;
    if (element === null) return;
    const isHand = () => effectiveTool(useUi.getState().activeTool, useLesen.getState().spaceHand) === 'hand';
    let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;

    const cursor = () => {
      setCursor(element, drag !== null ? 'grabbing' : isHand() ? 'grab' : '');
    };
    const stopDrag = () => {
      drag = null;
      cursor();
    };

    const onDown = (event: PointerEvent) => {
      if (!isHand() || event.button !== 0 || !event.isPrimary) return;
      // The scroll bars belong to the region itself.
      const box = element.getBoundingClientRect();
      if (event.clientX - box.left >= element.clientWidth || event.clientY - box.top >= element.clientHeight) return;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        top: element.scrollTop,
      };
      element.setPointerCapture?.(event.pointerId);
      cursor();
    };
    const onMove = (event: PointerEvent) => {
      if (drag === null || event.pointerId !== drag.id) return;
      element.scrollLeft = drag.left - (event.clientX - drag.x);
      element.scrollTop = drag.top - (event.clientY - drag.y);
    };
    const onUp = (event: PointerEvent) => {
      if (drag === null || event.pointerId !== drag.id) return;
      element.releasePointerCapture?.(event.pointerId);
      stopDrag();
    };

    element.addEventListener('pointerdown', onDown, { capture: true });
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    const unsubscribeUi = useUi.subscribe(cursor);
    const unsubscribeLesen = useLesen.subscribe(cursor);
    cursor();
    return () => {
      element.removeEventListener('pointerdown', onDown, { capture: true });
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      unsubscribeUi();
      unsubscribeLesen();
      setCursor(element, '');
    };
  }, [region]);
}
