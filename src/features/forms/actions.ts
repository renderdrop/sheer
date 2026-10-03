import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useUi } from '../../stores/ui';
import { activeDocId } from './focus';
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
