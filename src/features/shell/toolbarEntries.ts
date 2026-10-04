import {
  Circle,
  Highlighter,
  MessageSquare,
  Minus,
  MoveUpRight,
  Square,
  Strikethrough,
  Type,
  Underline,
  type LucideIcon,
} from 'lucide-react';

import { actionOf, actionShortcut, type ActionDef, type ActionId } from '../../actions/registry';
import type { ActionState } from '../../actions/state';
import type { MenuEntry, ToolbarGroup, ToolbarItem } from '../../components';
import type { Locale, Translate } from '../../i18n';
import type { Platform } from '../../api/app';
import { ZOOM_STEPS } from '../../lib/zoom';
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
  /** What the actions' `enabled` looks at. */
  action: ActionState;
  activeTool: ToolId;
  /** Redact mode is on (DESIGN 3.38): the Redact item is pressed. */
  redactMode?: boolean;
  /** The open document cannot change (the tour sample): the Sign and Redact tools are aria-disabled. */
  readOnly?: boolean;
  toolLocked: boolean;
  /** The remembered variants of Markup and Shapes (DESIGN 3.22): they name the tool and choose its icon. Highlight and Rectangle by default. */
  markupVariant?: MarkupVariant;
  shapeVariant?: ShapeVariant;
  /** The left panel is shown (not collapsed by the user or by the layout). */
  leftPanelVisible: boolean;
  inspectorVisible: boolean;
}

export interface ToolbarActions {
  /** Runs an action of the registry (`runAction`). */
  run: (id: ActionId) => void;
  /**
   * A click on a tool toggles it (it releases the active one), which is not what its key does, so these two are the toolbar's
   * own variants of the tool's action. They still obey the registry's `enabled` at the moment of the click (`ToolbarSlot`).
   */
  selectTool: (tool: ToolId) => void;
  lockTool: (tool: ToolId) => void;
  /** The Redact item: ends the mode when it is on, else runs `tool-redact`. */
  toggleRedact: () => void;
}

/** The zoom presets as menu entries (the status bar's zoom button opens this menu). */
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

/** The tools that change the document: aria-disabled with `tool.readOnly` in a read-only one (DESIGN 3.36). */
const WRITE_TOOLS: ReadonlySet<string> = new Set<string>(['signature', 'redact']);

/** What an action contributes to a toolbar item: its name and icon, its shortcut on this platform, and whether it can run. */
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
 * The toolbar of DESIGN 3.55 as data: the two panel toggles that frame the card, and the tool card's seven tools in three groups
 * (Select; Highlight, Comment, Draw, Shapes; Fill & Sign, Redact). Names, icons, shortcuts and the enabled state come from the
 * action registry. Without a document every item is disabled, which renders as `aria-disabled` (still focusable, does nothing).
 */
export function buildToolbar(
  state: ToolbarState,
  actions: ToolbarActions,
): { leading: ToolbarItem; trailing: ToolbarItem; groups: ToolbarGroup[] } {
  const { t } = state;
  const markup = state.markupVariant ?? 'highlight';
  const shapes = state.shapeVariant ?? 'rect';
  const redactOn = state.redactMode === true;

  const tool = (id: ToolId): ToolbarItem => {
    const {
      label: baseLabel,
      icon: baseIcon,
      shortcut,
      keyShortcuts,
      disabled,
    } = describe(actionOf(`tool-${id}`), state);
    const nameKey = toolNameKey(id, { markup, shapes });
    const label = id === 'note' ? t('toolbar.tool.comment') : nameKey === null ? baseLabel : t(nameKey);
    // Comment is one item for its two variants: Note, and Text comment (DESIGN 3.55).
    const commentActive = state.activeTool === 'note' || state.activeTool === 'text';
    const icon =
      id === 'highlight'
        ? MARKUP_ICONS[markup]
        : id === 'shapes'
          ? SHAPE_ICONS[shapes]
          : id === 'note'
            ? state.activeTool === 'text'
              ? Type
              : MessageSquare
            : baseIcon;
    const pressed =
      id === 'select' ? false : id === 'note' ? commentActive && !redactOn : state.activeTool === id && !redactOn;
    return {
      id,
      label,
      icon,
      shortcut,
      keyShortcuts,
      kind: 'tool',
      pressed,
      locked: pressed && state.toolLocked,
      disabled: disabled || (WRITE_TOOLS.has(id) && state.readOnly === true),
      // The Sign tool opens a menu of what to place (DESIGN 3.34) instead of toggling.
      menu: id === 'signature' ? useSignMenuEntries : undefined,
      onActivate: () => actions.selectTool(id === 'note' && state.activeTool === 'text' ? 'text' : id),
      onLock: id === 'select' ? undefined : () => actions.lockTool(id),
    };
  };

  const select = tool('select');
  // Select is the tool that is on when nothing else is.
  const selectItem: ToolbarItem = {
    ...select,
    pressed: state.activeTool === 'select' && !redactOn,
  };

  const redactDescribed = describe(actionOf('tool-redact'), state);
  const redact: ToolbarItem = {
    id: 'redact',
    label: t('toolbar.tool.redact'),
    icon: redactDescribed.icon,
    shortcut: redactDescribed.shortcut,
    keyShortcuts: redactDescribed.keyShortcuts,
    kind: 'tool',
    pressed: redactOn,
    disabled: redactDescribed.disabled || state.readOnly === true,
    onActivate: actions.toggleRedact,
  };
  const sign = tool('signature');
  const signItem: ToolbarItem = { ...sign, label: t('toolbar.tool.fillSign') };

  const toggle = (id: 'toggle-left-panel' | 'toggle-inspector', itemId: string, pressed: boolean): ToolbarItem => ({
    id: itemId,
    ...describe(actionOf(id), state),
    kind: 'toggle',
    pressed,
    onActivate: () => actions.run(id),
  });

  return {
    leading: toggle('toggle-left-panel', 'left-panel', state.leftPanelVisible),
    trailing: toggle('toggle-inspector', 'inspector-toggle', state.inspectorVisible),
    groups: [
      { id: 'select', label: t('toolbar.group.select'), items: [selectItem] },
      {
        id: 'markup',
        label: t('toolbar.group.markup'),
        items: [tool('highlight'), tool('note'), tool('draw'), tool('shapes')],
      },
      { id: 'document', label: t('toolbar.group.document'), items: [signItem, redact] },
    ],
  };
}
