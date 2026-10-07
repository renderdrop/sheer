import { ChevronDown, FileDown } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { exportComments, type CommentExportFormat } from '../../../api/commentExport';
import { Button, Checkbox, Field, Icon, Popover, Segmented, Tooltip } from '../../../components';
import { announce } from '../../../components/SuccessPulse';
import { useT } from '../../../i18n';
import { useLocaleStore } from '../../../i18n/store';
import { useDocuments } from '../../../stores/documents';
import { pageIdAt, pageNumberOf, useSlots } from '../../../stores/pages';
import { useUi } from '../../../stores/ui';
import { useDocView } from '../../../stores/view';
import { Modal, ModalHeader } from '../../jobs/Modal';
import { ProgressBar } from '../../jobs/ProgressBar';
import { useJobRun } from '../../jobs/useJobRun';
import { TagDot } from '../../tags/palette';
import { useTags } from '../../tags/store';
import { facets } from '../model';
import { useComments } from '../store';
import { groupInfo } from '../typeInfo';
import {
  INCLUDE_KEYS,
  countOf,
  draftFromFilter,
  exportThreads,
  noneIncluded,
  optionsOf,
  storeFormat,
  storedFormat,
  type Draft,
  type ExportPages,
  type ExportStatus,
  type IncludeKey,
} from './model';
import { citationLinesOf, closeCommentExport } from './runtime';
import { useCommentExport, type CommentExportDialogState } from './store';

const EMPTY: readonly never[] = [];

function Row({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[var(--comment-export-label)_1fr] items-start gap-4">
      <span id={id} className="t-label flex min-h-control-lg items-center text-text-muted">
        {label}
      </span>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

/** A dropdown with a checkbox list (authors, tags): empty chosen means all. */
function CheckDropdown({
  label,
  summary,
  entries,
  chosen,
  onChange,
}: {
  label: string;
  summary: string;
  entries: readonly { value: string; label: string; leading?: ReactNode }[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Popover
      label={label}
      side="bottom"
      align="start"
      trigger={(trigger) => (
        <Button {...trigger} aria-label={`${label}: ${summary}`} className="w-full min-w-0 justify-between">
          <span className="min-w-0 truncate">{summary}</span>
          <Icon icon={ChevronDown} size={16} />
        </Button>
      )}
    >
      <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1">
        {entries.map((entry) => (
          <label key={entry.value} className="flex min-h-control-md cursor-pointer items-center gap-2 text-md">
            <Checkbox
              checked={chosen.includes(entry.value)}
              onChange={() =>
                onChange(
                  chosen.includes(entry.value) ? chosen.filter((v) => v !== entry.value) : [...chosen, entry.value],
                )
              }
            />
            {entry.leading}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
}

function ExportModal({ request }: { request: CommentExportDialogState }) {
  const t = useT();
  const id = useId();
  const { docId } = request;
  const lang = useLocaleStore((state) => (state.locale === 'de' ? 'de' : 'en'));
  const entry = useComments((state) => state.byDoc[docId]);
  const view = useDocView(docId);
  const current = view.pageIndex + 1;
  const pageCount = view.pageCount;
  const tags = useTags();
  const run = useJobRun();
  // Page numbers follow the page order.
  useSlots(docId);
  const [draft, setDraft] = useState<Draft>(() => draftFromFilter(request.filter, current, pageCount, storedFormat()));
  const set = (change: Partial<Draft>) => setDraft((before) => ({ ...before, ...change }));

  const ready = entry?.status === 'ready' ? entry : null;
  const summaries = ready?.summaries ?? EMPTY;
  const options = useMemo(() => facets(summaries), [summaries]);
  const threads = useMemo(
    () => (ready === null ? [] : exportThreads(ready.threads, draft, current, (pageId) => pageNumberOf(docId, pageId))),
    [ready, draft, current, docId],
  );
  const count = useMemo(() => countOf(threads, (pageId) => pageNumberOf(docId, pageId)), [threads, docId]);
  const nothing = ready !== null && (noneIncluded(draft) || count.items === 0);
  const canExport = ready !== null && !nothing && !run.running;
  const noText = nothing ? t('commentExport.nothing') : null;

  const go = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canExport || ready === null) return;
    const chosen = draft;
    const lines = () => citationLinesOf(docId, threads, lang);
    run.start(
      async (onEvent) => {
        const citationLines = await lines();
        const pageId = pageIdAt(docId, view.pageIndex);
        return exportComments(docId, optionsOf(chosen, lang, pageId, citationLines), onEvent);
      },
      (done) => {
        storeFormat(chosen.format);
        closeCommentExport();
        const message = done.warnings.includes('quotesOmitted')
          ? t('reference.quotesLeftOut')
          : done.warnings.includes('nothingToExport')
            ? t('commentExport.nothing')
            : t('commentExport.saved');
        useUi.getState().showToast({ message });
        announce(message);
      },
    );
  };

  const cancel = () => (run.running ? run.cancel() : closeCommentExport());
  const authorLabel = (author: string) => (author === '' ? t('comments.noAuthor') : author);
  const authorSummary =
    draft.authors.length === 0
      ? t('commentExport.allAuthors')
      : t('commentExport.authors', { n: draft.authors.length });
  const tagSummary =
    draft.tags.length === 0 ? t('commentExport.allTags') : t('commentExport.tagsCount', { n: draft.tags.length });
  const pageOptions: { value: ExportPages; label: string }[] = [
    { value: 'all', label: t('comments.pageAll') },
    { value: 'current', label: t('comments.pageCurrent') },
    { value: 'range', label: t('comments.pageRange') },
  ];
  const statusOptions: { value: ExportStatus; label: string }[] = [
    { value: 'all', label: t('comments.status.all') },
    { value: 'open', label: t('comments.status.open') },
    { value: 'resolved', label: t('comments.status.resolved') },
  ];
  const formatOptions: { value: CommentExportFormat; label: string }[] = [
    { value: 'pdf', label: t('commentExport.format.pdf') },
    { value: 'markdown', label: t('commentExport.format.md') },
  ];
  const clamp = (value: string, fallback: number) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, Math.max(1, pageCount)) : fallback;
  };
  const exportButton = (
    <Button variant="primary" type="submit" data-export="start" disabled={!canExport} focusableWhenDisabled>
      {run.error !== null ? t('comments.retry') : t('commentExport.export')}
    </Button>
  );
  const showBar = run.running && run.slow;

  return (
    <Modal labelledBy={`${id}-title`} width="w-sheet" onClose={cancel}>
      <form data-surface="comment-export" onSubmit={go} className="flex flex-col gap-4">
        <ModalHeader id={`${id}-title`} icon={<Icon icon={FileDown} />} title={t('commentExport.title')} />
        <div className="flex flex-col gap-4" inert={run.running ? true : undefined}>
          <Row label={t('commentExport.include')} id={`${id}-include`}>
            <div role="group" aria-labelledby={`${id}-include`} className="grid grid-cols-2 gap-x-4">
              {INCLUDE_KEYS.map((key: IncludeKey, index) => {
                const info = groupInfo(key);
                return (
                  <label key={key} className="flex min-h-control-lg cursor-pointer items-center gap-2 text-md">
                    <Checkbox
                      checked={draft.include[key]}
                      data-autofocus={index === 0 ? '' : undefined}
                      onChange={() => set({ include: { ...draft.include, [key]: !draft.include[key] } })}
                    />
                    <Icon icon={info.icon} size={16} className="text-text-muted" />
                    <span className="min-w-0 break-words">{t(info.key)}</span>
                  </label>
                );
              })}
            </div>
          </Row>
          {options.authors.length > 1 && (
            <Row label={t('commentExport.author')} id={`${id}-author`}>
              <CheckDropdown
                label={t('commentExport.author')}
                summary={authorSummary}
                chosen={draft.authors}
                onChange={(authors) => set({ authors })}
                entries={options.authors.map((author) => ({ value: author, label: authorLabel(author) }))}
              />
            </Row>
          )}
          {tags.length > 0 && (
            <Row label={t('commentExport.tags')} id={`${id}-tags`}>
              <CheckDropdown
                label={t('commentExport.tags')}
                summary={tagSummary}
                chosen={draft.tags}
                onChange={(next) => set({ tags: next })}
                entries={tags.map((tag) => ({
                  value: tag.name,
                  label: tag.name,
                  leading: <TagDot color={tag.color} />,
                }))}
              />
            </Row>
          )}
          <Row label={t('commentExport.pages')} id={`${id}-pages`}>
            <div className="flex items-center gap-2">
              <Segmented<ExportPages>
                label={t('commentExport.pages')}
                value={draft.pages}
                options={pageOptions}
                onValueChange={(pages) => set({ pages })}
                className="min-w-0 flex-1"
              />
              {draft.pages === 'range' && (
                <span className="flex shrink-0 items-center gap-1">
                  <Field
                    type="number"
                    min={1}
                    max={pageCount}
                    aria-label={t('comments.pageFrom')}
                    value={draft.from}
                    className="w-12"
                    onChange={(event) => set({ from: clamp(event.target.value, draft.from) })}
                  />
                  <span aria-hidden="true">–</span>
                  <Field
                    type="number"
                    min={1}
                    max={pageCount}
                    aria-label={t('comments.pageTo')}
                    value={draft.to}
                    className="w-12"
                    onChange={(event) => set({ to: clamp(event.target.value, draft.to) })}
                  />
                </span>
              )}
            </div>
          </Row>
          <Row label={t('commentExport.status')} id={`${id}-status`}>
            <Segmented<ExportStatus>
              label={t('commentExport.status')}
              value={draft.status}
              options={statusOptions}
              onValueChange={(status) => set({ status })}
            />
          </Row>
          <Row label={t('commentExport.formatLabel')} id={`${id}-format`}>
            <Segmented<CommentExportFormat>
              label={t('commentExport.formatLabel')}
              value={draft.format}
              options={formatOptions}
              onValueChange={(format) => set({ format })}
            />
          </Row>
        </div>
        <p aria-live="polite" data-export="count" className="t-caption m-0 text-text-muted tabular-nums">
          {ready === null
            ? ''
            : (noText ??
              t('commentExport.count', {
                items: t('commentExport.items', { count: count.items }),
                pages: t('commentExport.pagesCount', { count: count.pages }),
              }))}
        </p>
        {run.error !== null && (
          <p role="alert" data-export="failed" className="t-caption m-0 text-error-text">
            {t('commentExport.failed')}
          </p>
        )}
        {showBar ? (
          <div className="flex items-center gap-4" data-export="progress">
            <span className="t-label shrink-0 tabular-nums">
              {t('commentExport.progress', { done: run.progress?.done ?? 0, total: run.progress?.total ?? 0 })}
            </span>
            <ProgressBar
              label={t('commentExport.progressLabel')}
              done={run.progress?.done ?? 0}
              total={run.progress?.total ?? 0}
              className="min-w-0 flex-1"
            />
            <Button variant="ghost" onClick={run.cancel}>
              {t('commentExport.stop')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={cancel}>
              {t('comments.cancel')}
            </Button>
            {noText !== null ? <Tooltip label={noText}>{exportButton}</Tooltip> : exportButton}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** The comment export dialog (DESIGN 3.16 E2), open while `useCommentExport.dialog` is set and its document is still open. */
export function CommentExportDialog() {
  const request = useCommentExport((state) => state.dialog);
  const open = useDocuments((state) => request !== null && state.byId[request.docId] !== undefined);
  return (
    <AnimatePresence>
      {request !== null && open && <ExportModal key={`export-${request.docId}`} request={request} />}
    </AnimatePresence>
  );
}
