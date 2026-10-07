import { announce } from '../../components/SuccessPulse';
import { getHeaderFooter, type HfSpec } from '../../api/headerFooter';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useAnnotations } from '../../stores/annotations';
import { readSlots } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { selectionOf, useOrganize } from '../organize/store';
import { refusalKey } from './model';
import { useHeaderFooter } from './store';

const translate = () => translators[useLocaleStore.getState().locale];

/** First and last selected page (1-based) when Pages mode has cards selected (HF1), else `null`. */
function selectedRange(docId: number): { first: number; last: number } | null {
  if (useUi.getState().activeTool !== 'pages') return null;
  const selected = selectionOf(useOrganize.getState(), docId).selected;
  if (selected.length === 0) return null;
  const slots = readSlots(docId);
  const positions = selected.map((id) => slots.findIndex((slot) => slot.id === id)).filter((index) => index >= 0);
  if (positions.length === 0) return null;
  return { first: Math.min(...positions) + 1, last: Math.max(...positions) + 1 };
}

/**
 * Opens the dialog for the active tab. The backend is asked first (it reads the file's own headers and footers on the first call): a
 * refusal (signed, no permission) shows its toast and nothing opens (HF6); a failure shows `hf.failed`.
 */
export async function openHeaderFooterDialog(): Promise<void> {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null) return;
  const t = translate();
  try {
    const info = await getHeaderFooter(docId);
    if (info.refusal !== null) {
      const message = t(refusalKey(info.refusal));
      useUi.getState().showToast({ message, tone: 'alert' });
      announce(message);
      return;
    }
    if (selectActiveId(useDocuments.getState()) !== docId) return;
    useHeaderFooter.getState().openDialog({ docId, info, preselect: selectedRange(docId) });
  } catch {
    useUi.getState().showToast({ message: t('hf.failed'), tone: 'error' });
  }
}

export function closeHeaderFooterDialog(): void {
  useHeaderFooter.getState().openDialog(null);
}

/**
 * Stages `spec` (`null` removes) as one undo step (HF5). Resolves to whether it worked; a failure shows the error toast and nothing
 * is staged. `pages` is the number of pages the spec reaches (the toast says it).
 */
export async function commitHeaderFooter(docId: number, spec: HfSpec | null, pages: number): Promise<boolean> {
  const t = translate();
  useHeaderFooter.getState().setBusy(docId, true);
  try {
    await useAnnotations.getState().apply(docId, { type: 'setHeaderFooter', spec });
    const message = spec === null ? t('hf.removed') : t('hf.done', { count: pages });
    useUi.getState().showToast({ message });
    announce(message);
    return true;
  } catch {
    const message = t('hf.failed');
    useUi.getState().showToast({ message, tone: 'error' });
    announce(message);
    return false;
  } finally {
    useHeaderFooter.getState().setBusy(docId, false);
  }
}
