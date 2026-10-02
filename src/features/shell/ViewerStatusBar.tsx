import { selectActiveDocument, selectActiveId, useDocuments } from '../../stores/documents';
import { useDocView } from '../../stores/view';
import { useViewer } from '../viewer/useViewer';
import { StatusBar } from './StatusBar';

/**
 * The status bar with the open document's state: its name, page and zoom, and whether a render is in flight. It
 * subscribes to these itself, so a page or zoom change re-renders the bar and nothing around it.
 */
export function ViewerStatusBar() {
  const fileName = useDocuments((state) => selectActiveDocument(state)?.displayName ?? null);
  const rendering = useViewer((state) => state.rendering);
  const goToPage = useViewer((state) => state.goToPage);
  const setZoom = useViewer((state) => state.setZoom);
  const { zoom, pageIndex, pageCount } = useDocView(useDocuments(selectActiveId));
  return (
    <StatusBar
      fileName={fileName}
      pageIndex={pageIndex}
      pageCount={pageCount}
      zoom={zoom}
      rendering={rendering}
      onGoToPage={goToPage}
      onZoom={setZoom}
    />
  );
}
