import type { LinkInfo } from '../../api/links';
import type { SmartLink, SmartLinkKind } from '../../api/smartLinks';
import type { Rect } from '../../api/wire';

/**
 * The pure rules of the smart-link overlay (DESIGN 3.11): which tools make links live, the hit boxes, press-versus-drag, the order of
 * a page's links and the names that go with them. No DOM and no store here.
 */

/** A hit box is at least this many CSS px on each side at every zoom (L4); the drawn cue stays glyph-sized. */
export const MIN_HIT_PX = 24;
/** A press that moves this many CSS px or more becomes a text selection (L4). */
export const DRAG_PX = 4;

/** The tools under which smart and real links are live (L9): Auswahl, Hand and Textauswahl. */
export function toolMakesLinksLive(tool: string): boolean {
  return tool === 'select' || tool === 'hand' || tool === 'textSelect';
}

export interface LiveInputs {
  /** The tool the canvas behaves as (the hand while Space is held). */
  tool: string;
  redactMode: boolean;
  /** A tour is running on this document. */
  tourRunning: boolean;
  /** A text selection is being dragged. */
  selecting: boolean;
}

/** Links are drawn and hit only when nothing else owns the canvas (L9). */
export function linksLive(inputs: LiveInputs): boolean {
  return toolMakesLinksLive(inputs.tool) && !inputs.redactMode && !inputs.tourRunning && !inputs.selecting;
}

/** A box in client px. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box grown, symmetrically, to at least `min` px on each side. Empty boxes (no layout) stay empty. */
export function hitBox(box: Box, min = MIN_HIT_PX): Box {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width <= 0 || height <= 0) return box;
  const growX = Math.max(0, (min - width) / 2);
  const growY = Math.max(0, (min - height) / 2);
  return { left: box.left - growX, top: box.top - growY, right: box.right + growX, bottom: box.bottom + growY };
}

const area = (box: Box): number => (box.right - box.left) * (box.bottom - box.top);

/** The index of the box under the point (the smallest one when several are), or -1. Each box is first grown to the minimum hit size. */
export function pointerHit(boxes: readonly Box[], x: number, y: number): number {
  let found = -1;
  let foundArea = Number.POSITIVE_INFINITY;
  boxes.forEach((raw, index) => {
    const box = hitBox(raw);
    if (box.right <= box.left || box.bottom <= box.top) return;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
    const size = area(raw);
    if (size < foundArea || (size === foundArea && found < 0)) {
      found = index;
      foundArea = size;
    }
  });
  return found;
}

/** Whether a press at `from` that is now at `to` has become a selection drag. */
export function isDrag(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_PX;
}

/** One link of a page as the list shows it: a smart link or a real one of the PDF. */
export type PageLink =
  | { type: 'smart'; key: string; order: Rect; link: SmartLink }
  | { type: 'real'; key: string; order: Rect; info: LinkInfo };

/** The rectangle that places a smart link in reading order: for a contents line the line, else the first run. */
export function runRects(link: SmartLink): Rect[] {
  if (link.kind === 'contents') return [link.rects[link.rects.length - 1] ?? link.rects[0]!];
  return link.rects;
}

/** The rectangles the cue is drawn under: for a contents line the page number only, else the whole run. */
export function cueRects(link: SmartLink): Rect[] {
  return link.kind === 'contents' ? [link.rects[0]!] : link.rects;
}

/** Reading order: top to bottom, left to right within a line (positions within 2 points of height count as one line). */
export function readingOrder(a: Rect, b: Rect): number {
  return Math.abs(a.y - b.y) >= 2 ? a.y - b.y : a.x - b.x;
}

/** The links of a page, real and smart, in reading order. Keys are stable for one set of answers. */
export function pageLinks(smart: readonly SmartLink[] | null, real: readonly LinkInfo[] | null): PageLink[] {
  const items: PageLink[] = [];
  (smart ?? []).forEach((link, index) => {
    items.push({ type: 'smart', key: `s${index}`, order: runRects(link)[0]!, link });
  });
  (real ?? []).forEach((info) => items.push({ type: 'real', key: `r${info.index}`, order: info.rect, info }));
  return items.sort((a, b) => readingOrder(a.order, b.order));
}

/** What marks a smart link as visited in this tab: its kind, text and where it goes. */
export function visitKey(link: SmartLink): string {
  const { pageId, rect } = link.target;
  return `${link.kind}|${link.marker}|${pageId}|${rect === undefined ? '' : Math.round(rect.y)}`;
}

/** The catalog key of a kind's name. */
export function kindKey(kind: SmartLinkKind): `smartlinks.kind.${SmartLinkKind}` {
  return `smartlinks.kind.${kind}`;
}

/** The host of a URL, or the address of a mail link; the text itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'mailto:' ? parsed.pathname : parsed.host || url;
  } catch {
    return url;
  }
}

/** Where an arrow key goes in a page's list: to an index, out of the list to the next or the previous page's, or nowhere (not a navigation key). */
export type Step = { to: number } | { out: 'next' | 'prev' } | null;

export function stepFrom(key: string, index: number, count: number): Step {
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return index + 1 < count ? { to: index + 1 } : { out: 'next' };
    case 'ArrowUp':
    case 'ArrowLeft':
      return index > 0 ? { to: index - 1 } : { out: 'prev' };
    case 'Home':
      return { to: 0 };
    case 'End':
      return { to: count - 1 };
    default:
      return null;
  }
}
