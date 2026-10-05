import { AnimatePresence } from 'motion/react';
import { FileText, Info } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';

import { emptyBibRecord, setBibliography, type BibliographyInfo } from '../../api/citations';
import { toAppError } from '../../api/errors';
import {
  MAX_METADATA_FIELD_CHARS,
  getMetadata,
  removeMetadata,
  setMetadata,
  type DocMetadata,
} from '../../api/metadata';
import { getProtection } from '../../api/protection';
import { Button, Field, Icon } from '../../components';
import { useLocale, useT } from '../../i18n';
import { invalidateBibliography, useBibliography } from '../citations/bibliography';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { formatSize } from '../jobs/ranges';
import { Modal, ModalHeader } from '../jobs/Modal';
import { usePropertiesTabRequest, type PropertiesTab } from './openReference';
import { ReferenceForm, ReferenceSkeleton } from './ReferenceForm';
import { ReferencePreview } from './ReferencePreview';
import { draftOf, invalidFields, isChanged, recordOf, type RefDraft } from './referenceRules';
import { buildPatch, formatDate, type EditableFields } from './rules';
import { TextTabs } from './TextTabs';

const EDITABLE = [
  ['title', 'props.docTitle'],
  ['author', 'props.author'],
  ['subject', 'props.subject'],
  ['keywords', 'props.keywords'],
] as const;

const fieldsOf = (metadata: DocMetadata): EditableFields => ({
  title: metadata.title ?? '',
  author: metadata.author ?? '',
  subject: metadata.subject ?? '',
  keywords: metadata.keywords ?? '',
});

function PropertiesModal({ docId, pageCount, readOnly }: { docId: number; pageCount: number; readOnly: boolean }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [metadata, setLoaded] = useState<DocMetadata | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [fields, setFields] = useState<EditableFields | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // The tab an entry point named (Reference); the last tab is never remembered.
  const [tab, setTab] = useState<PropertiesTab>(() => usePropertiesTabRequest.getState().tab ?? 'general');
  const { info: bibliography, error: bibliographyError } = useBibliography(docId);
  const [baseline, setBaseline] = useState<BibliographyInfo | null>(null);
  const [refDraft, setRefDraft] = useState<RefDraft | null>(null);
  useEffect(() => {
    usePropertiesTabRequest.setState({ tab: null });
    const unsubscribe = usePropertiesTabRequest.subscribe((state) => {
      if (state.tab === null) return;
      setTab(state.tab);
      usePropertiesTabRequest.setState({ tab: null });
    });
    return () => {
      unsubscribe();
      usePropertiesTabRequest.setState({ tab: null });
    };
  }, []);
  // The first answer of get_bibliography is what the form starts from; a later one does not overwrite what the user typed. A failed
  // read starts from an empty record, like a file with nothing in it. (State set while rendering: derived from the first answer.)
  const start: BibliographyInfo | undefined =
    bibliography ??
    (bibliographyError === undefined
      ? undefined
      : { record: emptyBibRecord(), sources: {}, pending: false, droppedByStrip: false });
  if (baseline === null && start !== undefined) {
    setBaseline(start);
    setRefDraft(draftOf(start.record));
  }

  const close = (): void => useUi.getState().setPropsOpen(false);

  useEffect(() => {
    alive.current = true;
    getMetadata(docId).then(
      (loaded) => {
        if (!alive.current) return;
        setLoaded(loaded);
        setFields(fieldsOf(loaded));
      },
      (caught: unknown) => {
        if (!alive.current) return;
        useUi.getState().showBanner(toAppError(caught));
        useUi.getState().setPropsOpen(false);
      },
    );
    getProtection(docId).then(
      (info) => {
        if (alive.current) setEncrypted(info.encrypted);
      },
      () => undefined,
    );
    return () => {
      alive.current = false;
    };
  }, [docId]);

  const patch = metadata !== null && fields !== null && !removing ? buildPatch(fieldsOf(metadata), fields) : null;
  const generalChanged = removing || (patch !== null && Object.keys(patch).length > 0);
  const refChanged = !readOnly && refDraft !== null && baseline !== null && isChanged(refDraft, baseline.record);
  const refInvalid = refDraft !== null && invalidFields(refDraft).length > 0;
  const changed = generalChanged || refChanged;
  const previewRecord = useMemo(() => (refDraft === null ? null : recordOf(refDraft)), [refDraft]);

  const apply = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!changed || busy || refInvalid) return;
    setBusy(true);
    const wasRemoving = removing;
    // The metadata and the record are document commands of their own (they cannot share a batch): one undo step each.
    const writeAll = async (): Promise<void> => {
      if (generalChanged) {
        const changes = await (wasRemoving ? removeMetadata(docId) : setMetadata(docId, patch ?? {}));
        useAnnotations.getState().applyChanges(docId, changes);
      }
      if (refChanged && refDraft !== null) {
        const changes = await setBibliography(docId, recordOf(refDraft));
        useAnnotations.getState().applyChanges(docId, changes);
        invalidateBibliography(docId);
      }
    };
    writeAll().then(
      () => {
        if (wasRemoving) {
          useUi.getState().showToast({
            message: t('props.removed'),
            action: { label: t('toast.undo'), run: () => void useAnnotations.getState().undo(docId) },
          });
        }
        close();
      },
      (caught: unknown) => {
        useUi.getState().showBanner(toAppError(caught));
        if (alive.current) setBusy(false);
      },
    );
  };

  const missing = t('props.none');
  const plain = (value: string | null): string => (removing ? t('props.willRemove') : (value ?? missing));
  const rows: [string, string][] =
    metadata === null
      ? []
      : [
          [t('props.creator'), plain(metadata.creator)],
          [t('props.producer'), plain(metadata.producer)],
          [t('props.created'), removing ? t('props.willRemove') : formatDate(metadata.created, locale, missing)],
          [t('props.modified'), removing ? t('props.willRemove') : formatDate(metadata.modified, locale, missing)],
          [t('props.pages'), String(pageCount)],
          [t('props.version'), metadata.pdfVersion],
          [t('props.size'), formatSize(metadata.fileBytes, locale)],
          [
            t('props.protection'),
            encrypted === null ? missing : encrypted ? t('props.protectionOn') : t('props.protectionOff'),
          ],
        ];

  const titleId = `${id}-title`;
  return (
    <Modal labelledBy={titleId} width="w-sheet" onClose={close}>
      <div className="flex max-h-[calc(100vh-var(--space-16)-var(--space-12))] min-h-0 flex-col">
        <ModalHeader id={titleId} icon={<Icon icon={FileText} />} title={t('props.title')} />
        <TextTabs
          label={t('props.title')}
          idBase={id}
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'general', label: t('props.tab.general') },
            { value: 'reference', label: t('props.tab.reference') },
          ]}
        />
        <form onSubmit={apply} className="flex min-h-0 flex-1 flex-col" noValidate>
          <div
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-tab-${tab}`}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4 pe-1"
          >
            {tab === 'general' ? (
              <>
                <div data-testid="props-fields" className="grid grid-cols-2 gap-x-4 gap-y-3">
                  {EDITABLE.map(([key, label], index) => (
                    <div key={key} className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={`${id}-f-${key}`} className="text-sm font-semibold">
                        {t(label)}
                      </label>
                      <Field
                        id={`${id}-f-${key}`}
                        type="text"
                        value={fields?.[key] ?? ''}
                        readOnly={removing || fields === null}
                        maxLength={MAX_METADATA_FIELD_CHARS}
                        autoComplete="off"
                        spellCheck={false}
                        data-autofocus={index === 0 ? '' : undefined}
                        onChange={(event) => {
                          const { value } = event.target;
                          setFields((current) => (current === null ? current : { ...current, [key]: value }));
                        }}
                        className="w-full!"
                      />
                    </div>
                  ))}
                </div>
                <dl
                  data-testid="props-facts"
                  className="m-0 grid grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1 border-t border-divider pt-3"
                >
                  {rows.map(([label, value]) => (
                    <Fragment key={label}>
                      <dt className="text-sm text-text-muted">{label}</dt>
                      <dd className={`m-0 min-w-0 break-words text-md ${removing ? 'italic text-text-muted' : ''}`}>
                        {value}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
                {metadata !== null && (metadata.xmp.present || metadata.truncated) && (
                  <p className="m-0 text-sm text-text-muted">
                    {metadata.xmp.present ? t('props.xmpNote') : ''} {metadata.truncated ? t('props.truncated') : ''}
                  </p>
                )}
                <div className="flex h-4 items-center gap-1 text-sm text-text-muted">
                  {removing && (
                    <>
                      <Icon icon={Info} size={16} />
                      <span role="status">{t('props.removeNote')}</span>
                    </>
                  )}
                </div>
              </>
            ) : baseline === null || refDraft === null || previewRecord === null ? (
              <ReferenceSkeleton />
            ) : (
              <ReferenceForm
                info={baseline}
                draft={refDraft}
                onChange={setRefDraft}
                readOnly={readOnly}
                preview={<ReferencePreview record={previewRecord} />}
              />
            )}
          </div>
          <div className="flex items-center gap-2 pt-4">
            {tab === 'general' && (
              <Button
                variant="ghost"
                disabled={metadata === null || removing}
                focusableWhenDisabled
                onClick={() => {
                  setRemoving(true);
                  setFields({ title: '', author: '', subject: '', keywords: '' });
                }}
              >
                {t('props.removeAll')}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="secondary" onClick={close}>
              {t('props.cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={!changed || busy || refInvalid} focusableWhenDisabled>
              {t('props.apply')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

/**
 * The Document properties dialog (DESIGN 3.40), open while `useUi.propsOpen`. Title, author, subject and keywords are editable; the
 * rest is read-only text. The Reference tab (DESIGN 3.7 C5) edits the bibliographic record. "Remove all metadata" changes nothing until Apply;
 * Cancel discards. File text is rendered as text nodes only.
 */
export function PropertiesDialog() {
  const open = useUi((state) => state.propsOpen);
  const doc = useDocuments(selectActiveDocument);
  return (
    <AnimatePresence>
      {open && doc !== null && (
        <PropertiesModal
          key={doc.id}
          docId={doc.id}
          pageCount={doc.pageCount}
          readOnly={doc.flags?.permissions != null && !doc.flags.permissions.includes('edit')}
        />
      )}
    </AnimatePresence>
  );
}
