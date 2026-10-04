import { create } from 'zustand';

const KEY = 'margin.comments';

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** View → "Comments in margin" (DESIGN 3.5 B9): on by default, remembered. */
export const useMarginPrefs = create<{ enabled: boolean; setEnabled: (on: boolean) => void }>()((set) => ({
  enabled: read(),
  setEnabled: (enabled) => {
    try {
      globalThis.localStorage?.setItem(KEY, enabled ? 'on' : 'off');
    } catch {
      // The choice then lasts for this session only.
    }
    set({ enabled });
  },
}));
