import type { CSSProperties } from 'react';

import { useUi } from '../../stores/ui';
import { ViewerCanvas } from '../viewer/ViewerCanvas';
import { OrganizeView } from './OrganizeView';

/**
 * What fills the canvas's track: the page grid while the Pages tool is active (DESIGN 3.28), else the viewer's canvas. It follows
 * the tool alone, so the shell does not render for anything else.
 */
export function CanvasSlot({ style }: { style?: CSSProperties }) {
  const organizing = useUi((state) => state.activeTool === 'pages');
  return organizing ? <OrganizeView style={style} /> : <ViewerCanvas style={style} />;
}
