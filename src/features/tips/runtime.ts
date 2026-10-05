import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useTour } from '../tour/store';
import { mayShow, tipFor, withSeen, type TipId } from './model';
import { useTips } from './store';

/** Tips already decided on in this session: the setting may fail to write (or not exist yet), and a tip must still never repeat. */
const session = new Set<string>();

/** Tips wait this long after the last input lost focus. */
export const TIP_IDLE_MS = 2000;
const INPUT = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
let lastInputBlur = Number.NEGATIVE_INFINITY;
let retry: ReturnType<typeof setTimeout> | undefined;

/** Milliseconds a tip still has to wait for the inputs to rest; 0 when none has focus and none had it in the last 2 s. */
export function inputIdleWait(now = Date.now()): number {
  if (document.activeElement?.matches(INPUT) === true) return TIP_IDLE_MS;
  return Math.max(0, lastInputBlur + TIP_IDLE_MS - now);
}

/** For tests: forgets the session's tips and its count. */
export function resetSession(): void {
  session.clear();
  lastInputBlur = Number.NEGATIVE_INFINITY;
  clearTimeout(retry);
  useTips.getState().resetSession();
}

/** Whether the tool or mode of the tip is still the one that is on. */
function stillOn(id: TipId): boolean {
  return tipFor(useUi.getState()) === id;
}

/**
 * Looks at the active tool and, when it has an unseen tip, marks it seen and then shows it (DESIGN 3.47). The id is written to the
 * setting *before* the tip shows, so a crash cannot repeat it; the session set covers a write that fails.
 */
export async function maybeShowTip(): Promise<void> {
  const id = tipFor(useUi.getState());
  if (id === null) return;
  const settings = useSettings.getState();
  const context = {
    loaded: settings.loaded,
    seen: settings.tipsSeen ?? [],
    session,
    shownCount: useTips.getState().shownCount,
    tourRunning: useTour.getState().docId !== null,
    tipVisible: useTips.getState().current !== null,
  };
  if (!mayShow(id, context)) return;
  // A tip waits until no input has had focus for 2 s (DESIGN 3.9 Q8); it is asked for again then.
  const wait = inputIdleWait();
  if (wait > 0) {
    clearTimeout(retry);
    retry = setTimeout(() => void maybeShowTip(), wait);
    return;
  }
  session.add(id);
  await settings.update({ tipsSeen: withSeen(context.seen, id) });
  // The tool may have been released while the write was in flight: then there is nothing to point at.
  if (stillOn(id) && useTour.getState().docId === null && useTips.getState().current === null) {
    useTips.getState().show(id);
  }
}

/** "Show tips again": forgets every tip seen, in the setting and in this session. */
export async function resetTips(): Promise<void> {
  session.clear();
  await useSettings.getState().update({ tipsSeen: [] });
}

/**
 * Connects the tips to the app: a tool turning active asks for its tip, and the tip goes when its tool is released or changed or
 * when a tour starts. Returns the function that disconnects it. Mounted once (`TipHost`).
 */
export function bindTips(): () => void {
  const stopUi = useUi.subscribe((state, previous) => {
    if (state.activeTool === previous.activeTool && state.redactMode === previous.redactMode) return;
    const current = useTips.getState().current;
    if (current !== null && tipFor(state) !== current) useTips.getState().dismiss();
    void maybeShowTip();
  });
  const stopTour = useTour.subscribe((state) => {
    if (state.docId !== null) useTips.getState().dismiss();
  });
  // The settings arrive after the first tool could be chosen: look again once they have.
  const stopSettings = useSettings.subscribe((state, previous) => {
    if (state.loaded && !previous.loaded) void maybeShowTip();
  });
  const onFocusOut = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches(INPUT)) lastInputBlur = Date.now();
  };
  document.addEventListener('focusout', onFocusOut);
  return () => {
    document.removeEventListener('focusout', onFocusOut);
    clearTimeout(retry);
    stopUi();
    stopTour();
    stopSettings();
  };
}
