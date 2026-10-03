import { subscribeApp, type AppEvent } from '../../api/app';
import type { DocumentInfo } from '../../api/documents';
import { appDropBatch } from '../jobs/dropBatch';
import { requestQuit } from '../save/quit';
import { useUi } from '../../stores/ui';
import { noteHoverEnded, noteOpenedFromApp } from './openTransition';
import { adoptOpenOutcomes } from './useViewer';

const showOpened = (document: DocumentInfo): void => adoptOpenOutcomes([{ type: 'opened', document }]);

/** What the UI does with one push from the backend (see `AppEvent`, src/api/app.ts). */
export function handleAppEvent(event: AppEvent): void {
  if (event.type === 'dropHover') {
    if (!event.active && useUi.getState().dropHover) noteHoverEnded();
    appDropBatch.noteHover(event.active);
    useUi.getState().setDropHover(event.active);
  } else if (event.type === 'closeRequested') {
    void requestQuit();
  } else {
    // A document that opens right after the drag left the window was dropped: the preview card falls and becomes its page (MOTION 4.5).
    if (event.type === 'opened') {
      noteOpenedFromApp();
      // Two or more within a moment are a multi-file drop: the merge banner instead of several tabs (DESIGN 3.29).
      appDropBatch.intake(event.document, showOpened);
    } else {
      adoptOpenOutcomes([event]);
    }
  }
}

/** The part of `subscribeApp` (src/api/app.ts) that is used here. */
export type SubscribeApp = (onEvent: (event: AppEvent) => void) => Promise<void>;

/**
 * Connects the window to what the backend does on its own: files dragged over the window (the drop overlay follows
 * `dropHover`) and files opened by a drop, by the OS (file association, a second launch) or at startup, which arrive as
 * documents to show or an error for the banner. The backend sends them on a channel this call opens, not as events: the window
 * has no event permission (SECURITY T3), and no path ever reaches it (T9, I2). What happened before this call is delivered
 * first, in order. Resolves once the channel is open. Never rejects: where there is no backend (a browser, a test) nothing
 * arrives, and the Open button and the dialog still work.
 */
export async function watchAppEvents(subscribe: SubscribeApp = subscribeApp): Promise<void> {
  try {
    await subscribe(handleAppEvent);
  } catch {
    // No backend to hear from.
  }
}
