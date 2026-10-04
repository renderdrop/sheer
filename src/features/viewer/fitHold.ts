import { useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { readShellStructure } from '../shell/useShellStructure';

/**
 * ADR-056: the inspector opening or closing (tool options OR a selection) resizes the canvas. That resize must not refit a
 * fit mode (zoom and scroll stay where they are, so the point under the cursor stays put); only a window resize or an
 * explicit left-panel change refits. The hold has an explicit reason, not a timer: it is armed by a store change that flips
 * the inspector slot while the window size is unchanged, spent by the next canvas size report, and dropped by a window resize
 * or a left-panel change (so it can never swallow a real resize).
 */
interface Hold {
  windowWidth: number;
  windowHeight: number;
}

let hold: Hold | null = null;

/** True when the inspector slot flipped between two structures. */
export function inspectorFlipped(
  previous: { inspectorReserved: boolean; inspectorVisible: boolean },
  next: { inspectorReserved: boolean; inspectorVisible: boolean },
): boolean {
  return previous.inspectorReserved !== next.inspectorReserved || previous.inspectorVisible !== next.inspectorVisible;
}

export function armFitHold(windowWidth = window.innerWidth, windowHeight = window.innerHeight): void {
  hold = { windowWidth, windowHeight };
}

export function dropFitHold(): void {
  hold = null;
}

/** Whether the size report that is arriving is the result of an inspector change (spends the hold). */
export function consumeFitHold(windowWidth = window.innerWidth, windowHeight = window.innerHeight): boolean {
  const held = hold !== null && hold.windowWidth === windowWidth && hold.windowHeight === windowHeight;
  hold = null;
  return held;
}

let watching = false;
/** Starts watching the stores for inspector changes (once). */
export function watchToolInspector(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  let last = readShellStructure();
  const update = (): void => {
    const next = readShellStructure();
    if (inspectorFlipped(last, next)) armFitHold();
    last = next;
  };
  useUi.subscribe((state, previous) => {
    if (state.leftPanelCollapsed !== previous.leftPanelCollapsed || state.leftPanelWidth !== previous.leftPanelWidth)
      dropFitHold();
    update();
  });
  useAnnotations.subscribe((state, previous) => {
    if (state.selectedIds !== previous.selectedIds) update();
  });
  window.addEventListener('resize', () => {
    dropFitHold();
    last = readShellStructure();
  });
}
