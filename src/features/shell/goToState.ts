import { create } from 'zustand';

/**
 * Whether the status bar's "Go to page" popover is open (DESIGN 3.20). The page button opens it, and so does the `go-to-page`
 * action (primary+Shift+N, the More menu): the popover is controlled from here.
 */
export const useGoToPage = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
