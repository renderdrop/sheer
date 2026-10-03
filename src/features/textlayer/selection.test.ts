// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { buildRuns } from './runs';
import { hasTextSelection, resolveBoundary, selectPageText, selectionText, textBetween } from './selection';

const PAGES = ['Alpha beta\r\ngamma', 'Delta', 'Epsilon zeta'];
const textOf = (page: number) => PAGES[page];

describe('textBetween', () => {
  it('slices one page and writes the layout breaks as newlines', () => {
    expect(textBetween({ page: 0, index: 6 }, { page: 0, index: 17 }, textOf)).toBe('beta\ngamma');
  });

  it('is the same whichever end comes first', () => {
    expect(textBetween({ page: 0, index: 17 }, { page: 0, index: 6 }, textOf)).toBe('beta\ngamma');
    expect(textBetween({ page: 2, index: 3 }, { page: 0, index: 7 }, textOf)).toBe(
      textBetween({ page: 0, index: 7 }, { page: 2, index: 3 }, textOf),
    );
  });

  it('joins the pages between with line breaks and skips a page it does not know', () => {
    expect(textBetween({ page: 0, index: 12 }, { page: 2, index: 3 }, textOf)).toBe('gamma\nDelta\nEps');
    expect(
      textBetween({ page: 0, index: 12 }, { page: 2, index: 3 }, (page) => (page === 1 ? undefined : PAGES[page])),
    ).toBe('gamma\nEps');
  });
});

/** The DOM a layer renders for a page: spans with their run ranges. */
function mountLayer(page: number, text: string): HTMLElement {
  const layer = document.createElement('div');
  layer.setAttribute('data-text-layer', '');
  layer.dataset.textPage = String(page);
  layer.dataset.textLength = String(text.length);
  for (const run of buildRuns({ text, boxes: boxesFor(text) })) {
    const span = document.createElement('span');
    span.dataset.runStart = String(run.start);
    span.dataset.runEnd = String(run.end);
    span.textContent = run.text;
    layer.append(span);
  }
  document.body.append(layer);
  return layer;
}

function boxesFor(text: string): Float32Array {
  const boxes: number[] = [];
  let row = 0;
  let x = 0;
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      boxes.push(x, row * 14, 0, 0);
      if (char === '\n') {
        row += 1;
        x = 0;
      }
      continue;
    }
    boxes.push(x, row * 14, 6, 12);
    x += 6;
  }
  return Float32Array.from(boxes);
}

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe('selection to text', () => {
  it('places a boundary in a text node, an element and the layer', () => {
    const layer = mountLayer(1, PAGES[0] as string);
    const [first, second] = [...layer.children];
    expect(resolveBoundary(first?.firstChild as Node, 3)).toEqual({ page: 1, index: 3 });
    expect(resolveBoundary(second as Node, 0)).toEqual({ page: 1, index: 12 });
    expect(resolveBoundary(second as Node, 1)).toEqual({ page: 1, index: 17 });
    expect(resolveBoundary(layer, 1)).toEqual({ page: 1, index: 12 });
    expect(resolveBoundary(layer, 2)).toEqual({ page: 1, index: 17 });
    expect(resolveBoundary(document.body, 0)).toBeNull();
  });

  it('copies the characters between the boundaries, with the line break of the page', () => {
    const layer = mountLayer(0, PAGES[0] as string);
    const [first, second] = [...layer.children];
    const selection = window.getSelection() as Selection;
    selection.setBaseAndExtent(first?.firstChild as Node, 6, second?.firstChild as Node, 3);
    expect(selectionText(selection, textOf)).toBe('beta\ngam');
    expect(hasTextSelection(selection)).toBe(true);
  });

  it('copies across two pages in page order', () => {
    const one = mountLayer(0, PAGES[0] as string);
    const two = mountLayer(1, PAGES[1] as string);
    const selection = window.getSelection() as Selection;
    selection.setBaseAndExtent(one.children[1]?.firstChild as Node, 2, two.children[0]?.firstChild as Node, 2);
    expect(selectionText(selection, textOf)).toBe('mma\nDe');
  });

  it('leaves a selection outside the text layers to the browser', () => {
    mountLayer(0, 'abc');
    const outside = document.createElement('p');
    outside.textContent = 'plain';
    document.body.append(outside);
    const selection = window.getSelection() as Selection;
    selection.selectAllChildren(outside);
    expect(selectionText(selection, textOf)).toBeNull();
    expect(hasTextSelection(selection)).toBe(false);
    selection.removeAllRanges();
    expect(selectionText(selection, textOf)).toBeNull();
  });

  it('selects all the text of one page only', () => {
    mountLayer(0, 'abc');
    const two = mountLayer(1, 'def');
    const selection = window.getSelection() as Selection;
    expect(selectPageText(document.body, 1, selection)).toBe(true);
    expect(selection.getRangeAt(0).commonAncestorContainer).toBe(two);
    expect(selectPageText(document.body, 7, selection)).toBe(false);
    expect(selectPageText(document.body, 1, null)).toBe(false);
  });
});
