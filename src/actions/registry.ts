import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Combine,
  FileArchive,
  FileOutput,
  Scissors,
  File,
  FileX,
  Save,
  SaveAll,
  FolderOpen,
  GalleryVertical,
  Highlighter,
  Info,
  LayoutGrid,
  MessageSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  ListOrdered,
  Percent,
  PenLine,
  Square,
  Redo2,
  RotateCcw,
  RotateCw,
  Search,
  Maximize2,
  Settings,
  Signature,
  StretchHorizontal,
  TextCursorInput,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';

import type { Platform } from '../api/app';
import { toggleAbout } from '../features/about/state';
import { stepHit } from '../features/search/jump';
import { organizeActive, rotateOrganized } from '../features/organize/actions';
import { openSearch } from '../features/search/commands';
import { openSettings } from '../features/settings/state';
import { useGoToPage } from '../features/shell/goToState';
import { readShellStructure } from '../features/shell/useShellStructure';
import { runCompress, runExtract, runMerge, runSplit } from '../features/jobs/actions';
import { saveActive } from '../features/save/commands';
import { closeTab, cycleTab } from '../features/tabs/nav';
import { useDocuments } from '../stores/documents';
import { useViewer } from '../features/viewer/useViewer';
import type { PlainKey, Translate } from '../i18n';
import type { Shortcut } from '../lib/shortcuts';
import { useTools } from '../stores/tools';
import { useUi, type ToolId } from '../stores/ui';
import { runHistoryStep } from './history';
import { formatBinding, resolveBinding, type Binding, type Shortcuts } from './shortcut';
import type { ActionState } from './state';

/** The action of each tool of the toolbar: it makes the tool the active one. */
export type ToolActionId = `tool-${ToolId}`;

/** The id of every action. These strings are also the native menu's item ids (`src/actions/menu.json`, the Rust allowlist). */
export type ActionId =
  | 'open'
  | 'close-document'
  | 'save'
  | 'save-as'
  | 'merge-files'
  | 'split-document'
  | 'extract-pages'
  | 'compress-document'
  | 'undo'
  | 'redo'
  | 'zoom-in'
  | 'zoom-out'
  | 'actual-size'
  | 'fit-width'
  | 'fit-page'
  | 'scroll-continuous'
  | 'scroll-single'
  | 'scroll-spread'
  | 'next-page'
  | 'previous-page'
  | 'go-to-page'
  | 'find'
  | 'find-next'
  | 'find-previous'
  | 'rotate-view-right'
  | 'rotate-view-left'
  | 'rotate-view-reset'
  | 'next-tab'
  | 'previous-tab'
  | 'toggle-left-panel'
  | 'toggle-inspector'
  | 'settings'
  | 'about'
  | ToolActionId;

/** Actions of one group sit together in the More menu, with a separator between groups. */
export type ActionGroup = 'file' | 'edit' | 'view' | 'page' | 'panels' | 'tools' | 'app';

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
    ['note', 'n', MessageSquare],
    ['text', 't', Type],
    ['draw', 'd', PenLine],
    ['shapes', 'r', Square],
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
    // Markup and Shapes: the key of the active tool goes on to its next variant (DESIGN 3.22).
    else if (tool === 'highlight' || tool === 'shapes') useTools.getState().cycle(tool);
  },
}));

/**
 * Where the shortcuts come from (docs/research/ux-patterns.md section 5). macOS: Command is primary, avoid Control. Windows:
 * Ctrl accelerators, no Ctrl+Alt (AltGr). Cmd or Ctrl with 0, 1, 2 are Acrobat's fit page, 100 % and fit width; they are the same
 * on macOS, where the research found Preview's keys unverified. The panel toggles (Option+Cmd+1 on macOS, F4 and Shift+F4
 * on Windows), the inspector's Option+Cmd+I and the page keys are not in the research, so they are chosen here. Next and
 * previous page are Cmd (macOS) or Ctrl (Windows) with the Down and Up arrows: Option or Alt with the arrows is the left
 * panel's Move up and Move down for a thumbnail (DESIGN 3.9), and the native menu's key equivalent would take it from that
 * list; PageDown and PageUp stay with the canvas and the panels' scrolling (a zoomed page is taller than the window). The
 * arrows alone and Shift with them are the browser's (scrolling, selecting). The tool letters are DESIGN 3.3's; they work
 * only with the canvas focused.
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
    run: () => {
      const id = useDocuments.getState().activeId;
      if (id !== null) closeTab(id);
    },
  },
  {
    id: 'save',
    labelKey: 'save.save',
    icon: Save,
    shortcut: { default: primary('s') },
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => saveActive(false),
  },
  {
    id: 'save-as',
    labelKey: 'save.saveAs',
    icon: SaveAll,
    shortcut: { default: { key: 's', mods: ['primary', 'shift'] } },
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => saveActive(true),
  },
  {
    id: 'merge-files',
    labelKey: 'action.merge',
    icon: Combine,
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: runMerge,
  },
  {
    id: 'split-document',
    labelKey: 'action.split',
    icon: Scissors,
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: runSplit,
  },
  {
    id: 'extract-pages',
    labelKey: 'action.extractPages',
    icon: FileOutput,
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: runExtract,
  },
  {
    id: 'compress-document',
    labelKey: 'action.compress',
    icon: FileArchive,
    group: 'file',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: runCompress,
  },
  {
    id: 'undo',
    labelKey: 'action.undo',
    icon: Undo2,
    shortcut: { default: primary('z') },
    group: 'edit',
    more: true,
    menuBar: true,
    enabled: (state) => state.hasDocument && state.canUndo,
    run: () => runHistoryStep('undo'),
  },
  {
    id: 'redo',
    labelKey: 'action.redo',
    icon: Redo2,
    // Ctrl+Y is Windows' Redo, Cmd+Shift+Z is macOS's; Ctrl+Shift+Z works on Windows too, as in most editors.
    shortcut: {
      default: primary('y'),
      macos: { key: 'z', mods: ['primary', 'shift'] },
      alternates: [{ key: 'z', mods: ['primary', 'shift'] }],
    },
    group: 'edit',
    more: true,
    menuBar: true,
    enabled: (state) => state.hasDocument && state.canRedo,
    run: () => runHistoryStep('redo'),
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
    id: 'scroll-continuous',
    labelKey: 'action.scrollContinuous',
    icon: GalleryVertical,
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().setScrollMode('continuous'),
  },
  {
    id: 'scroll-single',
    labelKey: 'action.scrollSingle',
    icon: File,
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().setScrollMode('single'),
  },
  {
    id: 'scroll-spread',
    labelKey: 'action.scrollSpread',
    icon: BookOpen,
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().setScrollMode('spread'),
  },
  {
    id: 'next-page',
    labelKey: 'action.nextPage',
    icon: ChevronDown,
    shortcut: { default: primary('ArrowDown') },
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
    shortcut: { default: primary('ArrowUp') },
    group: 'page',
    more: true,
    menuBar: true,
    repeat: true,
    enabled: needsDocument,
    run: () => useViewer.getState().previousPage(),
  },
  {
    id: 'next-tab',
    labelKey: 'action.nextTab',
    // Ctrl+Tab on both platforms is the tab strip's own handler (it needs the Control key on macOS, which a binding never has);
    // these are the others: Ctrl+PageDown on Windows, Cmd+Shift+] on macOS, where the menu bar shows it (DESIGN 3.18).
    shortcut: { default: primary('PageDown'), macos: { key: ']', mods: ['primary', 'shift'] } },
    group: 'page',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => cycleTab(1),
  },
  {
    id: 'previous-tab',
    labelKey: 'action.previousTab',
    shortcut: { default: primary('PageUp'), macos: { key: '[', mods: ['primary', 'shift'] } },
    group: 'page',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => cycleTab(-1),
  },
  {
    id: 'go-to-page',
    labelKey: 'action.goToPage',
    icon: ListOrdered,
    shortcut: { default: { key: 'n', mods: ['primary', 'shift'] } },
    group: 'page',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    // The status bar's popover opens with the page field selected (src/features/shell/StatusBar).
    run: () => useGoToPage.getState().setOpen(true),
  },
  {
    id: 'find',
    labelKey: 'action.find',
    icon: Search,
    shortcut: { default: primary('f') },
    group: 'page',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: openSearch,
  },
  {
    id: 'find-next',
    labelKey: 'action.findNext',
    icon: ChevronDown,
    shortcut: { default: primary('g') },
    group: 'page',
    more: true,
    menuBar: true,
    repeat: true,
    enabled: needsDocument,
    run: () => stepHit(1),
  },
  {
    id: 'find-previous',
    labelKey: 'action.findPrevious',
    icon: ChevronUp,
    shortcut: { default: { key: 'g', mods: ['primary', 'shift'] } },
    group: 'page',
    more: true,
    menuBar: true,
    repeat: true,
    enabled: needsDocument,
    run: () => stepHit(-1),
  },
  {
    id: 'rotate-view-right',
    labelKey: 'rotate.right',
    icon: RotateCw,
    shortcut: { default: primary('r') },
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => {
      if (!rotateOrganized(1)) useViewer.getState().rotateView(90);
    },
  },
  {
    id: 'rotate-view-left',
    labelKey: 'rotate.left',
    icon: RotateCcw,
    shortcut: { default: primary('l') },
    group: 'view',
    more: true,
    menuBar: true,
    enabled: needsDocument,
    run: () => {
      if (!rotateOrganized(-1)) useViewer.getState().rotateView(-90);
    },
  },
  {
    id: 'rotate-view-reset',
    labelKey: 'rotate.reset',
    group: 'view',
    more: true,
    menuBar: true,
    // The view rotation is off in the page grid (DESIGN 3.28).
    enabled: (state) => state.hasDocument && !organizeActive(),
    run: () => useViewer.getState().resetRotation(),
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
    // The popover under the toolbar (src/features/settings), wherever the command came from.
    run: openSettings,
  },
  {
    id: 'about',
    labelKey: 'action.about',
    icon: Info,
    group: 'app',
    more: true,
    enabled: () => true,
    // The dialog (src/features/about): opens it, and closes it when it is open (the one command that runs while a modal is open).
    // The macOS menu bar has the system's own About panel (menu.json), so no `menuBar` here.
    run: toggleAbout,
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
