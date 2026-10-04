import { announce } from '../../components';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useUi } from '../../stores/ui';
import { activeDocId, focusFirstEmpty, focusFirstField } from './focus';
import { useForms } from './store';

/**
 * Flatten form… (Form tool options, More, the macOS Edit menu): opens the confirm dialog of the active document, which runs the
 * flatten job (ADR-041). A document without fields says so in a toast instead.
 */
export function runFlatten(): void {
  const docId = activeDocId();
  if (docId === null) return;
  const forms = useForms.getState();
  void forms.load(docId).then(() => {
    const fields = useForms.getState().byDoc[docId]?.fields ?? [];
    if (fields.length === 0) {
      useUi.getState().showToast({ message: translators[useLocaleStore.getState().locale]('form.noFields') });
      return;
    }
    useForms.getState().setFlattenOpen(true);
  });
}

/**
 * Go to first empty field (the form banner's button, DESIGN 3.58; replaces the Form tool's F): focuses it, or says that every field is
 * filled in. The Flatten action stays `runFlatten` (File menu, §3.56).
 */
export function runNextField(): void {
  const docId = activeDocId();
  if (docId === null) return;
  if (!focusFirstEmpty(docId)) announce(translators[useLocaleStore.getState().locale]('form.allFilled'));
}

/** The form banner's link: focus the first field. */
export function runFirstField(): void {
  const docId = activeDocId();
  if (docId !== null) focusFirstField(docId);
}
