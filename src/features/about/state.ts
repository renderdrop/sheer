import { create } from 'zustand';

import { closeSettings } from '../settings/state';

/** Whether the About dialog is open; the `about` action opens it through `openAbout`. */
export interface AboutDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useAboutDialog = create<AboutDialogState>()((set) => ({
  open: false,
  setOpen: (open) => set((state) => (state.open === open ? state : { open })),
}));

/**
 * Opens the dialog. The settings popover goes first: the dialog is the topmost layer and takes Esc before a popover
 * (`DISMISS_PRIORITY`), but a popover left open beside a modal would be a second thing to dismiss and to focus, so one that
 * is open is closed.
 */
export function openAbout(): void {
  closeSettings();
  useAboutDialog.getState().setOpen(true);
}

/**
 * What the `about` action does: opens the dialog, and closes it when it is open already. About is the one command that
 * still runs while a modal dialog is open (`runAction`), so running it again is the dialog's own "close".
 */
export function toggleAbout(): void {
  if (useAboutDialog.getState().open) useAboutDialog.getState().setOpen(false);
  else openAbout();
}
