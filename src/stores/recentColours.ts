import { create } from 'zustand';

import { RECENT_COLOURS_MAX, pushRecent, type Rgb3 } from '../components/colour';

/**
 * The custom colours the user applied in the colour popover (DESIGN 3.5 B5): one list for the app, not per document, at most 8,
 * newest first, without repeats. UI storage (this webview's localStorage, nothing of it leaves the machine); a colour enters on Apply.
 */
export const RECENT_COLOURS_KEY = 'sheer.tools.recentColors';

const isByte = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;

/** The stored list, entry by entry validated (storage is outside input); whatever is wrong is dropped. */
export function parseRecent(raw: unknown): Rgb3[] {
  if (!Array.isArray(raw)) return [];
  const out: Rgb3[] = [];
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3 || !entry.every(isByte)) continue;
    // Checked above: three bytes. A list is built oldest first so the stored order (newest first) survives.
    out.push(entry as unknown as Rgb3);
  }
  return out.reduceRight<Rgb3[]>((list, colour) => pushRecent(list, colour), []).slice(0, RECENT_COLOURS_MAX);
}

export function readRecent(): Rgb3[] {
  try {
    return parseRecent(JSON.parse(globalThis.localStorage.getItem(RECENT_COLOURS_KEY) ?? 'null'));
  } catch {
    return [];
  }
}

export interface RecentColoursState {
  colours: readonly Rgb3[];
  /** Puts a colour first (moving it there when it is in the list already). */
  add: (colour: Rgb3) => void;
}

export const useRecentColours = create<RecentColoursState>()((set, get) => ({
  colours: readRecent(),
  add: (colour) => {
    const colours = pushRecent(get().colours, colour);
    set({ colours });
    try {
      globalThis.localStorage.setItem(RECENT_COLOURS_KEY, JSON.stringify(colours));
    } catch {
      // Storage unavailable or full: the list lasts for the session.
    }
  },
}));
