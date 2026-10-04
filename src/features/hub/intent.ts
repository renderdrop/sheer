import { create } from 'zustand';

import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useUi } from '../../stores/ui';
import { focusFirstEmpty } from '../forms/focus';
import { useForms } from '../forms/store';
import { openCompress, openSplit } from '../jobs/state';
import { enterRedactMode } from '../redact/actions';
import type { HubCardId } from './cards';

/**
 * What a hub card does once its document is open (DESIGN 3.54, "Then" column). Cards whose mode needs a document set an intent
 * after the file is open; `consumeIntent` runs it once and forgets it. Merge and Images to PDF need no document and have none.
 */
export type HubIntent = 'split' | 'compress' | 'sign' | 'redact' | 'fill';

interface Pending {
  intent: HubIntent;
  docId: number;
}

interface HubState {
  /** The card whose file dialog or open is running (`aria-busy`; the other cards are `aria-disabled`). */
  busy: HubCardId | null;
  pending: Pending | null;
  setBusy: (busy: HubCardId | null) => void;
  setPending: (pending: Pending | null) => void;
}

export const useHub = create<HubState>()((set) => ({
  busy: null,
  pending: null,
  setBusy: (busy) => set({ busy }),
  setPending: (pending) => set({ pending }),
}));

/** The toolbar item that opens the Fill & Sign popover (DESIGN 3.58). */
export const SIGN_ITEM_SELECTOR = '[data-toolbar-item="signature"]';
/** How long an intent waits for something that mounts or loads after the open (the toolbar item). */
export const INTENT_WAIT_MS = 2000;
const POLL_MS = 40;

/** Resolves with the element once it exists, or `null` after `INTENT_WAIT_MS`. */
export function waitForElement(selector: string): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = (): void => {
      const found = document.querySelector<HTMLElement>(selector);
      if (found !== null) resolve(found);
      else if (Date.now() - started >= INTENT_WAIT_MS) resolve(null);
      else setTimeout(look, POLL_MS);
    };
    look();
  });
}

/** Opens the Fill & Sign popover through its toolbar item. */
async function openSignPopover(): Promise<void> {
  (await waitForElement(SIGN_ITEM_SELECTOR))?.click();
}

/** Organize mode: the Pages tool, unless it is on already (choosing the active tool would leave it). */
function enterOrganize(): void {
  const ui = useUi.getState();
  if (ui.activeTool !== 'pages') ui.selectTool('pages');
}

async function fillForm(docId: number): Promise<void> {
  const forms = useForms.getState();
  await forms.load(docId);
  const form = useForms.getState().byDoc[docId];
  if (form !== undefined && form.status === 'ready') {
    forms.setHighlight(true);
    focusFirstEmpty(docId);
    return;
  }
  // No fields: the popover on its Fill section, and a note why.
  useUi.getState().showToast({ message: translators[useLocaleStore.getState().locale]('hub.noFields') });
  await openSignPopover();
}

/** Runs the intent on the document, which must be the active one by now. */
export async function applyIntent(intent: HubIntent, docId: number): Promise<void> {
  switch (intent) {
    case 'split':
      enterOrganize();
      openSplit('every');
      return;
    case 'compress':
      openCompress();
      return;
    case 'redact':
      enterRedactMode();
      useUi.getState().setInspector('open');
      return;
    case 'sign':
      await openSignPopover();
      return;
    case 'fill':
      await fillForm(docId);
      return;
  }
}

/** Runs the pending intent, if any, and forgets it. */
export async function consumeIntent(): Promise<void> {
  const { pending, setPending } = useHub.getState();
  if (pending === null) return;
  setPending(null);
  await applyIntent(pending.intent, pending.docId);
}
