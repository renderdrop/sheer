import { useUi } from '../../stores/ui';

/**
 * ADR-056: choosing or ending a tool opens or closes the tool-options inspector, which resizes the canvas. That resize must not
 * refit a fit mode (zoom and scroll stay where the user left them); only a window resize or an explicit panel toggle refits.
 * The hold is armed by such a tool change and spent by the next canvas size report (or when it times out).
 */
const HOLD_MS = 1500;
let until = 0;

const hasToolOptions = (tool: string): boolean => tool !== 'select' && tool !== 'pages';

/** True when the change from `previous` to `next` only opens or closes the inspector for tool options. */
export function opensToolInspector(
  previous: { activeTool: string; inspector: unknown; leftPanelCollapsed: boolean; leftPanelWidth: number },
  next: { activeTool: string; inspector: unknown; leftPanelCollapsed: boolean; leftPanelWidth: number },
): boolean {
  return (
    previous.activeTool !== next.activeTool &&
    hasToolOptions(previous.activeTool) !== hasToolOptions(next.activeTool) &&
    previous.inspector === next.inspector &&
    previous.leftPanelCollapsed === next.leftPanelCollapsed &&
    previous.leftPanelWidth === next.leftPanelWidth
  );
}

export function armFitHold(now = Date.now()): void {
  until = now + HOLD_MS;
}

/** Whether the size report that is arriving is the result of a tool change (spends the hold). */
export function consumeFitHold(now = Date.now()): boolean {
  const held = now < until;
  until = 0;
  return held;
}

let watching = false;
/** Starts watching the ui store for tool changes (once). */
export function watchToolInspector(): void {
  if (watching) return;
  watching = true;
  useUi.subscribe((state, previous) => {
    if (opensToolInspector(previous, state)) armFitHold();
  });
}
