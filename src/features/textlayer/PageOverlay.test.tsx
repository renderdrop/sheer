// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TextLayer } from '../../api/text';
import type { Quad } from '../../api/wire';
import { useSearch } from '../search/store';
import { PageOverlay, type PageOverlayProps } from './PageOverlay';

const TEXT = 'Hello world';
function layer(): TextLayer {
  const boxes: number[] = [];
  for (let i = 0; i < TEXT.length; i += 1) boxes.push(10 + 6 * i, 20, 6, 12);
  return { text: TEXT, boxes: Float32Array.from(boxes), truncated: false };
}

const props = (overrides: Partial<PageOverlayProps> = {}): PageOverlayProps => ({
  docId: 1,
  pageIndex: 0,
  boxWidth: 200,
  boxHeight: 400,
  widthPt: 100,
  heightPt: 200,
  rotation: 0,
  layer: layer(),
  interactive: true,
  ...overrides,
});

const quad = (x: number): Quad => [
  { x, y: 20 },
  { x: x + 30, y: 20 },
  { x, y: 32 },
  { x: x + 30, y: 32 },
];

beforeEach(() => {
  useSearch.setState({ byDoc: {}, focusRequest: 0 });
});
afterEach(() => {
  useSearch.setState({ byDoc: {}, focusRequest: 0 });
});

const wrapper = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('PageOverlay', () => {
  it('is the unrotated page in points, scaled to the box: spans are placed with the coordinates Rust reports', () => {
    const { container } = render(<PageOverlay {...props()} />);
    const box = wrapper(container);
    expect(box.style.width).toBe('100px');
    expect(box.style.height).toBe('200px');
    expect(box.style.transform).toBe('scale(2)');
    expect(box.style.transformOrigin).toBe('center');
    expect(box.style.getPropertyValue('--page-scale')).toBe('2');
    const span = container.querySelector<HTMLElement>('[data-run-start="0"]');
    expect(span?.textContent).toBe(TEXT);
    expect(span?.dataset.runEnd).toBe(String(TEXT.length));
    expect(span?.style.left).toBe('10px');
    expect(span?.style.top).toBe('20px');
    expect(span?.style.color).toBe('transparent');
  });

  it('turns with the view: a quarter turn swaps the box and rotates the layer about its centre', () => {
    // The page 100 x 200 pt shown at 2 px/pt and turned: the box is 400 x 200 px.
    const { container } = render(<PageOverlay {...props({ rotation: 90, boxWidth: 400, boxHeight: 200 })} />);
    const box = wrapper(container);
    expect(box.style.transform).toBe('rotate(90deg) scale(2)');
    expect(box.style.left).toBe('150px');
    expect(box.style.top).toBe('0px');
    // Spans stay in page space: the same numbers as upright.
    expect(container.querySelector<HTMLElement>('[data-run-start="0"]')?.style.left).toBe('10px');
  });

  it('takes the pointer only while the Select tool is active', () => {
    const { container, rerender } = render(<PageOverlay {...props()} />);
    const text = () => container.querySelector<HTMLElement>('[data-text-layer]');
    expect(text()?.style.pointerEvents).toBe('auto');
    expect(text()?.dataset.textPage).toBe('0');
    expect(text()?.dataset.textLength).toBe(String(TEXT.length));
    rerender(<PageOverlay {...props({ interactive: false })} />);
    expect(text()?.style.pointerEvents).toBe('none');
    expect(wrapper(container).className).toContain('pointer-events-none');
  });

  it('has no text layer, and is hidden from assistive technology, until the text is there', () => {
    const { container } = render(<PageOverlay {...props({ layer: null })} />);
    expect(container.querySelector('[data-text-layer]')).toBeNull();
    expect(wrapper(container).getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the runs in content order and keeps the page text as a text node, never markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const boxes = Float32Array.from(Array.from({ length: evil.length }, (_, i) => [10 + 6 * i, 20, 6, 12]).flat());
    const { container } = render(<PageOverlay {...props({ layer: { text: evil, boxes, truncated: false } })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-text-layer]')?.textContent).toBe(evil);
  });

  it('draws the hits of its own page below the text, the active one marked, and nothing for other pages', () => {
    const { container } = render(<PageOverlay {...props()} />);
    expect(container.querySelector('[data-search-hit]')).toBeNull();
    const hit = (index: number, page: number, x: number) => ({ index, page, quads: [quad(x)] });
    const hits = [hit(0, 0, 10), hit(1, 0, 50), hit(2, 3, 10)];
    act(() => {
      useSearch.setState({
        byDoc: {
          1: {
            text: 'x',
            matchCase: false,
            wholeWord: false,
            status: 'done',
            runId: 1,
            ran: 'x',
            hits,
            pageHits: { 0: [hits[0]!, hits[1]!], 3: [hits[2]!] },
            pageCount: 2,
            truncated: false,
            progress: null,
            active: 1,
            stepped: true,
            error: null,
          },
        },
      });
    });
    const marks = [...container.querySelectorAll<HTMLElement>('[data-search-hit]')];
    expect(marks.map((mark) => mark.dataset.searchHit)).toEqual(['hit', 'active']);
    expect(marks[1]?.style.left).toBe('50px');
    expect(marks[1]?.style.width).toBe('30px');
    // The hits come before the text in the DOM, so they are below its spans.
    const all = [...wrapper(container).children];
    expect(all[0]?.querySelector('[data-search-hit]')).not.toBeNull();
    expect(all[1]?.hasAttribute('data-text-layer')).toBe(true);
  });
});
