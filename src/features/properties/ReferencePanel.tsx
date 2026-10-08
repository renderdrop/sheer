import { BookMarked } from 'lucide-react';
import { useMemo, useState } from 'react';

import { emptyBibRecord, setBibliography, type BibliographyInfo } from '../../api/citations';
import { toAppError } from '../../api/errors';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { invalidateBibliography, useBibliography } from '../citations/bibliography';
import { InspectorFrame, type InspectorFooter } from '../inspector/InspectorFrame';
import { closeReferenceInspector, useReferenceInspector } from './openReference';
import { ReferenceForm, ReferenceSkeleton } from './ReferenceForm';
import { ReferencePreview } from './ReferencePreview';
import { draftOf, invalidFields, isChanged, recordOf, type RefDraft } from './referenceRules';

function Panel({ docId }: { docId: number }) {
  const t = useT();
  const readOnly = useDocuments((state) => {
    const permissions = state.byId[docId]?.flags?.permissions;
    return permissions != null && !permissions.includes('edit');
  });
  const { info: bibliography, error } = useBibliography(docId);
  const [baseline, setBaseline] = useState<BibliographyInfo | null>(null);
  const [draft, setDraft] = useState<RefDraft | null>(null);
  const [busy, setBusy] = useState(false);

  // The first answer of get_bibliography is what the form starts from; a later one does not overwrite what the user typed. A failed
  // read starts from an empty record, like a file with nothing in it. (State set while rendering: derived from the first answer.)
  const start: BibliographyInfo | undefined =
    bibliography ??
    (error === undefined
      ? undefined
      : { record: emptyBibRecord(), sources: {}, pending: false, droppedByStrip: false });
  if (baseline === null && start !== undefined) {
    setBaseline(start);
    setDraft(draftOf(start.record));
  }

  const preview = useMemo(() => (draft === null ? null : recordOf(draft)), [draft]);
  const changed = !readOnly && draft !== null && baseline !== null && isChanged(draft, baseline.record);
  const invalid = draft !== null && invalidFields(draft).length > 0;

  const apply = (): void => {
    if (!changed || invalid || busy || draft === null) return;
    setBusy(true);
    setBibliography(docId, recordOf(draft)).then(
      (changes) => {
        useAnnotations.getState().applyChanges(docId, changes);
        invalidateBibliography(docId);
        closeReferenceInspector();
      },
      (caught: unknown) => {
        useUi.getState().showBanner(toAppError(caught));
        setBusy(false);
      },
    );
  };

  const footer: InspectorFooter = {
    apply: { label: t('inspector.apply'), disabled: !changed || invalid, busy, onApply: apply },
    reset: {
      disabled: !changed || baseline === null,
      onReset: () => baseline !== null && setDraft(draftOf(baseline.record)),
    },
  };

  return (
    <InspectorFrame
      icon={BookMarked}
      title={t('props.tab.reference')}
      surface="reference"
      footer={footer}
      onDismiss={closeReferenceInspector}
    >
      {baseline === null || draft === null || preview === null ? (
        <ReferenceSkeleton />
      ) : (
        <ReferenceForm
          info={baseline}
          draft={draft}
          onChange={setDraft}
          readOnly={readOnly}
          preview={<ReferencePreview record={preview} />}
        />
      )}
    </InspectorFrame>
  );
}

/** The Quellenangabe inspector (DESIGN 3.7 C5, §3.18 E5): the bibliographic record of the active document. */
export function ReferencePanel() {
  const docId = useReferenceInspector((state) => state.docId);
  return docId === null ? null : <Panel key={docId} docId={docId} />;
}
