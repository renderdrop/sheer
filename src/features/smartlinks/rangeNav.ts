/** The keyboard rules of the range chooser's listbox (DESIGN 3.11 L14). Pure: no DOM. */

/** Rows a PageDown or PageUp moves (the number of rows visible at most). */
export const PAGE_ROWS = 12;
/** How long typed digits count as one number, in ms. */
export const TYPE_MS = 800;

/** The row a navigation key moves to (no wrap), or `null` when the key is not one. */
export function moveCurrent(key: string, index: number, count: number): number | null {
  const last = count - 1;
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, index + 1);
    case 'ArrowUp':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return Math.min(last, index + PAGE_ROWS);
    case 'PageUp':
      return Math.max(0, index - PAGE_ROWS);
    default:
      return null;
  }
}

/**
 * The row for typed digits: the one whose number is exactly `typed`, else the first whose number starts with it. `null` if none (the
 * caller then starts a new number with the last digit alone).
 */
export function rowForDigits(typed: string, numbers: readonly number[]): number | null {
  const exact = numbers.findIndex((n) => String(n) === typed);
  if (exact >= 0) return exact;
  const prefix = numbers.findIndex((n) => String(n).startsWith(typed));
  return prefix >= 0 ? prefix : null;
}

export function isDigit(key: string): boolean {
  return key.length === 1 && key >= '0' && key <= '9';
}
