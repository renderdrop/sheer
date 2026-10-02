import {
  FolderOpen,
  Highlighter,
  LayoutGrid,
  MessageSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  PenLine,
  Signature,
  TextCursorInput,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { MenuEntries, MenuEntry, ToolbarEntry, ToolbarItem } from '../../components';
import type { Locale, Translate } from '../../i18n';
import { shellShortcuts } from '../../lib/shortcuts';
import type { Platform } from '../../api/app';
import { ZOOM_STEPS } from '../../lib/zoom';
import type { ToolId } from '../../stores/ui';
import { formatZoomStatus } from './status';

/** Two zoom values closer than this are the same preset (zoom steps are fractions like 0.67). */
const SAME_ZOOM = 0.005;

export interface ToolbarState {
  /** Translates the labels. The entries are rebuilt when it changes, which is when the language does. */
  t: Translate;
  platform: Platform | null;
  hasDocument: boolean;
  activeTool: ToolId;
  toolLocked: boolean;
  /** The left panel is shown (not collapsed by the user or by the layout). */
  leftPanelVisible: boolean;
  inspectorVisible: boolean;
  /** The zoom is at its minimum or maximum, which disables the zoom button that cannot go further. Two flags and not the zoom, so they flip only at the limits. */
  zoomAtMin: boolean;
  zoomAtMax: boolean;
  /** The readout's content: text, or an element that follows the zoom by itself so the toolbar need not re-render per step (`ZoomReadout`). */
  zoomText: ReactNode;
  /** The preset menu: a list, or a function that follows the zoom by itself (`useZoomMenu`). */
  zoomMenu: MenuEntries;
}

export interface ToolbarActions {
  open: () => void;
  selectTool: (tool: ToolId) => void;
  lockTool: (tool: ToolId) => void;
  toggleLeftPanel: () => void;
  toggleInspector: () => void;
  zoomStep: (direction: 1 | -1) => void;
}

/** The zoom presets as menu entries (the toolbar readout and the status bar's zoom button open the same menu). */
export function zoomMenuEntries(zoom: number, setZoom: (zoom: number) => void, locale: Locale): MenuEntry[] {
  return ZOOM_STEPS.map((step) => ({
    id: `zoom-${step}`,
    label: formatZoomStatus(step, locale),
    checked: Math.abs(step - zoom) < SAME_ZOOM,
    onSelect: () => setZoom(step),
  }));
}

/**
 * The toolbar of DESIGN 3.3 and ADR-011 section 6 as data for the Toolbar primitive: the panel toggle, then the four tool
 * clusters (Select, Markup, Fill and sign, Pages), More, a spacer, the zoom cluster and the inspector toggle. Without a
 * document every item is disabled, which the primitive renders as `aria-disabled` (still focusable, does nothing).
 *
 * When the toolbar is too narrow, items move into More in this order: Pages, Form, Signature, zoom out, zoom in. Select, the
 * Markup tools, the zoom readout and the two toggles stay.
 */
export function buildToolbar(
  state: ToolbarState,
  actions: ToolbarActions,
): { entries: ToolbarEntry[]; moreItems: MenuEntry[] } {
  const { hasDocument, t } = state;
  const keys = shellShortcuts(state.platform, t);

  const tool = (id: ToolId, label: string, icon: LucideIcon, collapse?: number): ToolbarItem => ({
    id,
    label,
    icon,
    kind: 'tool',
    pressed: state.activeTool === id,
    locked: state.activeTool === id && state.toolLocked,
    disabled: !hasDocument,
    collapse,
    onActivate: () => actions.selectTool(id),
    onLock: id === 'select' ? undefined : () => actions.lockTool(id),
  });

  const entries: ToolbarEntry[] = [
    {
      id: 'panels',
      label: t('toolbar.group.panels'),
      items: [
        {
          id: 'left-panel',
          label: t('toolbar.leftPanel'),
          icon: PanelLeft,
          kind: 'toggle',
          pressed: state.leftPanelVisible,
          disabled: !hasDocument,
          onActivate: actions.toggleLeftPanel,
        },
      ],
    },
    {
      id: 'select',
      label: t('toolbar.group.select'),
      items: [tool('select', t('toolbar.tool.select'), MousePointer2)],
    },
    {
      id: 'markup',
      label: t('toolbar.group.markup'),
      items: [
        tool('highlight', t('toolbar.tool.highlight'), Highlighter),
        tool('comment', t('toolbar.tool.comment'), MessageSquare),
        tool('draw', t('toolbar.tool.draw'), PenLine),
      ],
    },
    {
      id: 'fill-and-sign',
      label: t('toolbar.group.fillAndSign'),
      items: [
        tool('form', t('toolbar.tool.form'), TextCursorInput, 2),
        tool('signature', t('toolbar.tool.signature'), Signature, 3),
      ],
    },
    { id: 'pages', label: t('toolbar.group.pages'), items: [tool('pages', t('toolbar.tool.pages'), LayoutGrid, 1)] },
    { type: 'more', id: 'more' },
    { type: 'spacer', id: 'spacer' },
    {
      id: 'zoom',
      label: t('toolbar.group.zoom'),
      items: [
        {
          id: 'zoom-out',
          label: t('toolbar.zoomOut'),
          icon: ZoomOut,
          disabled: !hasDocument || state.zoomAtMin,
          shortcut: keys.zoomOut.label,
          keyShortcuts: keys.zoomOut.aria,
          collapse: 4,
          onActivate: () => actions.zoomStep(-1),
        },
        {
          id: 'zoom-level',
          label: t('toolbar.zoomLevel'),
          text: state.zoomText,
          disabled: !hasDocument,
          menu: state.zoomMenu,
        },
        {
          id: 'zoom-in',
          label: t('toolbar.zoomIn'),
          icon: ZoomIn,
          disabled: !hasDocument || state.zoomAtMax,
          shortcut: keys.zoomIn.label,
          keyShortcuts: keys.zoomIn.aria,
          collapse: 5,
          onActivate: () => actions.zoomStep(1),
        },
      ],
    },
    {
      id: 'inspector',
      label: t('toolbar.group.inspector'),
      items: [
        {
          id: 'inspector-toggle',
          label: t('toolbar.inspector'),
          icon: PanelRight,
          kind: 'toggle',
          pressed: state.inspectorVisible,
          disabled: !hasDocument,
          onActivate: actions.toggleInspector,
        },
      ],
    },
  ];

  // Open is not a toolbar item in the spec; until the native menu bar has it, More carries it, so a mouse user can open a file.
  const moreItems: MenuEntry[] = [
    { id: 'open', label: t('action.open'), icon: FolderOpen, shortcut: keys.open.label, onSelect: actions.open },
  ];

  return { entries, moreItems };
}
