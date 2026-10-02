import type { CSSProperties } from 'react';

import { useUi } from '../../stores/ui';
import { useDocView } from '../../stores/view';
import { Canvas } from './Canvas';
import { selectDocId, useViewer } from './useViewer';

/**
 * The canvas with the open document's state: the page image, its zoom and page, whether a render is in flight, and the
 * drag-over flag. It subscribes to these itself, so a wheel zoom or a page change re-renders the canvas and nothing around it.
 */
export function ViewerCanvas({ style }: { style?: CSSProperties }) {
  const image = useViewer((state) => state.image);
  const busy = useViewer((state) => state.rendering);
  const zoomByWheel = useViewer((state) => state.zoomByWheel);
  const setViewport = useViewer((state) => state.setViewport);
  const { zoom, pageIndex, pageCount } = useDocView(useViewer(selectDocId));
  const dropActive = useUi((state) => state.dropHover);
  return (
    <Canvas
      style={style}
      image={image}
      zoom={zoom}
      pageIndex={pageIndex}
      pageCount={pageCount}
      busy={busy}
      onWheelZoom={zoomByWheel}
      onViewport={setViewport}
      dropActive={dropActive}
    />
  );
}
