import { useNotices } from '../../components/notices';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useForms } from '../forms/store';
import { useTour } from '../tour/store';
import { mayShow, tipFor, withSeen, type TipContext, type TipId } from './model';
import { useTips } from './store';

/** Tips already decided on in this session: the setting may fail to write (or not exist yet), and a tip must still never repeat. */
const session = new Set<string>();

/** Tips wait this long after the last input lost focus. */
export const TIP_IDLE_MS = 2000;
const INPUT = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** A menu, popover or dialog: a tip waits while one is open (DESIGN 3.13 C4). */
export const OVERLAYS = '[role="menu"], [role="dialog"], [aria-modal="true"]';
let lastInputBlur = Number.NEGATIVE_INFINITY;
let retry: ReturnType<typeof setTimeout> | undefined;
/** The document the visible form tip belongs to: it goes with the tab. */
let formDoc: number | null = null;

/** Milliseconds a tip still has to wait for the inputs to rest; 0 when none has focus and none had it in the last 2 s. */
export function inputIdleWait(now = Date.now()): number {
  if (document.activeElement?.matches(INPUT) === true) return TIP_IDLE_MS;
  return Math.max(0, lastInputBlur + TIP_IDLE_MS - now);
}

/** For tests: forgets the session's tips and its count. */
export function resetSession(): void {
  session.clear();
  lastInputBlur = Number.NEGATIVE_INFINITY;
  formDoc = null;
  clearTimeout(retry);
  useTips.getState().resetSession();
}

/** The active document, when it has a fillable field (not read-only; a full XFA form has none in the store) and the mode is not Seiten (C1). */
function formDocument(): number | null {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null || useUi.getState().mode === 'pages') return null;
  const fields = useForms.getState().byDoc[docId]?.fields ?? [];
  return fields.some((field) => !field.readOnly) ? docId : null;
}

/** Whether the situation of the tip is still there (the tool is on, the mode, the tab). */
function stillOn(id: TipId): boolean {
  if (id === 'formClip') return formDoc === null ? formDocument() !== null : formDocument() === formDoc;
  return tipFor(useUi.getState()) === id;
}

/** The situations that are on now, most specific first: the active tool's tip, then the form's. */
function situations(): TipId[] {
  const tool = tipFor(useUi.getState());
  return [...(tool === null ? [] : [tool]), ...(formDocument() === null ? [] : (['formClip'] as const))];
}

function overlayOpen(): boolean {
  return document.querySelector(OVERLAYS) !== null;
}

function contextNow(): TipContext {
  const settings = useSettings.getState();
  return {
    loaded: settings.loaded,
    enabled: settings.tipsEnabled !== false,
    seen: settings.tipsSeen ?? [],
    session,
    shownCount: useTips.getState().shownCount,
    tourRunning: useTour.getState().docId !== null,
    tipVisible: useTips.getState().current !== null,
  };
}

/**
 * Looks at the situations that are on and, when one has an unseen tip, marks it seen and then shows it (DESIGN 3.47, 3.13 C4). The
 * id is written to the setting *before* the tip shows, so a crash cannot repeat it; the session set covers a write that fails.
 */
export async function maybeShowTip(): Promise<void> {
  const context = contextNow();
  const id = situations().find((candidate) => mayShow(candidate, context));
  if (id === undefined) return;
  const doc = id === 'formClip' ? formDocument() : null;
  await showTipFor(id, () => (id === 'formClip' ? formDocument() === doc : stillOn(id)), doc);
}

/**
 * Shows the tip `id` if it may show now (enabled, unseen, no tour, no other notice, no open menu or dialog, under the session cap).
 * Nothing is written while it cannot show, so a tip that is not shown stays unseen. `stillValid` is asked again after the setting
 * was written: what the tip points at may be gone by then.
 */
export async function showTipFor(id: TipId, stillValid: () => boolean, doc: number | null = null): Promise<void> {
  const settings = useSettings.getState();
  const context = contextNow();
  if (!mayShow(id, context)) return;
  // One notice at a time (Q8) and no overlay: the situation is looked at again when they are gone (`bindTips`).
  if (useNotices.getState().visible !== null || overlayOpen()) return;
  // A tip waits until no input has had focus for 2 s (DESIGN 3.9 Q8); it is asked for again then.
  const wait = inputIdleWait();
  if (wait > 0) {
    clearTimeout(retry);
    retry = setTimeout(() => void showTipFor(id, stillValid, doc), wait);
    return;
  }
  session.add(id);
  await settings.update({ tipsSeen: withSeen(context.seen, id) });
  // The situation may be gone while the write was in flight: then there is nothing to point at.
  if (
    stillValid() &&
    useSettings.getState().tipsEnabled !== false &&
    useTour.getState().docId === null &&
    useTips.getState().current === null
  ) {
    formDoc = doc;
    useTips.getState().show(id);
  }
}

/** The Smart links tip (DESIGN 3.11): after the first hover or focus on a detected link; it points at the Lesen tool slot. */
export function maybeShowSmartLinksTip(): Promise<void> {
  return showTipFor('smartlinks', () => true);
}

/** "Show tips again": forgets every tip seen, in the setting and in this session. */
export async function resetTips(): Promise<void> {
  session.clear();
  await useSettings.getState().update({ tipsSeen: [] });
}

/**
 * Connects the tips to the app: a tool or mode turning active, a form opening or a notice or overlay going asks for the tip, and the
 * tip goes when its situation is gone or a tour starts. Returns the function that disconnects it. Mounted once (`TipHost`).
 */
export function bindTips(): () => void {
  /** Ends a visible tip whose situation is gone, then asks for the one that is on. */
  const reconcile = () => {
    const current = useTips.getState().current;
    if (current !== null && !stillOn(current)) useTips.getState().dismiss();
    void maybeShowTip();
  };
  const stopUi = useUi.subscribe((state, previous) => {
    if (
      state.activeTool === previous.activeTool &&
      state.redactMode === previous.redactMode &&
      state.mode === previous.mode
    ) {
      return;
    }
    reconcile();
  });
  const stopDocs = useDocuments.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId) reconcile();
  });
  const stopForms = useForms.subscribe((state, previous) => {
    const current = useTips.getState().current;
    if (current === 'formClip' && formDoc !== null) {
      // The first value committed in the form ends the form tip (C1): the store's fields change identity then.
      if (state.byDoc[formDoc]?.fields !== previous.byDoc[formDoc]?.fields) useTips.getState().dismiss();
      return;
    }
    if (current === null) void maybeShowTip();
  });
  const stopTour = useTour.subscribe((state) => {
    if (state.docId !== null) useTips.getState().dismiss();
  });
  // The settings arrive after the first tool could be chosen: look again once they have. Tips switched off go at once, on resume.
  const stopSettings = useSettings.subscribe((state, previous) => {
    if (state.tipsEnabled === false && previous.tipsEnabled !== false) {
      clearTimeout(retry);
      useTips.getState().dismiss();
    } else if ((state.loaded && !previous.loaded) || (state.tipsEnabled !== false && previous.tipsEnabled === false)) {
      void maybeShowTip();
    }
  });
  // Another notice ending or an overlay closing frees the slot: a situation that is still on shows its tip then.
  const stopNotices = useNotices.subscribe((state, previous) => {
    if (state.visible === null && previous.visible !== null) void maybeShowTip();
  });
  let overlays = overlayOpen();
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const open = overlayOpen();
      if (overlays && !open) void maybeShowTip();
      overlays = open;
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const onFocusOut = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches(INPUT)) lastInputBlur = Date.now();
  };
  document.addEventListener('focusout', onFocusOut);
  return () => {
    document.removeEventListener('focusout', onFocusOut);
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(retry);
    stopUi();
    stopDocs();
    stopForms();
    stopTour();
    stopSettings();
    stopNotices();
  };
}
