// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { protectedRects } from './protect';

/** jsdom has no layout: give an element a box. */
function box(element: HTMLElement, left: number, top: number, width = 40, height = 20): HTMLElement {
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('protectedRects', () => {
  it('protects the anchor, data-protect elements and pressed toggle buttons for a popover', () => {
    const anchor = box(document.createElement('button'), 0, 0);
    const pressed = box(document.createElement('button'), 100, 0);
    pressed.setAttribute('aria-pressed', 'true');
    const idle = box(document.createElement('button'), 200, 0);
    idle.setAttribute('aria-pressed', 'false');
    const tool = box(document.createElement('div'), 300, 0);
    tool.setAttribute('data-protect', '');
    document.body.append(anchor, pressed, idle, tool);
    const rects = protectedRects('popover', anchor, document.createElement('div'));
    expect(rects.map((r) => r.left).sort((a, b) => a - b)).toEqual([0, 100, 300]);
  });

  it('protects only the anchor of a menu opened from the menu bar (OS menu convention)', () => {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'menubar');
    const anchor = box(document.createElement('button'), 0, 0);
    bar.append(anchor);
    const pressed = box(document.createElement('button'), 100, 0);
    pressed.setAttribute('aria-pressed', 'true');
    document.body.append(bar, pressed);
    expect(protectedRects('menu', anchor, document.createElement('div'))).toHaveLength(1);
    // Any other menu still avoids the active tool.
    const plain = box(document.createElement('button'), 0, 50);
    document.body.append(plain);
    expect(protectedRects('menu', plain, document.createElement('div'))).toHaveLength(2);
  });
});

describe('selection protection', () => {
  it('protects a selected annotation frame and its handles for a popover, not an unselected frame', () => {
    const anchor = box(document.createElement('button'), 0, 0);
    const frame = box(document.createElement('div'), 100, 100);
    frame.setAttribute('data-annot-frame', '1');
    frame.setAttribute('aria-pressed', 'true');
    const handle = box(document.createElement('span'), 90, 90, 8, 8);
    handle.setAttribute('data-annot-handle', 'nw');
    const other = box(document.createElement('div'), 300, 100);
    other.setAttribute('data-annot-frame', '2');
    other.setAttribute('aria-pressed', 'false');
    document.body.append(anchor, frame, handle, other);
    const rects = protectedRects('popover', anchor, document.createElement('div'));
    expect(rects.map((r) => r.left).sort((a, b) => a - b)).toEqual([0, 90, 100]);
  });
});
