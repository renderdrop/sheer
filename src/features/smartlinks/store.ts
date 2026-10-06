import { create } from 'zustand';

/**
 * Whether smart links are on (DESIGN 3.11 L8): one global switch (Settings, default on, kept in the UI storage under
 * `sheer.smartLinks.enabled`) and a per-tab override of this session (the Lesen toggle, the Ansicht item). Changing the global switch
 * clears every override. The visited links of a tab live here too: this session, this tab, dropped when the tab closes.
 */
export const ENABLED_KEY = 'sheer.smartLinks.enabled';

function loadEnabled(): boolean {
  try {
    return globalThis.localStorage.getItem(ENABLED_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveEnabled(on: boolean): void {
  try {
    globalThis.localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for the session.
  }
}

export interface SmartLinksState {
  /** The global setting. */
  enabled: boolean;
  /** The tabs whose switch differs from the global one, by document id. */
  overrides: Readonly<Record<number, boolean>>;
  /** The links followed in each tab, by `visitKey`. */
  visited: Readonly<Record<number, readonly string[]>>;
  /** Settings: sets the global switch and clears the per-tab overrides. */
  setEnabled: (on: boolean) => void;
  /** The quick toggle: sets this tab's switch (the same as the global one is no override). */
  setForDoc: (docId: number, on: boolean) => void;
  markVisited: (docId: number, key: string) => void;
  /** Forgets a closed tab. */
  forget: (docId: number) => void;
}

/** Most visited links kept per tab. */
export const MAX_VISITED = 2000;

export const useSmartLinks = create<SmartLinksState>()((set) => ({
  enabled: loadEnabled(),
  overrides: {},
  visited: {},
  setEnabled: (enabled) => {
    saveEnabled(enabled);
    set({ enabled, overrides: {} });
  },
  setForDoc: (docId, on) =>
    set((state) => {
      const wanted = on === state.enabled ? undefined : on;
      if (state.overrides[docId] === wanted) return state;
      const overrides = Object.fromEntries(Object.entries(state.overrides).filter(([id]) => Number(id) !== docId));
      if (wanted !== undefined) overrides[docId] = wanted;
      return { overrides };
    }),
  markVisited: (docId, key) =>
    set((state) => {
      const known = state.visited[docId] ?? [];
      if (known.includes(key)) return state;
      return { visited: { ...state.visited, [docId]: [...known, key].slice(-MAX_VISITED) } };
    }),
  forget: (docId) =>
    set((state) => {
      if (state.overrides[docId] === undefined && state.visited[docId] === undefined) return state;
      return {
        overrides: Object.fromEntries(Object.entries(state.overrides).filter(([id]) => Number(id) !== docId)),
        visited: Object.fromEntries(Object.entries(state.visited).filter(([id]) => Number(id) !== docId)),
      };
    }),
}));

/** Whether smart links are on for a tab: its override, else the global switch. */
export function smartLinksOn(state: Pick<SmartLinksState, 'enabled' | 'overrides'>, docId: number): boolean {
  return state.overrides[docId] ?? state.enabled;
}

/** The switch of a tab as a hook. */
export function useSmartLinksOn(docId: number | null): boolean {
  return useSmartLinks((state) => (docId === null ? state.enabled : smartLinksOn(state, docId)));
}
