/**
 * Fits an entry preview to one line by measurement (DESIGN 3.11 L14, "Truncate rule"; never CSS `text-overflow`, Q6): drop trailing
 * words until text + "…" fits; a single word that is too long is cut at the last grapheme that fits + "…". `fits` measures a
 * candidate string. The text is the document's: it is only ever compared, cut and shown as text.
 */

const ELLIPSIS = '…';

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
  }
  return Array.from(text);
}

/** The largest `n` in `[0, max]` for which `ok(n)` holds, when `ok` is monotone (true up to a point, then false). */
function largest(max: number, ok: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function fitOneLine(text: string, fits: (candidate: string) => boolean): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '' || fits(clean)) return clean;
  const words = clean.split(' ');
  // Whole words first: the most words that fit together with the ellipsis.
  const count = largest(words.length - 1, (n) => n >= 1 && fits(words.slice(0, n).join(' ') + ELLIPSIS));
  if (count >= 1) return words.slice(0, count).join(' ') + ELLIPSIS;
  // The first word alone is too long (or nothing fits at all): cut it at a grapheme.
  const parts = graphemes(words[0] ?? '');
  const keep = largest(parts.length - 1, (n) => n >= 1 && fits(parts.slice(0, n).join('') + ELLIPSIS));
  return keep >= 1 ? parts.slice(0, keep).join('') + ELLIPSIS : ELLIPSIS;
}
