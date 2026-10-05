import { create } from 'zustand';

import type { TipId } from './model';

/** The tip that is visible, if any (at most one, DESIGN 3.47). */
export interface TipsState {
  current: TipId | null;
  /** Tips shown in this session (capped by `MAX_TIPS_PER_SESSION`, not reset by "Show tips again"). */
  shownCount: number;
  show: (id: TipId) => void;
  /** Ends the tip for good: the id stays in the seen list. */
  dismiss: () => void;
  /** Starts a new session: no tip is visible and none counted. */
  resetSession: () => void;
}

export const useTips = create<TipsState>()((set) => ({
  current: null,
  shownCount: 0,
  show: (current) => set((state) => ({ current, shownCount: state.shownCount + 1 })),
  resetSession: () => set({ current: null, shownCount: 0 }),
  dismiss: () => set((state) => (state.current === null ? state : { current: null })),
}));
