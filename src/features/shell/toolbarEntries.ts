import {
  Circle,
  Highlighter,
  Minus,
  MoveUpRight,
  Square,
  Strikethrough,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { actionOf, actionShortcut, ACTIONS, type ActionDef, type ActionId } from '../../actions/registry';
import type { ActionState } from '../../actions/state';
import type { MenuEntries, MenuEntry, ToolbarEntry, ToolbarItem } from '../../components';
import type { Locale, Translate } from '../../i18n';
import type { Platform } from '../../api/app';
import { ZOOM_STEPS } from '../../lib/zoom';
import type { ScrollMode } from '../viewer/layout';
import { toolNameKey, type MarkupVariant, type ShapeVariant } from '../../stores/tools';
import type { ToolId } from '../../stores/ui';
import { useSignMenuEntries } from '../signatures/place/menu';
import { formatZoomStatus } from './status';

/** Two zoom values closer than this are the same preset (zoom steps are fractions like 0.67). */
const SAME_ZOOM = 0.005;

export interface ToolbarState {
  /** Translates the labels. The entries are rebuilt when it changes, which is when the language does. */
  t: Translate;
  platform: Platform | null;
  /** What the actions' `enabled` looks at: whether a document is open, and the two zoom limits. */
  action: ActionState;
  /** How the open document's pages are laid out: the More menu checks the matching entry. */
  scrollMode: ScrollMode;
  activeTool: ToolId;
  /** The open document cannot change (the tour sample): the Pages tool is aria-disabled. */
  readOnly?: boolean;
  toolLocked: boolean;
  /** The remembered variants of Markup and Shapes (DESIGN 3.22): they name the tool and choose its icon. Highlight and Rectangle by default. */
  markupVariant?: MarkupVariant;
  shapeVariant?: ShapeVariant;
  /** The left panel is shown (not collapsed by the user or by the layout). */
  leftPanelVisible: boolean;
  inspectorVisible: boolean;
  /** The readout's content: text, or an element that follows the zoom by itself so the toolbar need not re-render per step (`ZoomReadout`). */
  zoomText: ReactNode;
  /** The preset menu: a list, or a function that follows the zoom by itself (`useZoomMenu`). */
  zoomMenu: MenuEntries;
}

export interface ToolbarActions {
  /** Runs an action of the registry (`runAction`): the toolbar's buttons and the More menu all go through it. */
  run: (id: ActionId) => void;
  /**
   * A click on a tool toggles it (it releases the active one), which is not what its key does, so these two are the toolbar's
   * own variants of the tool's action. They still obey the registry's `enabled` at the moment of the click (`ToolbarSlot`).
   */
  selectTool: (tool: ToolId) => void;
  lockTool: (tool: ToolId) => void;
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

const MARKUP_ICONS: Readonly<Record<MarkupVariant, LucideIcon>> = {
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
};
const SHAPE_ICONS: Readonly<Record<ShapeVariant, LucideIcon>> = {
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: MoveUpRight,
};

/** The scroll mode that each of the three layout actions chooses. */
const SCROLL_MODE_OF: Partial<Record<ActionId, ScrollMode>> = {
  'scroll-continuous': 'continuous',
  'scroll-single': 'single',
  'scroll-spread': 'spread',
};

/** What an action contributes to a toolbar item or menu entry: its name and icon, its shortcut on this platform, and whether it can run. */
function describe(action: ActionDef, state: Pick<ToolbarState, 't' | 'platform' | 'action'>) {
  const shortcut = actionShortcut(action, state.platform, state.t);
  return {
    label: state.t(action.labelKey),
    icon: action.icon,
    shortcut: shortcut?.label,
    keyShortcuts: shortcut?.aria,
    disabled: !action.enabled(state.action),
  };
}

/**
 * The More menu's fixed entries: every action of the registry that is marked `more`, grouped (file, view, page, app) with a
 * separator between groups. On Windows, which has no menu bar, this and the toolbar are how a mouse user reaches every command;
 * the keyboard has them all too. The items that overflow out of the toolbar are appended after these (the Toolbar primitive does that).
 */
export function buildMoreItems(
  state: Pick<ToolbarState, 't' | 'platform' | 'action'> & Partial<Pick<ToolbarState, 'scrollMode'>>,
  run: (id: ActionId) => void,
): MenuEntry[] {
  const items: MenuEntry[] = [];
  let group: string | null = null;
  for (const action of ACTIONS) {
    if (action.more !== true) continue;
    if (group !== null && group !== action.group) items.push({ type: 'separator', id: `${action.group}:before` });
    group = action.group;
    const { label, icon, shortcut, disabled } = describe(action, state);
    // The three ways to lay pages out are a choice of one: the current one is checked.
    const mode = SCROLL_MODE_OF[action.id];
    const checked = mode === undefined || state.scrollMode === undefined ? undefined : state.scrollMode === mode;
    items.push({ id: action.id, label, icon, shortcut, disabled, checked, onSelect: () => run(action.id) });
  }
  return items;
}

/**
 * The order in which items move into More when the toolbar is too narrow: the lowest number goes first (Redo, Undo, Pages, Form,
 * Signature, zoom out, zoom in).
 */
const COLLAPSE_ORDER = { redo: 1, undo: 2, pages: 3, form: 4, signature: 5, zoomOut: 6, zoomIn: 7 } as const;

/**
 * The toolbar of DESIGN 3.3 and ADR-011 section 6 as data for the Toolbar primitive: the panel toggle, then the four tool
 * clusters (Select, Markup, Fill and sign, Pages), Undo and Redo, More, a spacer, the zoom cluster and the inspector toggle. Names, icons,
 * shortcuts and the enabled state of every item come from the action registry (`src/actions`), and so does the More menu
 * (`buildMoreItems`). Without a document every item is disabled, which the primitive renders as `aria-disabled` (still
 * focusable, does nothing).
 *
 * When the toolbar is too narrow, items move into More in this order: Redo, Undo, Pages, Form, Signature, zoom out, zoom in. Select, the
 * Markup tools, the zoom readout and the two toggles stay.
 */
export function buildToolbar(
  state: ToolbarState,
  actions: ToolbarActions,
): { entries: ToolbarEntry[]; moreItems: MenuEntry[] } {
  const { t } = state;
  const hasDocument = state.action.hasDocument;
  const described = (id: ActionId) => describe(actionOf(id), state);

  const tool = (id: ToolId, collapse?: number): ToolbarItem => {
    const { label: baseLabel, icon: baseIcon, shortcut, keyShortcuts, disabled } = described(`tool-${id}`);
    // Markup and Shapes are named, and drawn, as the variant they are on now.
    const markup = state.markupVariant ?? 'highlight';
    const shapes = state.shapeVariant ?? 'rect';
    const nameKey = toolNameKey(id, { markup, shapes });
    const label = nameKey === null ? baseLabel : t(nameKey);
    const icon = id === 'highlight' ? MARKUP_ICONS[markup] : id === 'shapes' ? SHAPE_ICONS[shapes] : baseIcon;
    return {
      id,
      label,
      icon,
      shortcut,
      keyShortcuts,
      kind: 'tool',
      pressed: state.activeTool === id,
      locked: state.activeTool === id && state.toolLocked,
      disabled: disabled || ((id === 'pages' || id === 'signature') && state.readOnly === true),
      collapse,
      // The Sign tool opens a menu of what to place (DESIGN 3.34) instead of toggling.
      menu: id === 'signature' ? useSignMenuEntries : undefined,
      onActivate: () => actions.selectTool(id),
      onLock: id === 'select' ? undefined : () => actions.lockTool(id),
    };
  };

  const zoom = (id: 'zoom-in' | 'zoom-out', collapse: number): ToolbarItem => ({
    id,
    ...described(id),
    collapse,
    onActivate: () => actions.run(id),
  });

  const history = (id: 'undo' | 'redo', collapse: number): ToolbarItem => ({
    id,
    ...described(id),
    collapse,
    onActivate: () => actions.run(id),
  });

  const toggle = (id: 'toggle-left-panel' | 'toggle-inspector', itemId: string, pressed: boolean): ToolbarItem => ({
    id: itemId,
    ...described(id),
    kind: 'toggle',
    pressed,
    onActivate: () => actions.run(id),
  });

  const entries: ToolbarEntry[] = [
    {
      id: 'panels',
      label: t('toolbar.group.panels'),
      items: [toggle('toggle-left-panel', 'left-panel', state.leftPanelVisible)],
    },
    { id: 'select', label: t('toolbar.group.select'), items: [tool('select')] },
    {
      id: 'markup',
      label: t('toolbar.group.markup'),
      items: [tool('highlight'), tool('note'), tool('text'), tool('draw'), tool('shapes')],
    },
    {
      id: 'fill-and-sign',
      label: t('toolbar.group.fillAndSign'),
      items: [tool('form', COLLAPSE_ORDER.form), tool('signature', COLLAPSE_ORDER.signature)],
    },
    { id: 'pages', label: t('toolbar.group.pages'), items: [tool('pages', COLLAPSE_ORDER.pages)] },
    {
      id: 'history',
      label: t('toolbar.group.history'),
      items: [history('undo', COLLAPSE_ORDER.undo), history('redo', COLLAPSE_ORDER.redo)],
    },
    { type: 'more', id: 'more' },
    { type: 'spacer', id: 'spacer' },
    {
      id: 'zoom',
      label: t('toolbar.group.zoom'),
      items: [
        zoom('zoom-out', COLLAPSE_ORDER.zoomOut),
        {
          id: 'zoom-level',
          label: t('toolbar.zoomLevel'),
          text: state.zoomText,
          disabled: !hasDocument,
          menu: state.zoomMenu,
        },
        zoom('zoom-in', COLLAPSE_ORDER.zoomIn),
      ],
    },
    {
      id: 'inspector',
      label: t('toolbar.group.inspector'),
      items: [toggle('toggle-inspector', 'inspector-toggle', state.inspectorVisible)],
    },
  ];

  return { entries, moreItems: buildMoreItems(state, actions.run) };
}
