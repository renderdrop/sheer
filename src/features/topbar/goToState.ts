import { create } from 'zustand';

/**
 * Whether the top bar's page field is asked to take focus (DESIGN v2 3.2): set by the `go-to-page`
 * action (primary+Shift+N); the field resets it.
 */
export const useGoToPage = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
