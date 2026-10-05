import type { FloatingKind, Rect } from './position';

/**
 * Protected elements (DESIGN 3.9 Q8). A floating surface may not cover them. They are found, never registered:
 * - `data-protect` on any element (the active tool, the selection handles): protected for every kind.
 * - `data-protect="notice"`: protected for notices only (tips and coach marks).
 * - the focused element when it is an input, textarea, select or contenteditable.
 * - for notices also every visible input, textarea, select, contenteditable, button, `[role=button]` and toolbar item.
 * The anchor is added by the caller. Elements inside the floating surface, inside the anchor or around it are skipped.
 */
const TEXT_FIELDS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const NOTICE_TARGETS = `${TEXT_FIELDS}, button, [role="button"], [data-toolbar-item]`;

function rectOf(element: Element): Rect | null {
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

export function isNotice(kind: FloatingKind): boolean {
  return kind === 'coach' || kind === 'tip';
}

export function protectedRects(kind: FloatingKind, anchor: Element, floating: Element): Rect[] {
  const found = new Set<Element>();
  const add = (element: Element | null) => {
    if (element === null || floating.contains(element) || element.contains(floating)) return;
    found.add(element);
  };
  add(anchor);
  const focused = document.activeElement;
  if (focused !== null && focused.matches(TEXT_FIELDS)) add(focused);
  for (const element of document.querySelectorAll('[data-protect], [data-toolbar-item][aria-pressed="true"]')) {
    if (element.getAttribute('data-protect') !== 'notice' || isNotice(kind)) add(element);
  }
  if (isNotice(kind)) {
    for (const element of document.querySelectorAll(NOTICE_TARGETS)) {
      // The anchor's own children and the elements it sits in are not "other" elements.
      if (anchor.contains(element) || element.contains(anchor)) continue;
      add(element);
    }
  }
  const rects: Rect[] = [];
  for (const element of found) {
    const rect = rectOf(element);
    if (rect !== null) rects.push(rect);
  }
  return rects;
}
