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
