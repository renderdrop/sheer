import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import type { ScrollAnchor, ScrollMode } from '../viewer/layout';
import { useCrop } from './store';

/**
 * The crop mode as a mode of the shell (DESIGN 3.37): while the Crop tool is active the canvas shows one page; what the user had
 * comes back when the mode ends. The Crop tool is a plain tool of `ui`, so this follows it from outside
 * and any way of leaving the tool (K, Esc, Apply, another tool, another document) restores the view.
 */
interface Saved {
  docId: number;
  scrollMode: ScrollMode;
}

let saved: Saved | null = null;

/** Keeps the current page at the top of the canvas when the layout changes. */
const topOf = (page: number): ScrollAnchor => ({ page, xPt: 0, yPt: 0, viewX: 0, viewY: 0 });
let installed = false;

function enter(): void {
  const docId = selectActiveId(useDocuments.getState());
  useCrop.getState().clear();
  if (docId === null) return;
  const view = useView.getState().byDoc[docId];
  if (view === undefined) return;
  saved = { docId, scrollMode: view.scrollMode };
  if (view.scrollMode !== 'single') useView.getState().setScrollMode(docId, 'single', topOf(view.pageIndex));
}

function leave(): void {
  useCrop.getState().clear();
  const was = saved;
  saved = null;
  if (was === null) return;
  const view = useView.getState().byDoc[was.docId];
  if (view !== undefined && view.scrollMode !== was.scrollMode) {
    useView.getState().setScrollMode(was.docId, was.scrollMode, topOf(view.pageIndex));
  }
}

/** Starts following the tool. Once; the layer module calls it on import, which is when the canvas exists. Returns the function that stops it. */
export function installCropMode(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const stopUi = useUi.subscribe((state, previous) => {
    if (state.activeTool === previous.activeTool) return;
    if (state.activeTool === 'crop') enter();
    else if (previous.activeTool === 'crop') leave();
  });
  // A different document ends the mode: the draft belongs to the one it started on.
  const stopDocs = useDocuments.subscribe((state, previous) => {
    if (selectActiveId(state) !== selectActiveId(previous) && useUi.getState().activeTool === 'crop') {
      useUi.getState().releaseTool();
    }
  });
  return () => {
    stopUi();
    stopDocs();
    installed = false;
    saved = null;
  };
}
