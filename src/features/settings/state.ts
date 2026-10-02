import { create } from 'zustand';

/**
 * Whether the settings popover is open. A store of its own, not component state, because the `settings` action (the key
 * Ctrl or Cmd and comma, the More menu, the macOS menu bar) opens it from outside the toolbar, through `openSettings`.
 */
export interface SettingsPopoverState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSettingsPopover = create<SettingsPopoverState>()((set) => ({
  open: false,
  setOpen: (open) => set((state) => (state.open === open ? state : { open })),
}));

/** Opens the popover. One that is open stays open (the shortcut pressed again is not a toggle; Esc closes). */
export function openSettings(): void {
  useSettingsPopover.getState().setOpen(true);
}

/** Closes the popover without moving focus (for a dialog that takes over). */
export function closeSettings(): void {
  useSettingsPopover.getState().setOpen(false);
}
