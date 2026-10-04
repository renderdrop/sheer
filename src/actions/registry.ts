import {
  BookOpen,
  House,
  ChevronDown,
  ChevronUp,
  Combine,
  Crop,
  Hand,
  ScanSearch,
  TextSelect,
  Stamp,
  FileArchive,
  FileImage,
  FileOutput,
  Images,
  Printer,
  Scissors,
  File,
  FileText,
  FileX,
  Save,
  SaveAll,
  FolderOpen,
  GalleryVertical,
  Highlighter,
  ImagePlus,
  Info,
  LayoutGrid,
  Lock,
  MessageSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  ListOrdered,
  Percent,
  PenLine,
  Square,
  SquareSlash,
  TextCursor,
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
import { closeWindow } from '../api/window';
import { runFlatten } from '../features/forms/actions';
import { useForms } from '../features/forms/store';
import { openSignatureLibrary } from '../features/signatures/library';
import { restartTour } from '../features/tour/runtime';
import { resetTips } from '../features/tips/runtime';
import { useAnnotations } from '../stores/annotations';
import { toggleAbout } from '../features/about/state';
import { stepHit } from '../features/search/jump';
import { organizeActive, rotateOrganized } from '../features/organize/actions';
import { openSearch } from '../features/search/commands';
import { openSettings } from '../features/settings/state';
import { useGoToPage } from '../features/topbar/goToState';
import { readShellStructure } from '../features/shell/useShellStructure';
import { runCompress, runExtract, runMerge, runSplit } from '../features/jobs/actions';
import { saveActive } from '../features/save/commands';
import { closeTab, cycleTab } from '../features/tabs/nav';
import { useDocuments } from '../stores/documents';
import { useViewer } from '../features/viewer/useViewer';
import type { PlainKey, Translate } from '../i18n';
import type { Shortcut } from '../lib/shortcuts';
import { useTools } from '../stores/tools';
import { useUi, type LeftPanelTab, type ToolId } from '../stores/ui';
import { requestAddComment } from './commentIntent';
import { runHistoryStep } from './history';
import { formatBinding, resolveBinding, type Binding, type Shortcuts } from './shortcut';
import { mayCopy, mayPrint, type ActionState } from './state';

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
  | 'flatten-form'
  | 'next-tab'
  | 'previous-tab'
  | 'toggle-left-panel'
  | 'toggle-inspector'
  | 'view-home'
  | 'settings'
  | 'about'
  | 'redact'
  | 'protect'
  | 'document-properties'
  | 'images-to-pdf'
  | 'export-copy'
  | 'export-images'
  | 'print'
  | 'exit'
  | 'fullscreen'
  | 'delete-selection'
  | 'add-comment'
  | 'sidebar-tab-pages'
  | 'sidebar-tab-outline'
  | 'sidebar-tab-comments'
  | 'sidebar-tab-search'
  | 'tool-redact'
  | 'form-highlight'
  | 'manage-signatures'
  | 'welcome-tour'
  | 'reset-tips'
  | ToolActionId;

/** Where an action belongs (the menu bar's layout is `menu.json`; the group is for readers and tests). */
export type ActionGroup = 'file' | 'output' | 'edit' | 'view' | 'page' | 'panels' | 'tools' | 'app';

/**
 * A command of the app: what the toolbar, the menu bars (native on macOS, in the caption row on Windows) and the keyboard all run. It is defined once, here;
 * each of those derives what it shows (name, icon, shortcut, enabled) from this entry and runs `run`, so a command cannot be on
 * the toolbar and not on the keyboard, or have two different shortcuts.
 */
export interface ActionDef {
  readonly id: ActionId;
  /** The name in the catalogs, for the toolbar (tooltip, accessible name). The menus use the labels of `menu.json`. */
  readonly labelKey: PlainKey;
  readonly icon?: LucideIcon;
  /** Canonical, per platform (`resolveBinding`). Absent: no shortcut. */
  readonly shortcut?: Shortcuts;
  readonly group: ActionGroup;
  /** Listed in the menu bars. `src/actions/menu.json` has the layout; a test ties the two together. */
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
    ['select', 'v', MousePointer2, 'toolbar.tool.select'],
    ['highlight', 'h', Highlighter, 'toolbar.tool.highlight'],
    ['note', 'c', MessageSquare, 'toolbar.tool.comment'],
    ['text', 't', Type, 'toolbar.tool.text'],
    ['draw', 'd', PenLine, 'toolbar.tool.draw'],
    ['shapes', 'r', Square, 'toolbar.tool.shapes'],
    // The Form tool is gone from the toolbar and has no key (DESIGN 3.58: fields are always live); the action stays for the hub.
    ['form', undefined, TextCursorInput, 'toolbar.tool.form'],
    ['signature', 's', Signature, 'toolbar.tool.signature'],
    ['pages', 'p', LayoutGrid, 'toolbar.tool.pages'],
    // M5 Edit cluster (DESIGN 3.36, 3.37).
    ['textBox', 'e', TextCursor, 'insert.text'],
    ['image', 'i', ImagePlus, 'insert.image'],
    ['crop', 'k', Crop, 'crop.tool'],
    // v1.2 Lesen mode (FEEDBACK F14): no single-letter keys; Z held is the magnifier gesture (DESIGN v2 3.2).
    ['hand', undefined, Hand, 'tools.hand'],
    ['textSelect', undefined, TextSelect, 'tools.textSelect'],
    ['magnifier', undefined, ScanSearch, 'tools.magnifier'],
  ] as const satisfies readonly (readonly [ToolId, string | undefined, LucideIcon, PlainKey])[]
).map(([tool, key, icon, labelKey]): ActionDef => ({
  id: `tool-${tool}`,
  labelKey,
  icon,
  // Comment keeps N as well as C (DESIGN 3.55): both name the Note tool.
  shortcut:
    key === undefined
      ? undefined
      : tool === 'note'
        ? { default: { key }, alternates: [{ key: 'n' }] }
        : { default: { key } },
  group: 'tools',
  // The F14 Lesen tools live in the mode tool row only (the menus list modes, DESIGN v2 3.2).
  menuBar: tool !== 'form' && tool !== 'hand' && tool !== 'textSelect' && tool !== 'magnifier',
  enabled: needsDocument,
  // The key makes the tool active and leaves it so; it is not the toolbar's click, which also releases an active tool.
  run: () => {
    const ui = useUi.getState();
    // The Sign key opens the Sign menu (DESIGN 3.34): it is the toolbar item's own popover trigger.
    if (tool === 'signature') {
      document.querySelector<HTMLElement>('[data-toolbar-item="signature"]')?.click();
      return;
    }
    // C cycles Comment between its two variants, Note and Text comment (DESIGN 3.55).
    if (tool === 'note' && ui.activeTool === 'text') {
      ui.selectTool('note');
      return;
    }
    if (tool === 'note' && ui.activeTool === 'note') {
      ui.selectTool('text');
      return;
    }
    if (ui.activeTool !== tool) ui.selectTool(tool);
    // Markup and Shapes: the key of the active tool goes on to its next variant (DESIGN 3.22).
    else if (tool === 'highlight' || tool === 'shapes') useTools.getState().cycle(tool);
  },
}));

/** The sidebar tab each `sidebar-tab-*` action shows (the store's name for Pages is `thumbnails`). */
const SIDEBAR_TABS: readonly (readonly [string, LeftPanelTab, PlainKey])[] = [
  ['pages', 'thumbnails', 'menu.view.tabPages'],
  ['outline', 'outline', 'menu.view.tabOutline'],
  ['comments', 'comments', 'menu.view.tabComments'],
  ['search', 'search', 'menu.view.tabSearch'],
];

const SIDEBAR_TAB_ACTIONS: readonly ActionDef[] = SIDEBAR_TABS.map(([name, tab, labelKey]): ActionDef => ({
  id: `sidebar-tab-${name}` as ActionId,
  labelKey,
  group: 'panels',
  menuBar: true,
  enabled: needsDocument,
  // Shows the tab, and the sidebar when it was hidden.
  run: () => {
    const ui = useUi.getState();
    ui.setLeftPanelTab(tab);
    ui.setLeftPanelCollapsed(false);
  },
}));

/** Deletes the selected annotations of the active document (the menu's Delete; the canvas has its own key handling). */
function deleteSelection(): void {
  const docId = useDocuments.getState().activeId;
  if (docId === null) return;
  const ids = useAnnotations.getState().selectedIds[docId] ?? [];
  if (ids.length === 0) return;
  void useAnnotations.getState().apply(docId, { type: 'deleteAnnotations', ids });
}

/** Full screen on and off with the web's own API (no window permission); a refusal is nothing to report. */
function toggleFullscreen(): void {
  // Where the API is missing (a test, an old webview) there is nothing to toggle.
  const on = (document.fullscreenElement ?? null) !== null;
  const request = on ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
  void Promise.resolve(request).catch(() => undefined);
}

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
    menuBar: true,
    enabled: needsDocument,
    run: () => saveActive(true),
  },
  // The output group (DESIGN 3.41): after Save As, divider above and below; each opens a dialog (src/features/{imagesToPdf,exportCopy,exportImages,print}).
  {
    id: 'images-to-pdf',
    labelKey: 'img2pdf.menu',
    icon: Images,
    group: 'output',
    menuBar: true,
    enabled: () => true,
    run: () => useUi.getState().setImagesToPdfOpen(true),
  },
  {
    id: 'export-copy',
    labelKey: 'copy.menu',
    icon: FileOutput,
    group: 'output',
    menuBar: true,
    enabled: needsDocument,
    run: () => useUi.getState().setExportCopyOpen(true),
  },
  {
    id: 'export-images',
    labelKey: 'exportImg.menu',
    icon: FileImage,
    shortcut: { default: { key: 'e', mods: ['primary', 'shift'] } },
    group: 'output',
    menuBar: true,
    // Copying content out is a permission (DESIGN 3.39); the item stays focusable and the dialog says why ('output.notAllowed').
    enabled: (state) => state.hasDocument && mayCopy(state),
    run: () => useUi.getState().setExportImagesOpen(true),
  },
  {
    id: 'print',
    labelKey: 'print.menu',
    icon: Printer,
    shortcut: { default: primary('p') },
    group: 'output',
    menuBar: true,
    enabled: (state) => state.hasDocument && mayPrint(state),
    run: () => useUi.getState().setPrintOpen(true),
  },
  {
    id: 'merge-files',
    labelKey: 'action.merge',
    icon: Combine,
    group: 'file',
    menuBar: true,
    enabled: needsDocument,
    run: runMerge,
  },
  {
    id: 'split-document',
    labelKey: 'action.split',
    icon: Scissors,
    group: 'file',
    menuBar: true,
    enabled: needsDocument,
    run: runSplit,
  },
  {
    id: 'extract-pages',
    labelKey: 'action.extractPages',
    icon: FileOutput,
    group: 'file',
    menuBar: true,
    enabled: needsDocument,
    run: runExtract,
  },
  {
    id: 'compress-document',
    labelKey: 'action.compress',
    icon: FileArchive,
    group: 'file',
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
    menuBar: true,
    enabled: (state) => state.hasDocument && state.canRedo,
    run: () => runHistoryStep('redo'),
  },
  {
    id: 'flatten-form',
    labelKey: 'action.flattenForm',
    icon: Stamp,
    group: 'edit',
    menuBar: true,
    enabled: needsDocument,
    // The confirm dialog (src/features/forms), which runs the flatten job.
    run: runFlatten,
  },
  {
    id: 'redact',
    labelKey: 'redact.tool',
    icon: SquareSlash,
    group: 'edit',
    enabled: needsDocument,
    // A mode (DESIGN 3.38): the canvas and inspector slots of src/features/redact read it.
    run: () => useUi.getState().setRedactMode(true),
  },
  {
    id: 'protect',
    labelKey: 'protect.menu',
    icon: Lock,
    group: 'edit',
    menuBar: true,
    enabled: needsDocument,
    run: () => useUi.getState().setProtectOpen(true),
  },
  {
    id: 'document-properties',
    labelKey: 'props.menu',
    icon: FileText,
    group: 'edit',
    menuBar: true,
    enabled: needsDocument,
    run: () => useUi.getState().setPropsOpen(true),
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
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().fitPage(),
  },
  {
    id: 'scroll-continuous',
    labelKey: 'action.scrollContinuous',
    icon: GalleryVertical,
    group: 'view',
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().setScrollMode('continuous'),
  },
  {
    id: 'scroll-single',
    labelKey: 'action.scrollSingle',
    icon: File,
    group: 'view',
    menuBar: true,
    enabled: needsDocument,
    run: () => useViewer.getState().setScrollMode('single'),
  },
  {
    id: 'scroll-spread',
    labelKey: 'action.scrollSpread',
    icon: BookOpen,
    group: 'view',
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
    menuBar: true,
    enabled: needsDocument,
    run: () => cycleTab(1),
  },
  {
    id: 'previous-tab',
    labelKey: 'action.previousTab',
    shortcut: { default: primary('PageUp'), macos: { key: '[', mods: ['primary', 'shift'] } },
    group: 'page',
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
    menuBar: true,
    enabled: needsDocument,
    // The top bar's page field is focused and selected (src/features/topbar/CenterCluster).
    run: () => useGoToPage.getState().setOpen(true),
  },
  {
    id: 'find',
    labelKey: 'action.find',
    icon: Search,
    shortcut: { default: primary('f') },
    group: 'page',
    menuBar: true,
    enabled: needsDocument,
    run: openSearch,
  },
  {
    id: 'find-next',
    labelKey: 'action.findNext',
    icon: ChevronDown,
    shortcut: { default: primary('g'), alternates: [{ key: 'F3' }] },
    group: 'page',
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
  {
    id: 'view-home',
    labelKey: 'action.viewHome',
    icon: House,
    group: 'view',
    // Back to Home (the top bar's chevron and Fertig call it): documents stay open behind it.
    enabled: () => true,
    run: () => useUi.getState().setView('home'),
  },
  ...TOOL_ACTIONS,
  {
    id: 'settings',
    labelKey: 'action.settings',
    icon: Settings,
    shortcut: { default: primary(',') },
    group: 'app',
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
    // Windows' Help menu has it; the macOS menu bar has the system's own About panel (menu.json marks it Windows only).
    menuBar: true,
    enabled: () => true,
    // The dialog (src/features/about): opens it, and closes it when it is open (the one command that runs while a modal is open).
    run: toggleAbout,
  },
  // F12 (DESIGN 3.56): the commands that only the menu bars carry.
  {
    id: 'tool-redact',
    labelKey: 'toolbar.tool.redact',
    icon: SquareSlash,
    shortcut: { default: { key: 'x' } },
    group: 'tools',
    menuBar: true,
    enabled: needsDocument,
    // A mode (DESIGN 3.38): the key toggles it like the toolbar item does.
    run: () => useUi.getState().setRedactMode(!useUi.getState().redactMode),
  },
  ...SIDEBAR_TAB_ACTIONS,
  {
    id: 'delete-selection',
    labelKey: 'menu.edit.delete',
    group: 'edit',
    menuBar: true,
    enabled: needsDocument,
    // The Delete key itself is the canvas's (it works where the selection is focused); this is the menu's way to the same step.
    run: deleteSelection,
  },
  {
    id: 'add-comment',
    labelKey: 'menu.edit.addComment',
    icon: MessageSquare,
    shortcut: { default: { key: 'm', mods: ['primary', 'shift'] } },
    group: 'edit',
    menuBar: true,
    enabled: needsDocument,
    // The selection bar of the comments feature answers (`onAddComment`); without a text selection nothing happens.
    run: requestAddComment,
  },
  {
    id: 'form-highlight',
    labelKey: 'menu.tools.formHighlight',
    group: 'app',
    menuBar: true,
    enabled: needsDocument,
    run: () => useForms.getState().setHighlight(!useForms.getState().highlight),
  },
  {
    id: 'manage-signatures',
    labelKey: 'menu.tools.manageSignatures',
    icon: Signature,
    group: 'app',
    menuBar: true,
    enabled: () => true,
    run: openSignatureLibrary,
  },
  {
    id: 'welcome-tour',
    labelKey: 'menu.help.tour',
    group: 'app',
    menuBar: true,
    enabled: () => true,
    run: () => void restartTour(),
  },
  {
    id: 'reset-tips',
    labelKey: 'menu.help.tips',
    group: 'app',
    menuBar: true,
    enabled: () => true,
    run: () => void resetTips(),
  },
  {
    id: 'fullscreen',
    labelKey: 'menu.view.fullscreenWindows',
    shortcut: { default: { key: 'F11' } },
    group: 'view',
    menuBar: true,
    enabled: () => true,
    // The web's own full screen: the window fills the screen, with no window permission (SECURITY T3). macOS has the system item.
    run: toggleFullscreen,
  },
  {
    id: 'exit',
    labelKey: 'menu.file.exit',
    group: 'app',
    menuBar: true,
    enabled: () => true,
    // A close request, like the caption's close button: the window may still veto it (unsaved changes).
    run: () => void closeWindow().catch(() => undefined),
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
