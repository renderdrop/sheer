import { create } from 'zustand';

import type { TipId } from './model';

/** The tip that is visible, if any (at most one, DESIGN 3.47). */
export interface TipsState {
  current: TipId | null;
  show: (id: TipId) => void;
  /** Ends the tip for good: the id stays in the seen list. */
  dismiss: () => void;
}

export const useTips = create<TipsState>()((set) => ({
  current: null,
  show: (current) => set({ current }),
  dismiss: () => set((state) => (state.current === null ? state : { current: null })),
}));
