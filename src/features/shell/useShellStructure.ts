import { useCallback, useRef, useSyncExternalStore } from 'react';

import { shellStructure, type ShellStructure } from '../../lib/layout';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';

/** The structure of the shell as the stores and the window say it now (see `shellStructure`, src/lib/layout.ts). */
export function readShellStructure(): ShellStructure {
  const ui = useUi.getState();
  const activeId = useDocuments.getState().activeId;
  const modePanel = ui.redactMode || ui.activeTool === 'crop';
  return shellStructure({
    hasDocument: activeId !== null,
    windowWidth: window.innerWidth,
    panelWidth: ui.leftPanelWidth,
    // The page grid takes the room of the left panel (DESIGN 3.28); it returns when the mode ends.
    panelCollapsed: ui.leftPanelCollapsed || ui.activeTool === 'pages',
    inspector: ui.inspector,
    // DESIGN 3.57: a mode panel (Crop, Redact), a selection, or the options of a tool that has some. Select, Pages and the
    // retired Form tool have none.
    inspectorContent:
      modePanel ||
      (ui.activeTool !== 'select' && ui.activeTool !== 'pages' && ui.activeTool !== 'form') ||
      (activeId !== null && (useAnnotations.getState().selectedIds[activeId]?.length ?? 0) > 0),
    inspectorMode: modePanel,
  });
}

function subscribe(notify: () => void): () => void {
  window.addEventListener('resize', notify);
  const stopUi = useUi.subscribe(notify);
  const stopDocuments = useDocuments.subscribe(notify);
  const stopSelection = useAnnotations.subscribe((state, previous) => {
    if (state.selectedIds !== previous.selectedIds) notify();
  });
  return () => {
    stopSelection();
    window.removeEventListener('resize', notify);
    stopUi();
    stopDocuments();
  };
}

function sameStructure(a: ShellStructure, b: ShellStructure): boolean {
  return (
    a.mode === b.mode &&
    a.leftCollapsed === b.leftCollapsed &&
    a.leftAutoCollapsed === b.leftAutoCollapsed &&
    a.inspectorReserved === b.inspectorReserved &&
    a.inspectorVisible === b.inspectorVisible
  );
}

/**
 * The structure of the shell: which slots exist and whether the inspector shows. It depends on the window width, the
 * left panel's width, the user's panel choices, the active tool and whether a document is open, but its answer is a handful
 * of booleans, so the component that uses it re-renders when one of them flips and not with every pixel of a window
 * resize, every step of a splitter drag or every change of page and zoom. A new answer that equals the last one is
 * not a change: the previous object is returned, which is what lets React skip the render.
 */
export function useShellStructure(): ShellStructure {
  const last = useRef<ShellStructure | null>(null);
  const getSnapshot = useCallback(() => {
    const next = readShellStructure();
    if (last.current !== null && sameStructure(last.current, next)) return last.current;
    last.current = next;
    return next;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
