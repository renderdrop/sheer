import { useMiniBarDock } from './dock';

/**
 * The second row of the banner slot (DESIGN v2 3.2, 3.3): 40 high and only while the mini bar is docked, else 0 (it is not even
 * in the way). The bar is portalled into it, inset 16.
 */
export function MiniBarDock() {
  const docked = useMiniBarDock((s) => s.docked);
  const setTarget = useMiniBarDock((s) => s.setTarget);
  return (
    <div
      ref={setTarget}
      data-minibar-dock=""
      className={docked ? 'flex h-control-lg min-w-0 shrink-0 items-center px-4' : 'hidden'}
    />
  );
}
