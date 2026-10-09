import { useCallback, useRef, useSyncExternalStore } from 'react';

import { shellStructure, type ShellStructure } from '../../lib/layout';
import { chromeFor, detectPlatform } from '../../lib/platform';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useToolInspector } from '../inspector/toolInspector';

/** The structure of the shell as the stores and the window say it now (see `shellStructure`, src/lib/layout.ts). */
export function readShellStructure(): ShellStructure {
  const ui = useUi.getState();
  const activeId = useDocuments.getState().activeId;
  return shellStructure({
    // Home shows without a document and after "back to Home"; the documents stay open behind it.
    hasDocument: activeId !== null && ui.view === 'editor',
    windowWidth: window.innerWidth,
    panelWidth: ui.leftPanelWidth,
    leftTab: ui.leftPanelTab,
    // The page grid takes the room of the page sidebar (DESIGN 3.28); it returns when the mode ends.
    panelCollapsed: ui.leftPanelCollapsed || ui.activeTool === 'pages',
    // Windows draws its own menu row; macOS has the native bar (DESIGN v2 3.2).
    menuRow: chromeFor(useSettings.getState().platform ?? detectPlatform()).caption,
    // The inspector column (300) is there while a tool inspector or the history list is open (DESIGN 3.18 E1, E5).
    inspectorWidth: ui.inspectorWidth,
    inspectorOpen: useToolInspector.getState().open !== null,
  });
}

function subscribe(notify: () => void): () => void {
  window.addEventListener('resize', notify);
  const stopUi = useUi.subscribe(notify);
  const stopDocuments = useDocuments.subscribe(notify);
  const stopSettings = useSettings.subscribe(notify);
  const stopInspector = useToolInspector.subscribe(notify);
  return () => {
    window.removeEventListener('resize', notify);
    stopUi();
    stopDocuments();
    stopSettings();
    stopInspector();
  };
}

function sameStructure(a: ShellStructure, b: ShellStructure): boolean {
  return (
    a.mode === b.mode && a.leftCollapsed === b.leftCollapsed && a.menuRow === b.menuRow && a.inspector === b.inspector
  );
}

/**
 * The structure of the shell: Home or editor, whether the page sidebar shows and whether there is a menu row. It depends on the window width, the
 * page sidebar's width, the user's panel choices, the active tool and whether a document is open and the view is the editor, but its answer is a handful
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
