import { useLayoutEffect, type RefObject } from 'react';

/**
 * Lets a textarea grow with its text (DESIGN 3.25: 3 to 10 lines, then it scrolls). The line limits are CSS (`minHeight`, `maxHeight`
 * in `lh`); this sets the height to the content and the CSS clamps it.
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
    // Scrolls only when the CSS max height clamps it (no scrollbar stub below that).
    element.style.overflowY = element.scrollHeight > element.clientHeight + 1 ? 'auto' : 'hidden';
  }, [ref, value]);
}
