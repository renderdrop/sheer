import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { rotatePages } from './commands';

/** Whether the page grid is what the canvas shows now (the Pages tool is active; DESIGN 3.28). */
export function organizeActive(): boolean {
  return useUi.getState().activeTool === 'pages';
}

/**
 * Primary+L and primary+R rotate the selected pages while the grid is open (ADR-037: the view rotation is off there), else they
 * turn the view. Returns whether it handled the command.
 */
export function rotateOrganized(quarterTurns: -1 | 1): boolean {
  if (!organizeActive()) return false;
  const docId = useDocuments.getState().activeId;
  if (docId !== null) void rotatePages(docId, quarterTurns);
  return true;
}
