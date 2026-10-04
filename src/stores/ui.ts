import { create } from 'zustand';

import type { AppError } from '../api/errors';
import { clampPanelWidth, type InspectorMode } from '../lib/layout';
import { useDocuments } from './documents';
import { useSettings } from './settings';

/** A toast (DESIGN 3.12): a confirmation with, at most, one action. Errors never toast. */
export interface Toast {
  /** Changes with every toast, so one that replaces another starts its lifetime over. */
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

/** The four views of the left panel (DESIGN 3.6), in tab order. */
export const LEFT_PANEL_TABS = ['thumbnails', 'outline', 'comments', 'search'] as const;
export type LeftPanelTab = (typeof LEFT_PANEL_TABS)[number];

/**
 * The tools of the toolbar (DESIGN 3.3). Choosing one changes which one is active (the creation tools of M2 read it, DESIGN 3.22); the variants of Markup
 * and Shapes live in the `tools` store (src/stores/tools.ts).
 */
export const TOOLS = [
  'select',
  'highlight',
  'note',
  'text',
  'draw',
  'shapes',
  'form',
  'signature',
  'pages',
  // M5 (DESIGN 3.36, 3.37): Add text, Add image and the Crop mode.
  'textBox',
  'image',
  'crop',
] as const;
export type ToolId = (typeof TOOLS)[number];

/** The two views of the shell (DESIGN v2 3): Home, or the editor around the active document. */
export type View = 'home' | 'editor';

/** Interface state that is not about a document (ARCHITECTURE section 8, `ui`). Nothing here is persisted except the page sidebar's width. */
export interface UiState {
  /** `home` while no document is open or after "back to Home"; documents stay open behind it. Opening or activating one makes it `editor`. */
  view: View;
  leftPanelTab: LeftPanelTab;
  /** Live width while the splitter is dragged; `bindPanelWidthToSettings` persists it a moment after it settles. */
  leftPanelWidth: number;
  leftPanelCollapsed: boolean;
  inspector: InspectorMode;
  activeTool: ToolId;
  /** The active tool stays active after use (double click or Shift+Enter, DESIGN 3.3). */
  toolLocked: boolean;
  /** Redact mode is on (DESIGN 3.38): a mode beside the tools, ended with Esc at tool level or Done. */
  redactMode: boolean;
  /** The Protect sheet (DESIGN 3.39) and the Document properties dialog (DESIGN 3.40) are open. */
  protectOpen: boolean;
  propsOpen: boolean;
  /** The M6 output dialogs are open (DESIGN 3.41 to 3.45): Export as images (U1), Create PDF from images (U2), Print (U3), Export a copy (U4). */
  exportImagesOpen: boolean;
  imagesToPdfOpen: boolean;
  printOpen: boolean;
  exportCopyOpen: boolean;
  /** The pointer drags a file over the window (set from Rust later, M1). Only the look of the drop zone follows it. */
  dropHover: boolean;
  /** A failed action that needs the user's attention: the banner row shows it until it is dismissed. */
  banner: AppError | null;
  /** The documents whose XFA warning the user dismissed (DESIGN 3.21): it lasts for the session, so a remount does not show it again. */
  xfaDismissed: readonly number[];
  /** The one toast on screen, if any. */
  toast: Toast | null;

  setView: (view: View) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  setLeftPanelWidth: (width: number) => void;
  setLeftPanelCollapsed: (collapsed: boolean) => void;
  setInspector: (inspector: InspectorMode) => void;
  /** A click on a tool: activates it, and a click on the active tool, locked or not, goes back to Select. */
  selectTool: (tool: ToolId) => void;
  /** A double click or Shift+Enter on a tool: activates it and keeps it. */
  lockTool: (tool: ToolId) => void;
  /** Esc: back to Select. */
  releaseTool: () => void;
  setRedactMode: (on: boolean) => void;
  setProtectOpen: (open: boolean) => void;
  setPropsOpen: (open: boolean) => void;
  setExportImagesOpen: (open: boolean) => void;
  setImagesToPdfOpen: (open: boolean) => void;
  setPrintOpen: (open: boolean) => void;
  setExportCopyOpen: (open: boolean) => void;
  setDropHover: (active: boolean) => void;
  showBanner: (error: AppError) => void;
  dismissBanner: () => void;
  dismissXfa: (docId: number) => void;
  /** Shows a toast in place of the one on screen. */
  showToast: (toast: Omit<Toast, 'id'>) => void;
  /** Hides the toast `id`, or any toast without it. A newer toast is left alone when `id` is given. */
  dismissToast: (id?: number) => void;
}

let toastCounter = 0;

const SELECT = { activeTool: 'select', toolLocked: false } as const;

export const useUi = create<UiState>()((set, get) => ({
  view: 'home',
  leftPanelTab: 'thumbnails',
  leftPanelWidth: clampPanelWidth(Number.NaN),
  leftPanelCollapsed: false,
  inspector: 'auto',
  activeTool: 'select',
  toolLocked: false,
  redactMode: false,
  protectOpen: false,
  propsOpen: false,
  exportImagesOpen: false,
  imagesToPdfOpen: false,
  printOpen: false,
  exportCopyOpen: false,
  dropHover: false,
  banner: null,
  xfaDismissed: [],
  toast: null,

  setView: (view) => set((state) => (state.view === view ? state : { view })),
  setLeftPanelTab: (leftPanelTab) => set({ leftPanelTab }),
  setLeftPanelWidth: (width) => set({ leftPanelWidth: clampPanelWidth(width) }),
  setLeftPanelCollapsed: (leftPanelCollapsed) => set({ leftPanelCollapsed }),
  setInspector: (inspector) => set({ inspector }),
  selectTool: (tool) =>
    set(tool === 'select' || tool === get().activeTool ? SELECT : { activeTool: tool, toolLocked: false }),
  lockTool: (tool) => set(tool === 'select' ? SELECT : { activeTool: tool, toolLocked: true }),
  // Esc is pressed all the time; with Select already active it must not wake the subscribers.
  releaseTool: () => set((state) => (state.activeTool === 'select' && !state.toolLocked ? state : SELECT)),
  setRedactMode: (redactMode) => set({ redactMode }),
  setProtectOpen: (protectOpen) => set({ protectOpen }),
  setPropsOpen: (propsOpen) => set({ propsOpen }),
  setExportImagesOpen: (exportImagesOpen) => set({ exportImagesOpen }),
  setImagesToPdfOpen: (imagesToPdfOpen) => set({ imagesToPdfOpen }),
  setPrintOpen: (printOpen) => set({ printOpen }),
  setExportCopyOpen: (exportCopyOpen) => set({ exportCopyOpen }),
  setDropHover: (dropHover) => set({ dropHover }),
  showBanner: (banner) => set({ banner }),
  dismissBanner: () => set({ banner: null }),
  showToast: (toast) => set({ toast: { ...toast, id: ++toastCounter } }),
  dismissToast: (id) =>
    set((state) => (state.toast === null || (id !== undefined && state.toast.id !== id) ? state : { toast: null })),
  dismissXfa: (docId) =>
    set((state) => (state.xfaDismissed.includes(docId) ? state : { xfaDismissed: [...state.xfaDismissed, docId] })),
}));

// The view follows the documents (DESIGN v2 3): activating one (opening it, or picking its tab) shows the editor, closing the last one shows
// Home. "Back to Home" (`view-home`) sets Home while the documents stay open; the next activation leaves it again.
useDocuments.subscribe((state, previous) => {
  if (state.activeId !== previous.activeId) useUi.getState().setView(state.activeId === null ? 'home' : 'editor');
});
// Activating or adding a document that is already the active one changes no `activeId`, so those two calls also show the editor.
const { setActive, add } = useDocuments.getState();
useDocuments.setState({
  setActive: (id) => {
    setActive(id);
    if (useDocuments.getState().byId[id] !== undefined) useUi.getState().setView('editor');
  },
  add: (info) => {
    add(info);
    useUi.getState().setView('editor');
  },
});

/** The part of the settings store the panel width needs; `useSettings` satisfies it. */
type SettingsLike = Pick<typeof useSettings, 'getState' | 'subscribe'>;
type UiLike = Pick<typeof useUi, 'getState' | 'setState' | 'subscribe'>;

/** How long the width must stay unchanged before it is written to the settings (a drag makes dozens of changes). */
export const PANEL_WIDTH_PERSIST_DELAY_MS = 300;

/**
 * Connects the left panel's width to the persisted settings (ROADMAP: persist the width in settings).
 *
 * - Once the settings have loaded, their width becomes the panel's, and so does a later answer (the backend may reply
 *   after the startup timeout), as long as the user has not moved the splitter. If the user was first, their width wins
 *   and is saved like any other.
 * - Every change of the width is written with `update({ leftPanelWidth })` once it has been still for
 *   `PANEL_WIDTH_PERSIST_DELAY_MS`, so dragging does not call the backend per step. A width the settings already hold is
 *   not written.
 *
 * Returns the function that disconnects it (and drops a write that is still waiting).
 */
export function bindPanelWidthToSettings(
  ui: UiLike = useUi,
  settings: SettingsLike = useSettings,
  delayMs: number = PANEL_WIDTH_PERSIST_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let userMoved = false;
  let applying = false;
  /** The user's width was written once after the load. A failed write is not retried by every later settings change. */
  let savedAfterLoad = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const width = ui.getState().leftPanelWidth;
      if (width !== settings.getState().leftPanelWidth) void settings.getState().update({ leftPanelWidth: width });
    }, delayMs);
  };

  const follow = () => {
    const state = settings.getState();
    if (!state.loaded) return;
    if (userMoved) {
      // The user was first: their width is saved, once the settings are there to compare with.
      if (!savedAfterLoad) {
        savedAfterLoad = true;
        schedule();
      }
      return;
    }
    const width = clampPanelWidth(state.leftPanelWidth);
    if (width === ui.getState().leftPanelWidth) return;
    applying = true;
    ui.setState({ leftPanelWidth: width });
    applying = false;
  };

  const stopUi = ui.subscribe((state, previous) => {
    if (applying || state.leftPanelWidth === previous.leftPanelWidth) return;
    userMoved = true;
    if (settings.getState().loaded) {
      savedAfterLoad = true;
      schedule();
    }
  });
  const stopSettings = settings.subscribe(follow);
  follow();

  return () => {
    stopUi();
    stopSettings();
    clearTimeout(timer);
  };
}
