import { create } from 'zustand';

import type { StampKind, StampTone } from '../../../api/annotations';
import { useUi } from '../../../stores/ui';
import { rememberVariant } from '../../modes/lastVariant';
import { FIRST_CHOICE, PRESETS, cleanOwn, parseRecent, pushRecent, type RecentText, type StampChoice } from './model';

/** UI storage of the last choice and the recent own texts (this device only; nothing of it leaves the machine). */
export const STAMP_KEY = 'sheer.tools.stamp';

const KINDS: readonly StampKind[] = [...PRESETS, 'custom'];
const TONES: readonly StampTone[] = ['solar', 'ink'];

interface Stored {
  choice: StampChoice;
  recent: RecentText[];
}

/** The stored state, field by field validated (storage is outside input). */
export function parseStored(raw: unknown): Stored {
  const out: Stored = { choice: FIRST_CHOICE, recent: [] };
  if (typeof raw !== 'object' || raw === null) return out;
  const { choice, recent } = raw as Record<string, unknown>;
  out.recent = parseRecent(recent);
  if (typeof choice === 'object' && choice !== null) {
    const { stamp, custom, withDate, tone } = choice as Record<string, unknown>;
    out.choice = {
      stamp: KINDS.find((kind) => kind === stamp) ?? FIRST_CHOICE.stamp,
      custom: typeof custom === 'string' ? cleanOwn(custom) : '',
      withDate: typeof withDate === 'boolean' ? withDate : FIRST_CHOICE.withDate,
      tone: TONES.find((t) => t === tone) ?? FIRST_CHOICE.tone,
    };
  }
  return out;
}

function load(): Stored {
  try {
    return parseStored(JSON.parse(globalThis.localStorage.getItem(STAMP_KEY) ?? 'null'));
  } catch {
    return { choice: FIRST_CHOICE, recent: [] };
  }
}

function save(state: Stored): void {
  try {
    globalThis.localStorage.setItem(STAMP_KEY, JSON.stringify({ choice: state.choice, recent: state.recent }));
  } catch {
    // Storage unavailable or full: the choice lasts for the session.
  }
}

export interface StampState extends Stored {
  /** The picker is open (it opens every time the Stempel variant is armed). */
  pickerOpen: boolean;
  /** The ghost is moved with the keys (the choice was made with the keyboard); the placing layer shows it on the current page. */
  keyboard: boolean;
  /** The picker was opened from the mini bar to change this stamp (null: it arms placement). */
  changing: number | null;
  setPicker: (open: boolean) => void;
  setKeyboard: (on: boolean) => void;
  setChanging: (id: number | null) => void;
  /** Changes the choice (merged) and remembers it. */
  choose: (change: Partial<StampChoice>) => void;
  /** An own text was placed: it joins the recent list. */
  remember: (entry: RecentText) => void;
}

export const useStamp = create<StampState>()((set, get) => ({
  ...load(),
  pickerOpen: false,
  keyboard: false,
  changing: null,
  setPicker: (pickerOpen) => set(pickerOpen ? { pickerOpen } : { pickerOpen, changing: null }),
  setKeyboard: (keyboard) => set({ keyboard }),
  setChanging: (changing) => set({ changing }),
  choose: (change) => {
    set({ choice: { ...get().choice, ...change } });
    save(get());
  },
  remember: (entry) => {
    set({ recent: pushRecent(get().recent, entry) });
    save(get());
  },
}));

/** Arms the Stempel tool and opens the picker on the last choice. Never toggles the tool off (the main part again re-opens the picker). */
export function armStamp(): void {
  rememberVariant('note', 'stamp');
  const ui = useUi.getState();
  if (ui.activeTool !== 'stamp') ui.selectTool('stamp');
  useStamp.getState().setKeyboard(false);
  useStamp.getState().setChanging(null);
  useStamp.getState().setPicker(true);
}
