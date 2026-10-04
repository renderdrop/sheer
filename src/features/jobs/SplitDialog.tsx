import { Scissors } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

import { extractPages, listPageIds, splitDocument, type PageId } from '../../api/jobs';
import { Button, Field, Icon } from '../../components';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { JobError, JobProgress, Spinner } from './JobFooter';
import { Modal, ModalHeader } from './Modal';
import { RadioGroup } from './RadioGroup';
import { everyN, pageIndices, parseCount, parseRanges, previewRanges, type PageRange } from './ranges';
import { closeSheet, type SplitMode } from './state';
import { useJobRun } from './useJobRun';

/** How long after the last key the field is checked (DESIGN 3.30). */
export const VALIDATE_MS = 150;

export type Check = { ok: true; ranges: PageRange[]; files: number } | { ok: false; problem: 'invalid' | null };

/** What the field says, for `total` pages. `problem: null` is an empty field: not valid yet, but not an error either. */
export function checkInput(mode: SplitMode, text: string, total: number): Check {
  if (mode === 'every') {
    if (total < 2) return { ok: false, problem: 'invalid' };
    const n = parseCount(text, total - 1);
    if (n === null) return { ok: false, problem: text.trim() === '' ? null : 'invalid' };
    const ranges = everyN(n, total);
    return { ok: true, ranges, files: ranges.length };
  }
  if (text.trim() === '') return { ok: false, problem: null };
  const ranges = parseRanges(text, total);
  if (ranges === null) return { ok: false, problem: 'invalid' };
  if (mode === 'ranges') {
    return { ok: true, ranges, files: ranges.length };
  }
  return { ok: true, ranges, files: pageIndices(ranges).length };
}

function SplitModal({ initialMode }: { initialMode: SplitMode }) {
  const t = useT();
  const id = useId();
  const doc = useDocuments(selectActiveDocument);
  const total = doc?.pageCount ?? 0;
  const [mode, setMode] = useState<SplitMode>(initialMode);
  const [texts, setTexts] = useState<Record<SplitMode, string>>({ every: '1', ranges: '', extract: '' });
  const [settled, setSettled] = useState(texts);
  const [pattern, setPattern] = useState('{name}-{n}');
  const run = useJobRun();
  const text = texts[mode];

  useEffect(() => {
    const timer = setTimeout(() => setSettled(texts), VALIDATE_MS);
    return () => clearTimeout(timer);
  }, [texts]);

  const live = settled[mode] === text;
  const check = useMemo(() => checkInput(mode, settled[mode], total), [mode, settled, total]);
  const errorId = `${id}-error`;
  const previewId = `${id}-preview`;
  const invalid = !check.ok && check.problem !== null && live;
  const canGo = check.ok && live && !run.running && doc !== null;

  const submit = () => {
    if (!check.ok || !canGo || doc === null) return;
    const docId = doc.id;
    const ranges = check.ranges;
    const naming = pattern.trim() === '' ? undefined : pattern;
    const every = parseCount(settled.every, total) ?? 1;
    run.start(
      async (onEvent) => {
        if (mode === 'every') return splitDocument(docId, { type: 'everyN', n: every, pattern: naming }, onEvent);
        const ids = await listPageIds(docId);
        if (mode === 'ranges') {
          return splitDocument(docId, { type: 'ranges', text: settled.ranges, pattern: naming }, onEvent);
        }
        const pages = pageIndices(ranges).map((index) => ids[index]);
        if (pages.some((pageId) => pageId === undefined)) throw new Error('page list changed');
        return extractPages(docId, pages as PageId[], onEvent);
      },
      (event) => {
        closeSheet();
        useUi.getState().showToast({ message: t('split.done', { count: event.outputs }) });
      },
    );
  };

  const modes: readonly { value: SplitMode; label: string }[] = [
    { value: 'every', label: t('split.every') },
    { value: 'ranges', label: t('split.ranges') },
    { value: 'extract', label: t('split.extract') },
  ];

  let preview = '';
  if (check.ok && live) {
    preview =
      mode === 'extract'
        ? t('split.extractPreview', { count: check.files })
        : `${t('split.preview', { count: check.files })}: ${previewRanges(check.ranges)}`;
  }

  const describedBy = invalid ? errorId : previewId;
  const cancel = () => (run.running ? run.cancel() : closeSheet());

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={cancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col"
      >
        <ModalHeader id={`${id}-title`} icon={<Icon icon={Scissors} />} title={t('split.title')} />
        <RadioGroup
          label={t('split.title')}
          look="segmented"
          orientation="horizontal"
          value={mode}
          disabled={run.running}
          onChange={setMode}
          className="mt-4"
          options={modes.map((m) => ({ value: m.value, label: m.label, content: m.label }))}
        />
        <div className="mt-3 flex min-h-control-md items-center gap-2">
          {mode === 'every' ? (
            <>
              <Field
                key="every"
                data-autofocus=""
                inputMode="numeric"
                autoComplete="off"
                readOnly={run.running}
                aria-label={t('split.count')}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={describedBy}
                value={texts.every}
                onChange={(event) => setTexts({ ...texts, every: event.target.value })}
                align="end"
                className="w-field"
              />
              <span className="text-text-muted">{t('split.pages')}</span>
            </>
          ) : (
            <Field
              key={mode}
              data-autofocus=""
              autoComplete="off"
              spellCheck={false}
              readOnly={run.running}
              aria-label={mode === 'ranges' ? t('split.rangesLabel') : t('split.extract')}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={describedBy}
              placeholder={t('split.placeholder')}
              value={text}
              onChange={(event) => setTexts({ ...texts, [mode]: event.target.value })}
              className="w-full"
            />
          )}
        </div>
        <div className="flex h-4 items-center text-sm text-error-text">
          {invalid && (
            <p id={errorId} className="m-0">
              {t('split.invalid', { n: total })}
            </p>
          )}
        </div>
        <p id={previewId} role="status" aria-live="polite" className="m-0 min-h-6 text-sm text-text-muted">
          {preview}
        </p>
        {mode !== 'extract' && (
          <Field
            aria-label={t('split.naming')}
            autoComplete="off"
            spellCheck={false}
            readOnly={run.running}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            className="mt-2 w-full"
          />
        )}
        <div className="mt-2">
          <JobProgress run={run} label={t('split.working')} />
        </div>
        <JobError error={run.error} />
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={cancel}>
            {t('split.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!canGo}
            focusableWhenDisabled
            aria-busy={run.running ? true : undefined}
            aria-label={run.running ? t('split.working') : undefined}
          >
            {run.running ? <Spinner /> : mode === 'extract' ? t('split.save') : t('split.split')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The split and extract dialog (DESIGN 3.30). */
export function SplitDialog({ mode }: { mode: SplitMode }) {
  return <SplitModal initialMode={mode} />;
}
