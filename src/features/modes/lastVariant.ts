import { create } from 'zustand';

/** The variant each split slot last ran (its main part shows and repeats it); the order of the variants decides the first. */
export const useLastVariant = create<{
  last: Readonly<Record<string, string>>;
  remember: (slot: string, id: string) => void;
}>()((set) => ({
  last: {},
  remember: (slot, id) => set((state) => (state.last[slot] === id ? state : { last: { ...state.last, [slot]: id } })),
}));

/** Records that a slot ran a variant by another way than its menu (the Stamp… menu item arms the Stempel variant of Notiz). */
export const rememberVariant = (slot: string, id: string): void => useLastVariant.getState().remember(slot, id);
