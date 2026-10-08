// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { anchorRect, relevant } from './useFloatingPosition';

const box = (left: number, top: number, width: number, height: number): DOMRect =>
  new DOMRect(left, top, width, height);

/** Builds `<tag attrs>` children into the body without markup strings. */
function el(tag: string, attrs: Record<string, string>, ...children: Node[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('anchorRect', () => {
  it('measures the gap of a control in the mini bar from the bar edge', () => {
    const button = el('button', {});
    document.body.append(el('div', { 'data-minibar': '' }, button));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'BUTTON' ? box(20, 106, 24, 24) : box(0, 100, 200, 36);
    });
    const result = anchorRect(button);
    expect(result.left).toBe(20);
    expect(result.width).toBe(24);
    expect(result.top).toBe(100);
    expect(result.bottom).toBe(136);
  });

  it('leaves any other anchor alone', () => {
    const button = el('button', {});
    document.body.append(el('div', {}, button));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box(20, 106, 24, 24));
    expect(anchorRect(button).top).toBe(106);
  });
});

describe('relevant', () => {
  it('ignores changes inside the canvas, notices the rest and bursts', () => {
    const page = el('span', {});
    const banner = el('div', {});
    document.body.append(el('div', { 'data-action-scope': 'canvas' }, el('div', { role: 'region' }, page)), banner);
    expect(relevant([{ target: page }])).toBe(false);
    expect(relevant([{ target: page }, { target: banner }])).toBe(true);
    expect(relevant(Array.from({ length: 60 }, () => ({ target: page })))).toBe(true);
  });

  it('re-tests on an attribute-only change of a banner', async () => {
    const seen: boolean[] = [];
    const banner = el('div', {});
    document.body.append(banner);
    const observer = new MutationObserver((records) => seen.push(relevant(records)));
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    banner.className = 'open';
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    expect(seen).toEqual([true]);
  });
});
