import { PILL } from '../../components/controlStyles';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useT } from '../../i18n';
import { useForms } from './store';

/** The "Form" badge of the status bar (DESIGN 3.10, 3.32): shown while the active document has fields. Same pill as "Edited". */
export function FormPill() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const has = useForms((state) => docId !== null && (state.byDoc[docId]?.fields.length ?? 0) > 0);
  if (!has) return null;
  return (
    <span data-form-pill="" className={PILL}>
      {t('form.badge')}
    </span>
  );
}
