import { create } from 'zustand';

import { useUi } from '../../../stores/ui';
import type { MarkGlyph } from '../../../api/annotations';
import type { SignatureRole } from '../../../api/library';
import type { SignatureRef } from '../../../api/signatures';

/**
 * What the Sign tool places on the next click (DESIGN 3.34). A signature or initials comes from the library or from a draft the
 * creation sheet made; the rest is Fill and Sign: a date, a free text, a check, a cross or a dot. `aspect` is width over height.
 */
export type PlaceItem =
  | {
      type: 'signature';
      role: SignatureRole;
      ref: Extract<SignatureRef, { type: 'library' | 'draft' }>;
      aspect: number;
    }
  | { type: 'date' }
  | { type: 'text' }
  | { type: 'mark'; glyph: MarkGlyph };

export interface PlacementState {
  /** The item that is armed; `null` while the Sign tool has nothing chosen. */
  item: PlaceItem | null;
  arm: (item: PlaceItem) => void;
  disarm: () => void;
}

export const usePlacement = create<PlacementState>()((set) => ({
  item: null,
  arm: (item) => set({ item }),
  disarm: () => set({ item: null }),
}));

// Leaving the Sign tool (another tool, Esc, a closed document) drops what was armed.
useUi.subscribe((state) => {
  if (state.activeTool !== 'signature' && usePlacement.getState().item !== null) usePlacement.getState().disarm();
});
