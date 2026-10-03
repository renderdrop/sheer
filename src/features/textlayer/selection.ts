/**
 * From a DOM selection to the text it covers (DESIGN 3.17). The spans of a text layer carry the UTF-16 range of their run
 * (`data-run-start`, `data-run-end`) and the layer its page (`data-text-page`) and the length of its text, so a selection boundary is
 * a character index of a page's text. Copying slices that text, which still has the page's line breaks, rather than reading the DOM
 * (whose spans have none), and runs in content order whatever the screen geometry is, rotated or not.
 */

export const LAYER_ATTRIBUTE = 'data-text-layer';
export const LAYER_SELECTOR = `[${LAYER_ATTRIBUTE}]`;

/** A place in a page's text: a UTF-16 offset. */
export interface TextPoint {
  page: number;
  index: number;
}

/**
 * How page ids sit in the document (ADR-036): the text layers are named by page id, but a selection runs through the pages in their
 * current order. The identity until pages are moved or deleted.
 */
export interface PageOrder {
  position: (id: number) => number | null;
  id: (position: number) => number | null;
}

const IDENTITY_ORDER: PageOrder = { position: (id) => id, id: (position) => position };

/** Most pages a selection joins (a drag across a whole book is a select all by another name; the first pages are enough). */
const MAX_PAGES_JOINED = 200;

/** Line breaks of the page's layout (`\r\n`) and Unicode's separators as `\n`. */
export function normalizeBreaks(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029]/g, '\n');
}

/**
 * The text between two places, in content order. `textOf` gives the text of a page (`undefined` if it is not known: the page is
 * skipped). Pages are joined by a line break. The places may be given in either order.
 */
export function textBetween(
  from: TextPoint,
  to: TextPoint,
  textOf: (page: number) => string | undefined,
  order: PageOrder = IDENTITY_ORDER,
): string {
  const fromPosition = order.position(from.page);
  const toPosition = order.position(to.page);
  if (fromPosition === null || toPosition === null) return '';
  const backwards = fromPosition > toPosition || (fromPosition === toPosition && from.index > to.index);
  const start = backwards ? to : from;
  const end = backwards ? from : to;
  const startPosition = backwards ? toPosition : fromPosition;
  const endPosition = backwards ? fromPosition : toPosition;
  if (start.page === end.page) return normalizeBreaks(textOf(start.page)?.slice(start.index, end.index) ?? '');
  const parts: string[] = [];
  const first = textOf(start.page);
  if (first !== undefined) parts.push(first.slice(start.index));
  const last = Math.min(endPosition - 1, startPosition + MAX_PAGES_JOINED);
  for (let position = startPosition + 1; position <= last; position += 1) {
    const id = order.id(position);
    const text = id === null ? undefined : textOf(id);
    if (text !== undefined) parts.push(text);
  }
  const final = textOf(end.page);
  if (final !== undefined) parts.push(final.slice(0, end.index));
  return normalizeBreaks(parts.join('\n'));
}

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);

function numberOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** The text layer element that holds `node`, or `null`. */
export function layerOf(node: Node | null): HTMLElement | null {
  const element = node === null ? null : elementOf(node);
  const layer = element?.closest(LAYER_SELECTOR) ?? null;
  return layer instanceof HTMLElement ? layer : null;
}

/** The place in a page's text that a selection boundary (a DOM node and offset) stands for; `null` outside a text layer. */
export function resolveBoundary(node: Node, offset: number): TextPoint | null {
  const layer = layerOf(node);
  if (layer === null) return null;
  const page = numberOf(layer.dataset.textPage);
  if (page === null) return null;
  const length = numberOf(layer.dataset.textLength) ?? 0;
  if (node === layer) {
    const child = layer.children.item(offset);
    if (child instanceof HTMLElement) return { page, index: numberOf(child.dataset.runStart) ?? length };
    return { page, index: length };
  }
  const span = elementOf(node)?.closest('[data-run-start]');
  if (!(span instanceof HTMLElement)) return null;
  const start = numberOf(span.dataset.runStart);
  const end = numberOf(span.dataset.runEnd);
  if (start === null || end === null) return null;
  if (node instanceof Text) return { page, index: Math.min(end, start + Math.max(0, offset)) };
  return { page, index: offset > 0 ? end : start };
}

/**
 * The text of the selection, or `null` when it is not in a text layer (so the browser's own copy stays in charge). A boundary that
 * cannot be placed in a page's text falls back to what the browser would copy.
 */
export function selectionText(
  selection: Pick<Selection, 'rangeCount' | 'isCollapsed' | 'getRangeAt' | 'toString'>,
  textOf: (page: number) => string | undefined,
  order: PageOrder = IDENTITY_ORDER,
): string | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (layerOf(range.startContainer) === null && layerOf(range.endContainer) === null) return null;
  const start = resolveBoundary(range.startContainer, range.startOffset);
  const end = resolveBoundary(range.endContainer, range.endOffset);
  if (start === null || end === null) return normalizeBreaks(selection.toString());
  return textBetween(start, end, textOf, order);
}

/** Selects all the text of a page's layer; `false` when the page has none mounted. */
export function selectPageText(root: ParentNode, page: number, selection: Selection | null): boolean {
  const layer = root.querySelector(`${LAYER_SELECTOR}[data-text-page="${page}"]`);
  if (selection === null || !(layer instanceof HTMLElement) || layer.childElementCount === 0) return false;
  selection.selectAllChildren(layer);
  return true;
}

/** Whether the selection is non-empty and inside a text layer. */
export function hasTextSelection(selection: Selection | null): boolean {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  return layerOf(range.startContainer) !== null || layerOf(range.endContainer) !== null;
}
