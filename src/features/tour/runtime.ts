import { closeSettings } from '../settings/state';
import { openWelcomeDocument } from '../../api/documents';
import { toAppError } from '../../api/errors';
import { DURATION } from '../../lib/motion';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { adoptOpenOutcomes, useViewer } from '../viewer/useViewer';
import { isSatisfied, settleDelay, type Baseline } from './engine';
import { useTour } from './store';
import { SHIPPED_STEPS } from './steps';

/** The Open step ends once the first frame has faded in (MOTION 4.6: the page's entrance, base + slow). */
export const OPEN_SETTLE_MS = (DURATION.base + DURATION.slow) * 1000;

/**
 * Connects the tour to the app: starts it when a welcome document opens (writing `welcomeTour: shown` as it does), ends it when
 * that document is closed or another one opens over it, and completes each step when its condition holds (DESIGN 3.14). Returns
 * the function that disconnects it. Mounted once (`TourEffects`).
 */
export function bindTour(): () => void {
  let baseline: Baseline = { zoom: 1 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The Open step's own timer: a view change must not cancel it. */
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let stepKey = '';

  const reading = () => {
    const { docId } = useTour.getState();
    const view = docId === null ? undefined : useView.getState().byDoc[docId];
    return view === undefined ? null : { pageIndex: view.pageIndex, zoom: view.zoom };
  };

  /** Checks the running step. At a step's start a state that is true already counts at once; later it has to settle. */
  const evaluate = (atStart: boolean) => {
    clearTimeout(timer);
    const { docId, index, phase } = useTour.getState();
    const step = SHIPPED_STEPS[index];
    const view = reading();
    if (docId === null || phase !== 'waiting' || step === undefined || view === null) return;
    if (!isSatisfied(step.id, view, baseline)) return;
    const delay = atStart ? 0 : settleDelay(step.id);
    if (delay === 0) useTour.getState().complete();
    else timer = setTimeout(() => evaluate(true), delay);
  };

  const enterStep = () => {
    clearTimeout(timer);
    clearTimeout(openTimer);
    const { index } = useTour.getState();
    const step = SHIPPED_STEPS[index];
    const view = reading();
    baseline = { zoom: view?.zoom ?? 1 };
    if (step?.id === 'open') openTimer = setTimeout(() => useTour.getState().complete(), OPEN_SETTLE_MS);
    else evaluate(true);
  };

  const stopTour = useTour.subscribe((state) => {
    const key = state.docId === null ? '' : `${state.docId}:${state.index}`;
    if (key === stepKey) return;
    stepKey = key;
    if (key === '') {
      clearTimeout(timer);
      clearTimeout(openTimer);
    } else enterStep();
  });

  const stopView = useView.subscribe(() => evaluate(false));

  const stopDocuments = useDocuments.subscribe((state, previous) => {
    const tour = useTour.getState();
    // Close mid-tour, or another document opened over the sample: the tour ends, nothing resumes.
    if (tour.docId !== null && (state.byId[tour.docId] === undefined || state.activeId !== tour.docId)) {
      tour.end('closed');
    }
    for (const info of Object.values(state.byId)) {
      if (info.kind === 'welcome' && previous.byId[info.id] === undefined) startTour(info.id);
    }
  });

  return () => {
    clearTimeout(timer);
    clearTimeout(openTimer);
    stopTour();
    stopView();
    stopDocuments();
  };
}

/** Starts the tour on the welcome document and marks the tour as shown, so it never starts by itself again. */
export function startTour(docId: number): void {
  if (SHIPPED_STEPS.length === 0) return;
  const settings = useSettings.getState();
  if (settings.welcomeTour === 'pending') void settings.update({ welcomeTour: 'shown' });
  useTour.getState().start(docId);
}

/** Opens the welcome document; the tour starts when it arrives. A failure is shown in the banner like any open that fails. */
export async function openWelcome(): Promise<void> {
  try {
    adoptOpenOutcomes([await openWelcomeDocument()]);
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
  }
}

/**
 * How long the first-launch decision waits after the settings load, so the backend's initial open outcomes (queued until the UI
 * subscribes, then sent first, ADR-017) have been adopted before it looks at the documents.
 */
export const LAUNCH_SETTLE_MS = 600;

/**
 * First launch (DESIGN 3.14): `welcomeTour` is pending and nothing came with the launch. Writes `shown` first, then opens. When a
 * document came with the launch (argv, OS open, second instance) there is no tour, but `shown` is written all the same; the tour
 * stays restartable in Settings.
 */
let launched = false;
export async function maybeFirstLaunch(): Promise<void> {
  if (launched) return;
  const first = useSettings.getState();
  if (!first.loaded || first.welcomeTour !== 'pending') return;
  launched = true;
  await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_SETTLE_MS));
  const settings = useSettings.getState();
  if (settings.welcomeTour !== 'pending') return;
  const launchDocument = useDocuments.getState().order.length > 0;
  await settings.update({ welcomeTour: 'shown' });
  if (!launchDocument) await openWelcome();
}

/** For tests: lets the first launch run again. */
export function resetFirstLaunch(): void {
  launched = false;
}

/**
 * The Settings row: ends a running tour quietly, closes the open document through the normal close flow, and opens the welcome
 * document fresh, which starts the tour at step 1.
 */
export async function restartTour(): Promise<void> {
  closeSettings();
  // The popover closes with focus on More, where the settings live (DESIGN 3.14).
  document.querySelector<HTMLElement>('[data-toolbar-item="more"]')?.focus({ preventScroll: true });
  useTour.getState().end('restart');
  // Welcome documents that are open already go first; the backend would close its own anyway.
  const documents = useDocuments.getState();
  for (const id of documents.order) {
    if (documents.byId[id]?.kind === 'welcome') {
      useDocuments.getState().setActive(id);
      useViewer.getState().close();
    }
  }
  if (useDocuments.getState().activeId !== null) useViewer.getState().close();
  await openWelcome();
}
