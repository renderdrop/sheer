import { Stamp } from 'lucide-react';

import { Button, PanelSection } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { runFlatten } from './actions';
import { useForms } from './store';

/** Tool options of the Form tool (DESIGN 3.24, 3.32): the highlight toggle and Flatten. */
export function FormOptions() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const highlight = useForms((state) => state.highlight);
  const setHighlight = useForms((state) => state.setHighlight);
  const count = useForms((state) => (docId === null ? 0 : (state.byDoc[docId]?.fields.length ?? 0)));
  return (
    <>
      <PanelSection>
        <div className="flex flex-col gap-1">
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={highlight}
            className="aria-pressed:bg-selected"
            onClick={() => setHighlight(!highlight)}
          >
            {t('form.highlight')}
          </Button>
          <p className="m-0 text-sm text-text-muted">{count === 0 ? t('form.noFields') : t('form.hint')}</p>
        </div>
      </PanelSection>
      <PanelSection>
        <Button
          variant="secondary"
          size="sm"
          icon={Stamp}
          disabled={count === 0}
          focusableWhenDisabled
          onClick={runFlatten}
        >
          {t('form.flatten')}
        </Button>
      </PanelSection>
    </>
  );
}
