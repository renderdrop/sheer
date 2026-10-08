import { create } from 'zustand';

import { useUi } from '../../stores/ui';

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

/** Whether the margin column is where a new comment is written (F19.24): it is on and the mode has one (not Seiten). */
export function marginShowsEdits(): boolean {
  return useMarginPrefs.getState().enabled && useUi.getState().mode !== 'pages';
}
