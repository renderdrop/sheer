import { create } from 'zustand';

/**
 * The tool inspector (DESIGN §3.18 E5): the 300 px column right of the canvas that holds the settings of the few tools that have
 * them, plus the history list (F19.23). One at a time; `null` = closed (the column takes no width). The mode card opens it from
 * a tool item, the tab strip from its History button; a mode switch closes it.
 */
export type ToolInspectorId = 'crop' | 'headerFooter' | 'stamp' | 'ocr' | 'reference' | 'history';

interface ToolInspectorState {
  open: ToolInspectorId | null;
  openToolInspector: (id: ToolInspectorId) => void;
  /** Close when `id` is open (or whatever is open when no id is given). */
  closeToolInspector: (id?: ToolInspectorId) => void;
  toggleToolInspector: (id: ToolInspectorId) => void;
}

export const useToolInspector = create<ToolInspectorState>()((set) => ({
  open: null,
  openToolInspector: (id) => set({ open: id }),
  closeToolInspector: (id) => set((s) => (id === undefined || s.open === id ? { open: null } : s)),
  toggleToolInspector: (id) => set((s) => ({ open: s.open === id ? null : id })),
}));
