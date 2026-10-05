import { create } from 'zustand';

import type { Rect } from '../../../api/wire';
import { useUi } from '../../../stores/ui';
import { usePlacement } from '../place/store';

/**
 * The certificate signing flow's state (DESIGN 3.8 S3): whether the Zertifikat tool is on, which identity it uses, the seal
 * placeholder and whether the confirm dialog is open. The placeholder never enters the document or the undo stack.
 */
export interface SealBox {
  docId: number;
  pageIndex: number;
  /** Page space, points. */
  rect: Rect;
}

export interface CertSignState {
  active: boolean;
  /** The identity the tool uses; the main part of the slot picks it again. */
  identityId: string | null;
  box: SealBox | null;
  dialog: boolean;
  activate: (identityId: string | null) => void;
  setBox: (box: SealBox | null) => void;
  openDialog: () => void;
  closeDialog: () => void;
  /** Leaves the tool and drops the placeholder (the identity is remembered). */
  reset: () => void;
}

export const useCertSign = create<CertSignState>()((set) => ({
  active: false,
  identityId: null,
  box: null,
  dialog: false,
  activate: (identityId) => {
    // The Sign tool's canvas hosts both; an armed visual item would take the click, so it is dropped first.
    const ui = useUi.getState();
    if (ui.activeTool !== 'signature') ui.selectTool('signature');
    usePlacement.getState().disarm();
    set((state) => ({ active: true, identityId: identityId ?? state.identityId, box: null, dialog: false }));
  },
  setBox: (box) => set({ box }),
  openDialog: () => set((state) => (state.box === null ? state : { dialog: true })),
  closeDialog: () => set({ dialog: false }),
  reset: () => set({ active: false, box: null, dialog: false }),
}));

// Another tool, a mode switch, Esc or an armed visual item ends the flow (S3: switching mode or tool discards the placeholder).
useUi.subscribe((state) => {
  if (state.activeTool !== 'signature' && useCertSign.getState().active) useCertSign.getState().reset();
});
usePlacement.subscribe((state) => {
  if (state.item !== null && useCertSign.getState().active) useCertSign.getState().reset();
});
