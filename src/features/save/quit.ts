import { closeWindow } from '../../api/window';
import { useDocuments } from '../../stores/documents';
import { flushPendingDiscards } from '../recovery/actions';
import { forceCloseTab } from '../tabs/nav';
import { needsSavePrompt, saveNow } from './commands';
import { useSave, type PromptAnswer } from './state';

/**
 * The backend holds a close back while it counts a document as open, and a document's close is an IPC call that may still be on
 * its way when the window asks to close: the request then comes again. This many in a row (within `RETRY_WINDOW_MS`) are answered,
 * so a backend that never lets go cannot loop forever.
 */
const MAX_CLOSE_REQUESTS = 10;
const RETRY_WINDOW_MS = 2000;
let closeRequests = 0;
let lastRequestAt = 0;

function ask(docId: number, i: number, n: number): Promise<PromptAnswer> {
  return new Promise((resolve) => {
    useSave.getState().setQuit({ i, n }, resolve);
    useSave.getState().setPrompt(docId);
  });
}

/** Closes the documents (so the backend has none open) and then the window, which the backend lets through now. */
async function closeEverything(): Promise<void> {
  for (const id of [...useDocuments.getState().order]) forceCloseTab(id);
  // A recovery discard still inside its undo window is final now (F21.2).
  await flushPendingDiscards();
  try {
    await closeWindow();
  } catch {
    // No window to close (a browser, a test): nothing more to do.
  }
}

/**
 * The window or the app is being closed (the backend sends `closeRequested` while a document is open and holds the close back,
 * ADR-029 section 7). Walks the documents with unsaved changes one at a time, activating each tab: Save saves it, Don't Save goes on,
 * Cancel (or a failed save) stops the quit and everything stays open. When every one is settled, the documents are closed and the
 * window closes. A request that arrives while the walk is running is ignored.
 */
export async function requestQuit(): Promise<void> {
  if (useSave.getState().quit !== null) return;
  const now = Date.now();
  closeRequests = now - lastRequestAt > RETRY_WINDOW_MS ? 1 : closeRequests + 1;
  lastRequestAt = now;
  if (closeRequests > MAX_CLOSE_REQUESTS) return;
  const targets = useDocuments.getState().order.filter(needsSavePrompt);
  try {
    for (const [index, id] of targets.entries()) {
      if (!needsSavePrompt(id)) continue;
      useDocuments.getState().setActive(id);
      const answer = await ask(id, index + 1, targets.length);
      if (answer === 'cancel') return;
      if (answer === 'save' && !(await saveNow(id))) return;
    }
  } finally {
    // A walk that asked the user is over (done, cancelled or failed): the next request starts counting afresh. A walk with
    // nothing to ask keeps the count, which is what stops a backend that never lets go.
    if (targets.length > 0) closeRequests = 0;
    useSave.getState().setQuit(null);
    useSave.getState().setPrompt(null);
  }
  await closeEverything();
}
