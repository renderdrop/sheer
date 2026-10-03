import { AnimatePresence } from 'motion/react';
import { FileText, Info } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';

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
import { useAnnotations } from '../../stores/annotations';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { formatSize } from '../jobs/ranges';
import { Modal, ModalHeader } from '../jobs/Modal';
import { buildPatch, formatDate, type EditableFields } from './rules';

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

function PropertiesModal({ docId, pageCount }: { docId: number; pageCount: number }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [metadata, setLoaded] = useState<DocMetadata | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [fields, setFields] = useState<EditableFields | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

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
  const changed = removing || (patch !== null && Object.keys(patch).length > 0);

  const apply = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    const wasRemoving = removing;
    const run = wasRemoving ? removeMetadata(docId) : setMetadata(docId, patch ?? {});
    run.then(
      (changes) => {
        useAnnotations.getState().applyChanges(docId, changes);
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
  const readOnly = (value: string | null): string => (removing ? t('props.willRemove') : (value ?? missing));
  const rows: [string, string][] =
    metadata === null
      ? []
      : [
          [t('props.creator'), readOnly(metadata.creator)],
          [t('props.producer'), readOnly(metadata.producer)],
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
    <Modal labelledBy={titleId} width="w-dialog-md" onClose={close}>
      <ModalHeader id={titleId} icon={<Icon icon={FileText} />} title={t('props.title')} />
      <form onSubmit={apply} className="mt-2 flex flex-col gap-2" noValidate>
        {EDITABLE.map(([key, label], index) => (
          <div key={key} className="flex flex-col gap-0-5">
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
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0-5 border-t border-divider pt-2">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-sm text-text-muted">{label}</dt>
              <dd className={`m-0 min-w-0 break-words text-md ${removing ? 'italic text-text-muted' : ''}`}>{value}</dd>
            </Fragment>
          ))}
        </dl>
        {metadata !== null && (metadata.xmp.present || metadata.truncated) && (
          <p className="m-0 text-sm text-text-muted">
            {metadata.xmp.present ? t('props.xmpNote') : ''} {metadata.truncated ? t('props.truncated') : ''}
          </p>
        )}
        <div className="flex h-2 items-center gap-0-5 text-sm text-text-muted">
          {removing && (
            <>
              <Icon icon={Info} size={12} />
              <span role="status">{t('props.removeNote')}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
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
          <span className="flex-1" />
          <Button variant="secondary" onClick={close}>
            {t('props.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={!changed || busy} focusableWhenDisabled>
            {t('props.apply')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The Document properties dialog (DESIGN 3.40), open while `useUi.propsOpen`. Title, author, subject and keywords are editable; the
 * rest is read-only text. "Remove all metadata" changes nothing until Apply; Cancel discards. File text is rendered as text nodes only.
 */
export function PropertiesDialog() {
  const open = useUi((state) => state.propsOpen);
  const doc = useDocuments(selectActiveDocument);
  return (
    <AnimatePresence>
      {open && doc !== null && <PropertiesModal key={doc.id} docId={doc.id} pageCount={doc.pageCount} />}
    </AnimatePresence>
  );
}
