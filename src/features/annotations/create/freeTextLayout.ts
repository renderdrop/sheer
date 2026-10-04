import type { Rect } from '../../../api/wire';

/**
 * The layout of a text comment (DESIGN 3.5 B4), in points: where its lines break and how big its box is. The backend draws the lines it
 * is given in Helvetica, so the widths are Helvetica's (Adobe AFM, 1/1000 em, the same table as `pdfwrite/appearance.rs`).
 */

/** The inset of the text from the box, on every side. */
export const FREE_TEXT_PAD = 4;
/** The narrowest a box is (including the padding). */
export const FREE_TEXT_MIN_WIDTH = 24;
/** The widest a box grows by typing, before the page's edge leaves less room. */
export const FREE_TEXT_MAX_WIDTH = 288;
/** The box keeps this far from the page's right edge while it grows. */
export const FREE_TEXT_EDGE = 12;
/** If less than this is left to the right of the click, the box moves left until it has it. */
export const FREE_TEXT_WRAP_MIN = 96;
/** A line is this many times the font size high (the appearance stream's leading). */
export const FREE_TEXT_LEADING = 1.2;
/** The caret needs this much room after the last glyph, so a line that just fits does not wrap under the caret. */
const CARET_SLACK = 1;

const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
] as const;

/** The width of `text` at `fontSize` points. A character the table does not hold counts as 556 (an accented letter). */
export function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    units += code >= 0x20 && code <= 0x7e ? (WIDTHS[code - 0x20] ?? 556) : 556;
  }
  return (units * fontSize) / 1000;
}

/**
 * The lines of `text` for room of `room` points: a line break is kept, a long line wraps at a space (the space is dropped), and a word
 * wider than the room breaks between characters.
 */
export function wrapText(text: string, fontSize: number, room: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    const flush = () => {
      out.push(line.replace(/ +$/, ''));
      line = '';
    };
    for (const word of paragraph.split(/(?<= )/)) {
      const bare = word.replace(/ +$/, '');
      if (line !== '' && textWidth(line + bare, fontSize) > room) flush();
      if (textWidth(bare, fontSize) > room) {
        // A word that fits no line breaks between characters.
        for (const char of bare) {
          if (line !== '' && textWidth(line + char, fontSize) > room) flush();
          line += char;
        }
        line += word.slice(bare.length);
      } else {
        line += word;
      }
    }
    out.push(line.replace(/ +$/, ''));
  }
  return out;
}

/** The widest line of `lines` at `fontSize`, trailing spaces not counted. */
export function widest(lines: readonly string[], fontSize: number): number {
  return lines.reduce((w, line) => Math.max(w, textWidth(line.replace(/ +$/, ''), fontSize)), 0);
}

/** How wide a box at `x` may grow on a page `pageWidth` wide. */
export function maxBoxWidth(x: number, pageWidth: number): number {
  return Math.min(FREE_TEXT_MAX_WIDTH, Math.max(FREE_TEXT_WRAP_MIN, pageWidth - x - FREE_TEXT_EDGE));
}

/** The left edge of a new box at a click at `x`: moved left when less than the narrowest wrap width is left on the right. */
export function startX(x: number, pageWidth: number): number {
  const latest = pageWidth - FREE_TEXT_EDGE - FREE_TEXT_WRAP_MIN;
  return Math.max(0, Math.min(x, latest));
}

/** The height of `count` lines (at least one) with the padding. */
export function boxHeight(count: number, fontSize: number): number {
  return Math.max(1, count) * fontSize * FREE_TEXT_LEADING + 2 * FREE_TEXT_PAD;
}

export interface TextLayout {
  /** The lines as they will be stored: wrapped at the box's width. */
  lines: string[];
  box: Rect;
}

/**
 * The box `text` needs, grown from `from` (the box at the start of the edit): to the right with the text up to the maximum width, then
 * wrapping and growing downward without limit. A box that is wider or higher than the text needs keeps its size when `keep` is set (an
 * existing box); a new one hugs the text, at least 24 points wide and one line high.
 */
export function layoutText(text: string, fontSize: number, from: Rect, pageWidth: number, keep: boolean): TextLayout {
  const cap = Math.max(maxBoxWidth(from.x, pageWidth), keep ? from.w : 0);
  const wanted = widest(wrapText(text, fontSize, cap - 2 * FREE_TEXT_PAD - CARET_SLACK), fontSize);
  const needed = Math.max(FREE_TEXT_MIN_WIDTH, wanted + 2 * FREE_TEXT_PAD + CARET_SLACK);
  const w = Math.min(cap, keep ? Math.max(from.w, needed) : needed);
  const lines = wrapText(text, fontSize, w - 2 * FREE_TEXT_PAD - CARET_SLACK);
  const h = Math.max(boxHeight(lines.length, fontSize), keep ? from.h : 0);
  return { lines, box: { x: from.x, y: from.y, w, h } };
}
