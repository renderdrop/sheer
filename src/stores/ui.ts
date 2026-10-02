import { create } from 'zustand';

import type { AppError } from '../api/errors';
import { clampPanelWidth, type InspectorMode } from '../lib/layout';
import { useSettings } from './settings';

/** The four views of the left panel (DESIGN 3.6), in tab order. */
export const LEFT_PANEL_TABS = ['thumbnails', 'outline', 'comments', 'search'] as const;
export type LeftPanelTab = (typeof LEFT_PANEL_TABS)[number];

/**
 * The tools of the toolbar (DESIGN 3.3). They have no behaviour yet: choosing one only changes which one is active, so the
 * toolbar and the inspector can be exercised. The `tools` store of ARCHITECTURE section 8 takes this over with M2.
 */
export const TOOLS = ['select', 'highlight', 'comment', 'draw', 'form', 'signature', 'pages'] as const;
export type ToolId = (typeof TOOLS)[number];

/** Interface state that is not about a document (ARCHITECTURE section 8, `ui`). Nothing here is persisted except the panel width. */
export interface UiState {
  leftPanelTab: LeftPanelTab;
  /** Live width while the splitter is dragged; `bindPanelWidthToSettings` persists it a moment after it settles. */
  leftPanelWidth: number;
  leftPanelCollapsed: boolean;
  inspector: InspectorMode;
  activeTool: ToolId;
  /** The active tool stays active after use (double click or Shift+Enter, DESIGN 3.3). */
  toolLocked: boolean;
  /** The pointer drags a file over the window (set from Rust later, M1). Only the look of the drop zone follows it. */
  dropHover: boolean;
  /** A failed action that needs the user's attention: the banner row shows it until it is dismissed. */
  banner: AppError | null;

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
  setDropHover: (active: boolean) => void;
  showBanner: (error: AppError) => void;
  dismissBanner: () => void;
}

const SELECT = { activeTool: 'select', toolLocked: false } as const;

export const useUi = create<UiState>()((set, get) => ({
  leftPanelTab: 'thumbnails',
  leftPanelWidth: clampPanelWidth(Number.NaN),
  leftPanelCollapsed: false,
  inspector: 'auto',
  activeTool: 'select',
  toolLocked: false,
  dropHover: false,
  banner: null,

  setLeftPanelTab: (leftPanelTab) => set({ leftPanelTab }),
  setLeftPanelWidth: (width) => set({ leftPanelWidth: clampPanelWidth(width) }),
  setLeftPanelCollapsed: (leftPanelCollapsed) => set({ leftPanelCollapsed }),
  setInspector: (inspector) => set({ inspector }),
  selectTool: (tool) =>
    set(tool === 'select' || tool === get().activeTool ? SELECT : { activeTool: tool, toolLocked: false }),
  lockTool: (tool) => set(tool === 'select' ? SELECT : { activeTool: tool, toolLocked: true }),
  // Esc is pressed all the time; with Select already active it must not wake the subscribers.
  releaseTool: () => set((state) => (state.activeTool === 'select' && !state.toolLocked ? state : SELECT)),
  setDropHover: (dropHover) => set({ dropHover }),
  showBanner: (banner) => set({ banner }),
  dismissBanner: () => set({ banner: null }),
}));

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
