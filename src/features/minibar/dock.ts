import { create } from 'zustand';

/**
 * The dock of the mini bar (DESIGN v2 3.3): the second 40 px row of the banner slot. The slot registers its row (`target`); the bar
 * says it needs it (`docked`) when neither side of the selection has room, and the row takes its height only then.
 */
interface DockState {
  target: HTMLElement | null;
  docked: boolean;
  setTarget: (target: HTMLElement | null) => void;
  setDocked: (docked: boolean) => void;
}

export const useMiniBarDock = create<DockState>()((set) => ({
  target: null,
  docked: false,
  setTarget: (target) => set({ target }),
  setDocked: (docked) => set((state) => (state.docked === docked ? state : { docked })),
}));
