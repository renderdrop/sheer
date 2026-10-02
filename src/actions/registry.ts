import {
  ChevronDown,
  ChevronUp,
  FileX,
  FolderOpen,
  Highlighter,
  Info,
  LayoutGrid,
  MessageSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Percent,
  PenLine,
  Maximize2,
  Settings,
  Signature,
  StretchHorizontal,
  TextCursorInput,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';

import type { Platform } from '../api/app';
import { readShellStructure } from '../features/shell/useShellStructure';
import { useViewer } from '../features/viewer/useViewer';
import type { PlainKey, Translate } from '../i18n';
import type { Shortcut } from '../lib/shortcuts';
import { useUi, type ToolId } from '../stores/ui';
import { formatBinding, resolveBinding, type Binding, type Shortcuts } from './shortcut';
import type { ActionState } from './state';

/** The action of each tool of the toolbar: it makes the tool the active one. */
export type ToolActionId = `tool-${ToolId}`;

/** The id of every action. These strings are also the native menu's item ids (`src/actions/menu.json`, the Rust allowlist). */
export type ActionId =
  | 'open'
  | 'close-document'
  | 'zoom-in'
  | 'zoom-out'
  | 'actual-size'
  | 'fit-width'
  | 'fit-page'
  | 'next-page'
  | 'previous-page'
  | 'toggle-left-panel'
  | 'toggle-inspector'
  | 'settings'
  | 'about'
  | ToolActionId;

/** Actions of one group sit together in the More menu, with a separator between groups. */
export type ActionGroup = 'file' | 'view' | 'page' | 'panels' | 'tools' | 'app';

/**
 * A command of the app: what the toolbar, the More menu, the macOS menu bar and the keyboard all run. It is defined once, here;
 * each of those derives what it shows (name, icon, shortcut, enabled) from this entry and runs `run`, so a command cannot be on
 * the toolbar and not on the keyboard, or have two different shortcuts.
 */
export interface ActionDef {
  readonly id: ActionId;
  /** The name in the catalogs, for the toolbar (tooltip, accessible name) and the More menu. */
  readonly labelKey: PlainKey;
  readonly icon?: LucideIcon;
  /** Canonical, per platform (`resolveBinding`). Absent: no shortcut. */
  readonly shortcut?: Shortcuts;
  readonly group: ActionGroup;
  /** Listed in the More menu: the toolbar's overflow, and on Windows (which has no menu bar) the way to every command. */
  readonly more?: boolean;
  /** Listed in the macOS menu bar. `src/actions/menu.json` has the layout; a test ties the two together. */
  readonly menuBar?: boolean;
  /** A held key repeats the action (zoom, page turning). Otherwise only the first press runs it. */
  readonly repeat?: boolean;
  /** Whether it can run now. The shortcut still belongs to the action when it cannot (it never reaches the webview's own). */
  readonly enabled: (state: ActionState) => boolean;
  readonly run: () => void;
}

const primary = (key: string): Binding => ({ key, mods: ['primary'] });
const needsDocument = (state: ActionState): boolean => state.hasDocument;

/** The tools' actions, one per tool of the toolbar. */
const TOOL_ACTIONS: readonly ActionDef[] = (
  [
    ['select', 'v', MousePointer2],
    ['highlight', 'h', Highlighter],
    ['comment', 'c', MessageSquare],
    ['draw', 'd', PenLine],
    ['form', 'f', TextCursorInput],
    ['signature', 's', Signature],
    ['pages', 'p', LayoutGrid],
  ] as const satisfies readonly (readonly [ToolId, string, LucideIcon])[]
).map(([tool, key, icon]): ActionDef => ({
  id: `tool-${tool}`,
  labelKey: `toolbar.tool.${tool}`,
  icon,
  shortcut: { default: { key } },
  group: 'tools',
  enabled: needsDocument,
  // The key makes the tool active and leaves it so; it is not the toolbar's click, which also releases an active tool.
  run: () => {
    const ui = useUi.getState();
    if (ui.activeTool !== tool) ui.selectTool(tool);
  },
}));

/**
 * Where the shortcuts come from (docs/research/ux-patterns.md section 5). macOS: Command is primary, avoid Control. Windows:
 * Ctrl accelerators, no Ctrl+Alt (AltGr). Cmd or Ctrl with 0, 1, 2 are Acrobat's fit page, 100 % and fit width; they are the same
 * on macOS, where the research found Preview's keys unverified. The panel toggles (Option+Cmd+1 on macOS, F4 and Shift+F4
 * on Windows), the inspector's Option+Cmd+I and the page keys are not in the research: Option or Alt with the arrows are
 * chosen because they do not scroll the canvas. The tool letters are DESIGN 3.3's; they work only with the canvas focused.
 */
export const ACTIONS: readonly ActionDef[] = [
  {
    id: 'open',
    labelKey: 'action.open',
    icon: FolderOpen,
    shortcut: { default: primary('o') },
    group: 'file',
    more: true,
    menuBar: true,
    enabled: () => true,
    run: () => void useViewer.getState().open(),
  },
  {
    id: 'close-document',
    labelKey: 'action.closeDocument',
    icon: FileX,
    shortcut: { default: primary('w') },
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().close(),
  },
  {
    id: 'zoom-in',
    labelKey: 'toolbar.zoomIn',
    icon: ZoomIn,
    shortcut: { default: primary('Plus') },
    group: 'view',
    menuBar: true,
    repeat: true,
    enabled: (state) => state.hasDocument && !state.zoomAtMax,
    run: () => useViewer.getState().zoomStep(1),
  },
  {
    id: 'zoom-out',
    labelKey: 'toolbar.zoomOut',
    icon: ZoomOut,
    shortcut: { default: primary('Minus') },
    group: 'view',
    menuBar: true,
    repeat: true,
    enabled: (state) => state.hasDocument && !state.zoomAtMin,
    run: () => useViewer.getState().zoomStep(-1),
  },
  {
    id: 'actual-size',
    labelKey: 'action.actualSize',
    icon: Percent,
    shortcut: { default: primary('1') },
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().resetZoom(),
  },
  {
    id: 'fit-width',
    labelKey: 'action.fitWidth',
    icon: StretchHorizontal,
    shortcut: { default: primary('2') },
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().fitWidth(),
  },
  {
    id: 'fit-page',
    labelKey: 'action.fitPage',
    icon: Maximize2,
    shortcut: { default: primary('0') },
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().fitPage(),
  },
  {
    id: 'next-page',
    labelKey: 'action.nextPage',
    icon: ChevronDown,
    shortcut: { default: { key: 'ArrowDown', mods: ['alt'] } },
    group: 'page',
    more: true,
    menuBar: true,
    repeat: true,
    enabled: needsDocument,
    run: () => useViewer.getState().nextPage(),
  },
  {
    id: 'previous-page',
    labelKey: 'action.previousPage',
    icon: ChevronUp,
    shortcut: { default: { key: 'ArrowUp', mods: ['alt'] } },
    group: 'page',
    more: true,
    menuBar: true,
    repeat: true,
    enabled: needsDocument,
    run: () => useViewer.getState().previousPage(),
  },
  {
    id: 'toggle-left-panel',
    labelKey: 'toolbar.leftPanel',
    icon: PanelLeft,
    shortcut: { default: { key: 'F4' }, macos: { key: '1', mods: ['alt', 'primary'] } },
    group: 'panels',
    menuBar: true,
    enabled: needsDocument,
    run: () => useUi.getState().setLeftPanelCollapsed(!readShellStructure().leftCollapsed),
  },
  {
    id: 'toggle-inspector',
    labelKey: 'toolbar.inspector',
    icon: PanelRight,
    shortcut: { default: { key: 'F4', mods: ['shift'] }, macos: { key: 'i', mods: ['alt', 'primary'] } },
    group: 'panels',
    menuBar: true,
    enabled: needsDocument,
    run: () => useUi.getState().setInspector(readShellStructure().inspectorVisible ? 'closed' : 'open'),
  },
  ...TOOL_ACTIONS,
  {
    id: 'settings',
    labelKey: 'action.settings',
    icon: Settings,
    shortcut: { default: primary(',') },
    group: 'app',
    more: true,
    menuBar: true,
    enabled: () => true,
    // A placeholder until the settings popover lands (ROADMAP, Phase 3): the command, its shortcut and its menu entries
    // exist, so that item only has to replace this function.
    run: () => undefined,
  },
  {
    id: 'about',
    labelKey: 'action.about',
    icon: Info,
    group: 'app',
    more: true,
    enabled: () => true,
    // A placeholder like `settings`. The macOS menu bar has the system's own About panel (menu.json), so no `menuBar` here.
    run: () => undefined,
  },
];

/** Every id, in registry order (for tests and the menu allowlist check). */
export const ACTION_IDS: readonly ActionId[] = ACTIONS.map((action) => action.id);

const BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((action) => [action.id, action]));

/** The action with this id; `undefined` for anything that is not one (a menu message from outside is never trusted). */
export function getAction(id: string): ActionDef | undefined {
  return BY_ID.get(id);
}

/** The action with this id. Every `ActionId` has one (a test checks it), so this cannot fail for an id the types accept. */
export function actionOf(id: ActionId): ActionDef {
  const action = BY_ID.get(id);
  if (action === undefined) throw new Error(`no action ${id}`);
  return action;
}

/** The shortcut of `action` on `platform` as the UI shows and announces it, or `null` when it has none there. */
export function actionShortcut(action: ActionDef, platform: Platform | null, t: Translate): Shortcut | null {
  const binding = resolveBinding(action.shortcut, platform);
  return binding === null ? null : formatBinding(binding, platform, t);
}

/** The shortcut of the action with this id; see `actionShortcut`. */
export function shortcutFor(id: ActionId, platform: Platform | null, t: Translate): Shortcut | null {
  return actionShortcut(actionOf(id), platform, t);
}
