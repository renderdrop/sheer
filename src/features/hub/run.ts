import { openDocumentDialog, type DocumentInfo, type OpenOutcome } from '../../api/documents';
import { toAppError } from '../../api/errors';
import { useUi } from '../../stores/ui';
import { useJobs } from '../jobs/state';
import { adoptOpenOutcomes, useViewer } from '../viewer/useViewer';
import type { CatalogueId } from './catalogue';
import { applyLaunch, useHub } from './intent';

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

/** One-file tools: the dialog lets the user pick one file (`single`), which opens as a tab, then the tool starts (resolves when it is done). */
function startSingle(id: CatalogueId, outcomes: readonly OpenOutcome[]): Promise<void> {
  const [first] = openedOf(outcomes);
  if (first === undefined) {
    adoptOpenOutcomes(outcomes);
    return Promise.resolve();
  }
  adoptOpenOutcomes([...othersOf(outcomes), { type: 'opened', document: first }]);
  return applyLaunch(id, first.id);
}

/**
 * A tool was activated from Home (F21.3, DESIGN 3.54). One opening guard: nothing runs while another tile or any open is busy. The
 * file dialog is Rust's; cancelling it changes nothing. Images to PDF opens the dialog of DESIGN 3.43, which starts with its image
 * picker; Merge keeps its several-file flow; every other tool opens one file, switches to its mode and starts ready.
 */
export async function launchTool(id: CatalogueId): Promise<void> {
  const hub = useHub.getState();
  const viewer = useViewer.getState();
  if (hub.busy !== null || viewer.opening) return;
  if (id === 'images') {
    useUi.getState().setImagesToPdfOpen(true);
    return;
  }
  hub.setBusy(id);
  // The launch runs after the guards are free again: it may wait for the toolbar or the form to appear.
  let after: Promise<void> = Promise.resolve();
  try {
    useViewer.setState({ opening: true });
    useUi.getState().dismissBanner();
    try {
      const outcomes = await openDocumentDialog({ single: id !== 'merge' });
      if (outcomes.length === 0) return;
      if (id === 'merge') startMerge(outcomes);
      else after = startSingle(id, outcomes);
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
