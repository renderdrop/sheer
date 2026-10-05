import { openDocumentDialog, type DocumentInfo, type OpenOutcome } from '../../api/documents';
import { toAppError } from '../../api/errors';
import { useUi } from '../../stores/ui';
import { useJobs } from '../jobs/state';
import { adoptOpenOutcomes, useViewer } from '../viewer/useViewer';
import { HUB_CARDS, type HubCardId } from './cards';
import { consumeIntent, useHub } from './intent';

const openedOf = (outcomes: readonly OpenOutcome[]): DocumentInfo[] =>
  outcomes.flatMap((outcome) => (outcome.type === 'opened' ? [outcome.document] : []));

const othersOf = (outcomes: readonly OpenOutcome[]): OpenOutcome[] =>
  outcomes.filter((outcome) => outcome.type !== 'opened');

/**
 * Merge: the opened files, in pick order, are held for the merge sheet (DESIGN 3.29); cancelling the sheet closes them again.
 * Failures and password requests of the other files go the usual way.
 */
function startMerge(outcomes: readonly OpenOutcome[]): void {
  const held = openedOf(outcomes);
  adoptOpenOutcomes(othersOf(outcomes));
  if (held.length > 0) useJobs.getState().setSheet({ kind: 'merge', held });
}

/**
 * One-file cards: the dialog lets the user pick one file (`single`), which opens as a tab, then the card's intent runs (resolves when
 * it is done).
 */
function startSingle(card: HubCardId, outcomes: readonly OpenOutcome[]): Promise<void> {
  const [first] = openedOf(outcomes);
  if (first === undefined) {
    adoptOpenOutcomes(outcomes);
    return Promise.resolve();
  }
  adoptOpenOutcomes([...othersOf(outcomes), { type: 'opened', document: first }]);
  const intent = HUB_CARDS.find((candidate) => candidate.id === card)?.intent ?? null;
  if (intent !== null) {
    useHub.getState().setPending({ intent, docId: first.id });
    return consumeIntent();
  }
  return Promise.resolve();
}

/**
 * A hub card was activated (DESIGN 3.54). One opening guard: nothing runs while another card or any open is busy. The file
 * dialog is Rust's; cancelling it changes nothing. Open is the viewer's own `open`; Images to PDF opens the dialog of
 * DESIGN 3.43, which starts with its image picker.
 */
export async function runHubCard(card: HubCardId): Promise<void> {
  const hub = useHub.getState();
  const viewer = useViewer.getState();
  if (hub.busy !== null || viewer.opening) return;
  if (card === 'images') {
    useUi.getState().setImagesToPdfOpen(true);
    return;
  }
  hub.setBusy(card);
  // The intent runs after the guards are free again: it may wait for the toolbar or the form to appear.
  let after: Promise<void> = Promise.resolve();
  try {
    if (card === 'open') {
      await viewer.open();
      return;
    }
    useViewer.setState({ opening: true });
    useUi.getState().dismissBanner();
    try {
      const outcomes = await openDocumentDialog({ single: card !== 'merge' });
      if (outcomes.length === 0) return;
      if (card === 'merge') startMerge(outcomes);
      else after = startSingle(card, outcomes);
    } catch (caught) {
      useUi.getState().showBanner(toAppError(caught));
    } finally {
      useViewer.setState({ opening: false });
    }
  } finally {
    useHub.getState().setBusy(null);
  }
  await after;
}
