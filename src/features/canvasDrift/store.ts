import { create } from 'zustand';

const KEY = 'canvas.drift';

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * The switch of the canvas drift trial (DESIGN 3.5 B12): on by default while the legibility test runs, remembered. The designer
 * turns it off with `localStorage.setItem('canvas.drift', 'off')` (or `useDriftPrefs.getState().setEnabled(false)`); removing the
 * feature after the test deletes `src/features/canvasDrift`.
 */
export const useDriftPrefs = create<{ enabled: boolean; setEnabled: (on: boolean) => void }>()((set) => ({
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
