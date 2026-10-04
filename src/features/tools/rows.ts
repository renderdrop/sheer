import {
  FileOutput,
  Highlighter,
  ImagePlus,
  LayoutGrid,
  MessageSquare,
  MousePointer2,
  PenLine,
  Shapes,
  Signature,
  Type,
  Ellipsis,
  type LucideIcon,
} from 'lucide-react';

import { canRunAction } from '../../actions/dispatch';
import type { PlainKey } from '../../i18n';
import { useUi, type ToolId } from '../../stores/ui';

export type RowId =
  'select' | 'highlight' | 'text' | 'draw' | 'note' | 'signature' | 'shapes' | 'image' | 'pages' | 'export' | 'more';

export interface RowDef {
  /** Also the `data-toolbar-item` of the row (the tour and the smoke tests find it by that). */
  id: RowId;
  icon: LucideIcon;
  labelKey: PlainKey;
  /** The tool a click makes active; `null` for the two rows that only expand into action rows. */
  tool: ToolId | null;
  /** Every tool the row stands for: it is on while one of them is active. */
  tools: readonly ToolId[];
}

/** The tool sidebar's rows in order (DESIGN v2 3.2). */
export const ROWS: readonly RowDef[] = [
  { id: 'select', icon: MousePointer2, labelKey: 'tools.select', tool: 'select', tools: ['select'] },
  { id: 'highlight', icon: Highlighter, labelKey: 'tools.markup', tool: 'highlight', tools: ['highlight'] },
  { id: 'text', icon: Type, labelKey: 'tools.text', tool: 'text', tools: ['text', 'textBox'] },
  { id: 'draw', icon: PenLine, labelKey: 'tools.draw', tool: 'draw', tools: ['draw'] },
  { id: 'note', icon: MessageSquare, labelKey: 'tools.comment', tool: 'note', tools: ['note'] },
  { id: 'signature', icon: Signature, labelKey: 'tools.signature', tool: 'signature', tools: ['signature'] },
  { id: 'shapes', icon: Shapes, labelKey: 'tools.shapes', tool: 'shapes', tools: ['shapes'] },
  { id: 'image', icon: ImagePlus, labelKey: 'tools.images', tool: 'image', tools: ['image'] },
  { id: 'pages', icon: LayoutGrid, labelKey: 'tools.pages', tool: 'pages', tools: ['pages'] },
  { id: 'export', icon: FileOutput, labelKey: 'tools.export', tool: null, tools: [] },
  // Crop and the Form tool are reached from More; Redact is a mode beside the tools.
  { id: 'more', icon: Ellipsis, labelKey: 'tools.more', tool: null, tools: ['crop', 'form'] },
];

/** The tools that change the document: their rows are soft-disabled in a read-only one (the tour's sample). */
export const WRITE_ROWS: ReadonlySet<RowId> = new Set<RowId>(['signature']);

/** The row that the active tool (or the redact mode) belongs to. */
export function rowOfState(activeTool: ToolId, redactMode: boolean): RowId {
  if (redactMode) return 'more';
  return ROWS.find((row) => row.tools.includes(activeTool))?.id ?? 'select';
}

/**
 * A click on a row that has a tool: makes the tool active. Unlike the toolbar's click it never toggles the tool off: a tool stays
 * active until Esc or Select (ADR-056). A tool the registry says cannot run now (no document) is left alone.
 */
export function chooseRow(row: RowDef): void {
  const ui = useUi.getState();
  if (row.tool === null) return;
  if (ui.redactMode) ui.setRedactMode(false);
  if (row.id === 'select') {
    ui.releaseTool();
    return;
  }
  if (!row.tools.includes(ui.activeTool) && canRunAction(`tool-${row.tool}`)) ui.selectTool(row.tool);
}
