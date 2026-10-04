import { toAppError } from '../../../api/errors';
import { translators } from '../../../i18n';
import { useLocaleStore } from '../../../i18n/store';
import { useUi } from '../../../stores/ui';

/**
 * Shows that the backend refused a creation, so a tool never fails silently (F9): a read-only refusal (the document's permissions)
 * says so in a toast, any other refusal (a limit, an invalid draft) goes to the banner like every other failed command.
 */
export function reportRefusal(caught: unknown): void {
  const error = toAppError(caught);
  if (error.code === 'read_only') {
    useUi.getState().showToast({ message: translators[useLocaleStore.getState().locale]('annot.refused.readOnly') });
    return;
  }
  useUi.getState().showBanner(error);
}
