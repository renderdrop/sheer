import { useUi, type Mode } from '../../stores/ui';

/** Switches the mode (DESIGN v2 3.2): the tool becomes Auswahl, in Seiten the page grid. The same mode again does nothing. */
export function switchMode(mode: Mode): void {
  useUi.getState().setMode(mode);
}

/** Where focus goes after Esc in the tool row: the canvas's scroller, or the page grid. */
export function focusCanvas(): void {
  // The first that exists, in this order (a single selector list would answer in document order, the wrapper first).
  for (const selector of [
    '[data-action-scope="canvas"] > [role="region"]',
    '[data-action-scope="canvas"] [role="listbox"]',
  ]) {
    const target = document.querySelector<HTMLElement>(selector);
    if (target !== null) {
      target.focus({ preventScroll: true });
      return;
    }
  }
}

/** How long a tool item may take to mount after a mode switch before the focus request gives up. */
export const TOOL_ITEM_WAIT_MS = 2000;
const POLL_MS = 40;

/**
 * Focuses the tool-row item `id` (the `data-toolbar-item` of its slot) once it is in the row, which mounts after a mode switch.
 * Resolves with whether it was focused; the row is the owner of its own markup, so callers name the item, not a selector.
 */
export function focusToolItem(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = (): void => {
      const found = document.querySelector<HTMLElement>(`[data-toolbar-item="${id}"]`);
      if (found !== null) {
        found.focus({ preventScroll: true });
        resolve(true);
      } else if (Date.now() - started >= TOOL_ITEM_WAIT_MS) resolve(false);
      else setTimeout(look, POLL_MS);
    };
    look();
  });
}
