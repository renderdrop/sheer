import { create } from 'zustand';

import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useUi } from '../../stores/ui';
import { focusFirstEmpty } from '../forms/focus';
import { useForms } from '../forms/store';
import { focusToolItem } from '../modes/switch';
import { openCompress, openSplit } from '../jobs/state';
import { enterRedactMode } from '../redact/actions';
import type { HubCardId } from './cards';

/**
 * What a hub card does once its document is open (DESIGN 3.54, "Then" column). Cards whose mode needs a document set an intent
 * after the file is open; `consumeIntent` runs it once and forgets it. Merge and Images to PDF need no document and have none.
 */
export type HubIntent = 'split' | 'compress' | 'sign' | 'redact' | 'fill' | 'export';

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

/** Lands in Ausfüllen & Signieren with the focus on the Signatur item. */
async function landOnSignature(): Promise<void> {
  useUi.getState().setMode('fill');
  await focusToolItem('signature');
}

async function fillForm(docId: number): Promise<void> {
  useUi.getState().setMode('fill');
  const forms = useForms.getState();
  await forms.load(docId);
  const form = useForms.getState().byDoc[docId];
  if (form !== undefined && form.status === 'ready') {
    forms.setHighlight(true);
    focusFirstEmpty(docId);
    return;
  }
  // No fields: a note why; the mode row is on Ausfüllen & Signieren already, with its Text, Datum and Signatur items.
  useUi.getState().showToast({ message: translators[useLocaleStore.getState().locale]('hub.noFields') });
}

/** Runs the intent on the document, which must be the active one by now. */
export async function applyIntent(intent: HubIntent, docId: number): Promise<void> {
  switch (intent) {
    // Each intent lands in its mode (DESIGN v2 3.2): Split and Compress in Seiten, Redact in Bearbeiten.
    case 'split':
      useUi.getState().setMode('pages');
      openSplit('every');
      return;
    case 'compress':
      useUi.getState().setMode('pages');
      openCompress();
      return;
    case 'redact':
      useUi.getState().setMode('edit');
      enterRedactMode();
      return;
    case 'export':
      useUi.getState().setExportImagesOpen(true);
      return;
    case 'sign':
      await landOnSignature();
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
