import { create } from 'zustand';

import { announce } from '../../components/SuccessPulse';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { HOLD_MS } from './engine';
import { SHIPPED_STEPS } from './steps';

/**
 * `waiting`: the step's card is up. `done`: the success moment (held `HOLD_MS`). `finishing`: after the last step, the card is
 * gone and the pill says "Tour complete".
 */
export type TourPhase = 'waiting' | 'done' | 'finishing';

/** Why a tour ended. `skipped` and `closed` are announced; `complete` has its own pill message; `restart` is silent. */
export type EndReason = 'skipped' | 'closed' | 'complete' | 'restart';

export interface TourState {
  /** The welcome document the tour runs on; `null` while no tour runs. */
  docId: number | null;
  /** Index into the shipped steps. */
  index: number;
  phase: TourPhase;
  /** The card is hidden (Esc, the x button); the pill stays. */
  hidden: boolean;
  /** Another tab is in front: card and ring are hidden, the pill shows the count (DESIGN 3.6 tab rule). */
  paused: boolean;
  /** Indices of the steps that came true (Back shows them in the done phase). */
  done: readonly number[];
  /** The pill asked for the card: its first control takes focus when it appears (cleared by the card). */
  focusCard: boolean;

  /** Starts the tour on the welcome document `docId`, at the first step. */
  start: (docId: number) => void;
  hide: () => void;
  /** Shows the hidden card; `focus` moves focus to its first control once it is there (the pill's Enter). */
  show: (focus?: boolean) => void;
  clearFocusRequest: () => void;
  pause: () => void;
  resume: () => void;
  /** Next advances at once, also on a step that was not done (it counts as skipped); after the last step the tour finishes. */
  next: () => void;
  /** Back to the previous step in its last phase; nothing in the document is undone. No-op on the first step. */
  back: () => void;
  toggle: () => void;
  /** The current step's condition came true: success moment, then the next step, or the end after the last. */
  complete: () => void;
  /** Ends the tour; the document stays open. */
  skip: () => void;
  end: (reason: EndReason) => void;
}

const IDLE = {
  docId: null,
  index: 0,
  phase: 'waiting',
  hidden: false,
  paused: false,
  done: [],
  focusCard: false,
} as const;

let hold: ReturnType<typeof setTimeout> | undefined;

/** Announces a message that ends a tour, in the language of the UI. */
function say(key: 'tour.skipped' | 'tour.closed'): void {
  announce(translators[useLocaleStore.getState().locale](key));
}

/** Goes to the next step in its remembered phase, or finishes after the last one (the pill says "Tour complete", then the tour is over). */
function advance(docId: number): void {
  const now = useTour.getState();
  if (now.docId !== docId) return;
  if (now.index + 1 < SHIPPED_STEPS.length) {
    useTour.setState({
      index: now.index + 1,
      phase: now.done.includes(now.index + 1) ? 'done' : 'waiting',
      hidden: false,
    });
    return;
  }
  useTour.setState({ phase: 'finishing' });
  hold = setTimeout(() => useTour.getState().end('complete'), HOLD_MS);
}

export const useTour = create<TourState>()((set, get) => ({
  ...IDLE,

  start: (docId) => {
    clearTimeout(hold);
    if (SHIPPED_STEPS.length === 0) return;
    set({ ...IDLE, docId });
  },

  hide: () => set((state) => (state.docId === null || state.hidden ? state : { hidden: true })),
  show: (focus = false) =>
    set((state) => (state.docId === null || !state.hidden ? state : { hidden: false, focusCard: focus })),
  clearFocusRequest: () => set((state) => (state.focusCard ? { focusCard: false } : state)),
  toggle: () => (get().hidden ? get().show(true) : get().hide()),

  pause: () => set((state) => (state.docId === null || state.paused ? state : { paused: true })),
  resume: () => set((state) => (state.paused ? { paused: false } : state)),

  complete: () => {
    const { docId, phase } = get();
    if (docId === null || phase !== 'waiting') return;
    set((state) => ({ phase: 'done', done: [...state.done, state.index] }));
    clearTimeout(hold);
    hold = setTimeout(() => advance(docId), HOLD_MS);
  },

  next: () => {
    const { docId, phase } = get();
    if (docId === null || phase === 'finishing') return;
    clearTimeout(hold);
    advance(docId);
  },

  back: () => {
    const { docId, index, phase, done } = get();
    if (docId === null || phase === 'finishing' || index === 0) return;
    clearTimeout(hold);
    set({ index: index - 1, phase: done.includes(index - 1) ? 'done' : 'waiting', hidden: false });
  },

  skip: () => get().end('skipped'),

  end: (reason) => {
    if (get().docId === null) return;
    clearTimeout(hold);
    set({ ...IDLE });
    if (reason === 'skipped') say('tour.skipped');
    else if (reason === 'closed') say('tour.closed');
  },
}));
