import { AnimatePresence } from 'motion/react';
import type { ComponentType } from 'react';

import { StampPanel } from '../annotations/stamps/StampPanel';
import { CropPanel } from '../crop/CropPanel';
import { HeaderFooterPanel } from '../headerFooter/HeaderFooterPanel';
import { HistoryPanel } from '../historyList/HistoryPanel';
import { OcrPanel } from '../ocr/OcrPanel';
import { ReferencePanel } from '../properties/ReferencePanel';
import { installToolInspectorBindings } from './bindings';
import { useToolInspector, type ToolInspectorId } from './toolInspector';

/**
 * What each inspector id shows. `history` is the extension point of F19.23: put its panel here (an `InspectorFrame` with
 * `footer={null}`) and the column opens it from the tab strip's History button.
 */
const PANELS: Readonly<Record<ToolInspectorId, ComponentType | null>> = {
  crop: CropPanel,
  headerFooter: HeaderFooterPanel,
  stamp: StampPanel,
  ocr: OcrPanel,
  reference: ReferencePanel,
  history: HistoryPanel,
};

// The tool stores drive the column; this is wired once when the shell loads the component.
installToolInspectorBindings();

/** Whether the inspector column has anything to show (the shell gives it its 300 px, or 0 when this is `false`). */
export function useToolInspectorOpen(): boolean {
  return useToolInspector((state) => state.open !== null && PANELS[state.open] !== null);
}

/**
 * The tool inspector (DESIGN §3.18 E5): the content of the 300 px column right of the canvas. Renders the panel of the open tool
 * (Zuschneiden, Kopf-/Fußzeile, Stempel, Text erkennen, Quellenangabe); nothing when closed. The shell owns the column and its width.
 */
export function ToolInspector() {
  const open = useToolInspector((state) => state.open);
  const Panel = open === null ? null : PANELS[open];
  return <AnimatePresence initial={false}>{Panel !== null && open !== null && <Panel key={open} />}</AnimatePresence>;
}
