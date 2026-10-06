import { useEffect, useState } from 'react';

import { textEditLines, type FallbackFace, type TextLineInfo } from '../../api/textEdit';
import type { Point, Rect } from '../../api/wire';
import { useAnnotations } from '../../stores/annotations';
import { readSlots } from '../../stores/pages';

/**
 * The lines of a page for the edit layer (DESIGN 3.10 E1, E2, E8): one `textEditLines` answer per document, page and edit
 * revision, a hit test with the 24 px minimum hit height, the growth window of a line and reading-order navigation across pages.
 * A line key is only valid for one revision of its page, so every change set of the document (a commit, an undo) drops the answers.
 */

/** Least height of a hit area, in px, whatever the zoom (DESIGN 3.10 E8). */
export const MIN_HIT_PX = 24;
/** Side margin of a hit area, in points. */
const HIT_SIDE_PT = 2;
/** Gap kept to the next object on the baseline, and to the page edge, in points (DESIGN 3.10 E2). */
export const OBJECT_GAP_PT = 4;
export const EDGE_GAP_PT = 12;

interface Entry {
  rev: number;
  promise: Promise<readonly TextLineInfo[]>;
  lines: readonly TextLineInfo[] | null;
}

const entries = new Map<string, Entry>();
const keyOf = (docId: number, pageId: number) => `${docId}:${pageId}`;
const revOf = (docId: number) => useAnnotations.getState().byDoc[docId]?.rev ?? 0;

/** The lines of a page; a failed read gives no lines (and is asked again next time). */
export function loadLines(docId: number, pageId: number): Promise<readonly TextLineInfo[]> {
  const key = keyOf(docId, pageId);
  const rev = revOf(docId);
  const known = entries.get(key);
  if (known !== undefined && known.rev === rev) return known.promise;
  const entry: Entry = { rev, lines: null, promise: Promise.resolve([]) };
  entry.promise = textEditLines(docId, pageId).then(
    (answer) => {
      entry.lines = answer.lines;
      return answer.lines;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
      return [] as readonly TextLineInfo[];
    },
  );
  entries.set(key, entry);
  return entry.promise;
}

/** Forgets what is known about a document (it was closed) or one page. */
export function forgetLines(docId: number, pageId?: number): void {
  for (const key of [...entries.keys()]) {
    if (pageId === undefined ? key.startsWith(`${docId}:`) : key === keyOf(docId, pageId)) entries.delete(key);
  }
}

/** For tests. */
export function resetLines(): void {
  entries.clear();
}

/** The lines of a page while `enabled`; `null` until they are there. Follows the document's revision. */
export function useLines(docId: number, pageId: number, enabled: boolean): readonly TextLineInfo[] | null {
  const rev = useAnnotations((s) => s.byDoc[docId]?.rev ?? 0);
  const [state, setState] = useState<{ at: string; lines: readonly TextLineInfo[] } | null>(null);
  const at = `${docId}:${pageId}:${rev}`;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void loadLines(docId, pageId).then((lines) => {
      if (current) setState({ at, lines });
    });
    return () => {
      current = false;
    };
  }, [enabled, docId, pageId, at]);
  return enabled && state?.at === at ? state.lines : null;
}

const contains = (r: Rect, p: Point, padX: number, padY: number) =>
  p.x >= r.x - padX && p.x <= r.x + r.w + padX && p.y >= r.y - padY && p.y <= r.y + r.h + padY;

/**
 * The line under a point in page space. `pxPerPt` makes the hit area at least `MIN_HIT_PX` high; of several areas that contain the
 * point the one whose own box is nearest wins, so padded neighbours do not steal each other's clicks.
 */
export function hitLine(lines: readonly TextLineInfo[], point: Point, pxPerPt: number): TextLineInfo | null {
  const minPt = MIN_HIT_PX / (pxPerPt > 0 ? pxPerPt : 1);
  let best: TextLineInfo | null = null;
  let bestDistance = Infinity;
  for (const line of lines) {
    const padY = Math.max(0, (minPt - line.box.h) / 2);
    if (!contains(line.box, point, HIT_SIDE_PT, padY)) continue;
    const distance = Math.abs(point.y - (line.box.y + line.box.h / 2));
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

export const isEditable = (line: TextLineInfo): boolean => line.editable.type !== 'no';

export type Align = 'left' | 'right' | 'center';

/** The lines of a line's paragraph, in order. */
export const paragraphOf = (lines: readonly TextLineInfo[], line: TextLineInfo): TextLineInfo[] =>
  lines.filter((other) => other.paragraph === line.paragraph);

/** The alignment anchor of a line (DESIGN 3.10 E2): left unless its paragraph's lines share a right edge or a centre. */
export function alignOf(lines: readonly TextLineInfo[], line: TextLineInfo): Align {
  const mates = paragraphOf(lines, line);
  if (mates.length < 2) return 'left';
  const tol = 2;
  const same = (value: (l: TextLineInfo) => number) => mates.every((m) => Math.abs(value(m) - value(line)) <= tol);
  if (same((l) => l.box.x)) return 'left';
  if (same((l) => l.box.x + l.box.w)) return 'right';
  if (same((l) => l.box.x + l.box.w / 2)) return 'center';
  return 'left';
}

/** The page space a line may grow into, the paragraph's rule and the alignment. */
export interface Growth {
  align: Align;
  /** The window the text may fill, in page space; text past it is overflow. */
  left: number;
  right: number;
  /** The paragraph's lines, when it has two or more: for the rule. */
  rule: Rect | null;
}

/** Whether two boxes share the line's baseline band (more than half of the shorter height in common). */
function sameBand(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > Math.min(a.h, b.h) / 2;
}

/** The limit of a line (DESIGN 3.10 E2): the paragraph's widest edge, the next object on the baseline and the page edge. */
export function growthOf(lines: readonly TextLineInfo[], line: TextLineInfo, pageWidth: number): Growth {
  const align = alignOf(lines, line);
  const mates = paragraphOf(lines, line);
  const multi = mates.length > 1;
  const own = line.box;
  let maxRight = pageWidth - EDGE_GAP_PT;
  let minLeft = EDGE_GAP_PT;
  for (const other of lines) {
    if (other === line || other.paragraph === line.paragraph || !sameBand(own, other.box)) continue;
    if (other.box.x >= own.x + own.w - 1) maxRight = Math.min(maxRight, other.box.x - OBJECT_GAP_PT);
    else if (other.box.x + other.box.w <= own.x + 1)
      minLeft = Math.max(minLeft, other.box.x + other.box.w + OBJECT_GAP_PT);
  }
  // Own paragraph: a line beside this one on the same baseline is an object too (a column); the widest line caps a real paragraph.
  for (const mate of mates) {
    if (mate === line) continue;
    if (sameBand(own, mate.box)) {
      if (mate.box.x >= own.x + own.w - 1) maxRight = Math.min(maxRight, mate.box.x - OBJECT_GAP_PT);
      else if (mate.box.x + mate.box.w <= own.x + 1)
        minLeft = Math.max(minLeft, mate.box.x + mate.box.w + OBJECT_GAP_PT);
    }
  }
  if (multi) {
    const rows = mates.filter((m) => !sameBand(own, m.box) || m === line);
    maxRight = Math.min(maxRight, Math.max(...rows.map((m) => m.box.x + m.box.w)));
    minLeft = Math.max(minLeft, Math.min(...rows.map((m) => m.box.x)));
  }
  maxRight = Math.max(maxRight, own.x + own.w);
  minLeft = Math.min(minLeft, own.x);
  let left = own.x;
  let right = maxRight;
  if (align === 'right') {
    left = minLeft;
    right = own.x + own.w;
  } else if (align === 'center') {
    const centre = own.x + own.w / 2;
    const half = Math.min(centre - minLeft, maxRight - centre);
    left = centre - half;
    right = centre + half;
  }
  let rule: Rect | null = null;
  if (multi) {
    const top = Math.min(...mates.map((m) => m.box.y));
    const bottom = Math.max(...mates.map((m) => m.box.y + m.box.h));
    const x = Math.min(...mates.map((m) => m.box.x));
    rule = { x: x - 6, y: top, w: 2, h: bottom - top };
  }
  return { align, left, right, rule };
}

/** Points the text of `width` runs past the window of `growth` (0 = fits). */
export function overflowOf(growth: Growth, width: number): number {
  const free = growth.right - growth.left;
  return Math.max(0, width - free);
}

/** Where the text of `width` sits for a line `box`: its left and right edge in page space. */
export function textSpan(growth: Growth, box: Rect, width: number): { left: number; right: number } {
  const w = Math.max(width, box.w);
  if (growth.align === 'right') return { left: box.x + box.w - w, right: box.x + box.w };
  if (growth.align === 'center') {
    const c = box.x + box.w / 2;
    return { left: c - w / 2, right: c + w / 2 };
  }
  return { left: box.x, right: box.x + w };
}

/** The distinct characters of `text` that are not whitespace, in order of first use. */
export function distinctChars(text: string): string[] {
  return [...new Set([...text].filter((c) => c.trim() !== ''))];
}

/** The CSS font family of the nearest of the three families for a PDF font name (serif, sans or mono by name hints). */
export function familyFor(name: string): 'serif' | 'sans-serif' | 'monospace' {
  const n = name.toLowerCase();
  if (/mono|courier|consolas|cousine|typewriter|menlo|code/.test(n)) return 'monospace';
  if (/sans|arial|helvet|arimo|calibri|verdana|tahoma|segoe|gothic/.test(n)) return 'sans-serif';
  if (/times|tinos|serif|georgia|garamond|minion|palatino|cambria|book|roman|baskerville|didot|century/.test(n))
    return 'serif';
  return 'sans-serif';
}

/** The editable line after `from` (or before it) in reading order, continuing onto the next or previous page. */
export async function neighbourLine(
  docId: number,
  pageId: number,
  from: { rev: number; line: number } | null,
  direction: 1 | -1,
): Promise<{ pageId: number; line: TextLineInfo } | null> {
  const slots = readSlots(docId);
  const ids = slots.length === 0 ? [pageId] : slots.map((s) => s.id);
  let at = ids.indexOf(pageId);
  if (at < 0) return null;
  let current = await loadLines(docId, pageId);
  let index =
    from === null ? (direction === 1 ? -1 : current.length) : current.findIndex((l) => l.key.line === from.line);
  for (;;) {
    for (let i = index + direction; i >= 0 && i < current.length; i += direction) {
      const candidate = current[i];
      if (candidate !== undefined && isEditable(candidate)) return { pageId: ids[at] ?? pageId, line: candidate };
    }
    at += direction;
    const nextId = ids[at];
    if (nextId === undefined) return null;
    current = await loadLines(docId, nextId);
    index = direction === 1 ? -1 : current.length;
  }
}

/** The bundled substitute family nearest to a PDF font name. */
export function faceOf(name: string): FallbackFace {
  const family = familyFor(name);
  return family === 'serif' ? 'serif' : family === 'monospace' ? 'mono' : 'sans';
}
