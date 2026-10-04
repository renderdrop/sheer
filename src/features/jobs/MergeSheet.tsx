import { CircleAlert, FileText, Files, GripVertical, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { DocumentInfo } from '../../api/documents';
import { toAppError, type AppError } from '../../api/errors';
import { mergeDocuments, pickPdfSources, releaseSource, type MergeInput, type SourceId } from '../../api/jobs';
import { Button, Icon, IconButton } from '../../components';
import { announce } from '../../components/SuccessPulse';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { JobError, Spinner } from './JobFooter';
import { Modal, ModalHeader } from './Modal';
import { closeSheet } from './state';
import { useJobRun } from './useJobRun';

/** A file in the list: a document that is open, or a file the Rust dialog admitted (`source`), or one that could not be read. */
export interface MergeEntry {
  key: string;
  name: string;
  pages: number;
  input: MergeInput | null;
  error?: AppError;
}

/** Moves the entry at `from` to `to` (both indices of the list). */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined || to < 0 || to >= list.length) return [...list];
  next.splice(to, 0, item);
  return next;
}

const documentEntry = (doc: Pick<DocumentInfo, 'id' | 'displayName' | 'pageCount'>): MergeEntry => ({
  key: `doc-${doc.id}`,
  name: doc.displayName,
  pages: doc.pageCount,
  input: { type: 'document', docId: doc.id },
});

/** The files a sheet starts with: the documents of a drop, else the active document first. */
export function initialEntries(held: readonly DocumentInfo[] | null, active: DocumentInfo | null): MergeEntry[] {
  if (held !== null) return held.map(documentEntry);
  return active === null ? [] : [documentEntry(active)];
}

let nextKey = 0;

function MergeModal({ held }: { held: readonly DocumentInfo[] | null }) {
  const t = useT();
  const id = useId();
  const active = useDocuments(selectActiveDocument);
  const [entries, setEntries] = useState<MergeEntry[]>(() => initialEntries(held, active));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; over: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<AppError | null>(null);
  const run = useJobRun();
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(entries);
  useEffect(() => {
    latest.current = entries;
  });

  // On leaving, files the dialog admitted are released (a drop's documents are closed by `closeSheet`).
  useEffect(
    () => () => {
      for (const entry of latest.current) {
        if (entry.input?.type === 'source') releaseSource(entry.input.sourceId).catch(() => undefined);
      }
    },
    [],
  );

  // Focus follows a moved row.
  useEffect(() => {
    if (focusKey === null) return;
    list.current?.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }, [focusKey, entries]);

  const readable = entries.filter((entry) => entry.input !== null && entry.error === undefined);
  const broken = entries.some((entry) => entry.error !== undefined);
  const totalPages = readable.reduce((sum, entry) => sum + entry.pages, 0);
  const canMerge = readable.length >= 2 && !broken && !run.running && !adding;

  const remove = (key: string) => {
    const entry = entries.find((item) => item.key === key);
    if (entry?.input?.type === 'source') releaseSource(entry.input.sourceId).catch(() => undefined);
    const index = entries.findIndex((item) => item.key === key);
    const next = entries.filter((item) => item.key !== key);
    setEntries(next);
    setFocusKey(next[Math.min(index, next.length - 1)]?.key ?? null);
  };

  const add = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const picked = await pickPdfSources(true);
      setEntries((current) => [
        ...current,
        ...picked.map((source): MergeEntry => {
          nextKey += 1;
          if (source.type === 'ready') {
            const input: MergeInput = { type: 'source', sourceId: source.sourceId as SourceId };
            return { key: `src-${nextKey}`, name: source.displayName, pages: source.pageCount, input };
          }
          return { key: `bad-${nextKey}`, name: '', pages: 0, input: null, error: source.error };
        }),
      ]);
    } catch (caught) {
      setAddError(toAppError(caught));
    } finally {
      setAdding(false);
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length || from === to) return;
    const key = entries[from]?.key ?? null;
    setEntries(moveEntry(entries, from, to));
    setFocusKey(key);
    announce(t('merge.moved', { n: to + 1 }));
  };

  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const entry = entries[index];
    if (entry === undefined || event.target !== event.currentTarget) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const target = entries[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target !== undefined) setFocusKey(target.key);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(entry.key);
    }
  };

  // Pointer drag by the grip: the marker shows where the row would land.
  const overIndex = (clientY: number): number => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    let over = rows.length - 1;
    for (const [index, row] of rows.entries()) {
      const box = row.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) {
        over = index;
        break;
      }
    }
    return Math.max(0, over);
  };
  const startDrag = (event: PointerEvent<HTMLElement>, key: string) => {
    if (event.button !== 0 || run.running) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ key, over: overIndex(event.clientY) });
  };
  const dragMove = (event: PointerEvent<HTMLElement>) => {
    if (drag !== null) setDrag({ ...drag, over: overIndex(event.clientY) });
  };
  const endDrag = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    if (drag === null) return;
    const from = entries.findIndex((entry) => entry.key === drag.key);
    const to = overIndex(event.clientY);
    setDrag(null);
    if (commit && from >= 0) move(from, to);
  };

  const merge = () => {
    if (!canMerge) return;
    const inputs = readable.flatMap((entry) => (entry.input === null ? [] : [entry.input]));
    run.start(
      (onEvent) => mergeDocuments(inputs, onEvent),
      (event) => {
        if (event.opened !== null) adoptOpenOutcomes([{ type: 'opened', document: event.opened }]);
        closeSheet();
      },
    );
  };

  const cancel = () => (run.running ? run.cancel() : closeSheet());
  const titleId = `${id}-title`;
  const rowHeight = 'h-[calc(var(--space-12)+var(--space-2))]';
  const firstKey = entries[0]?.key;
  const tabStop = focusKey !== null && entries.some((entry) => entry.key === focusKey) ? focusKey : firstKey;

  return (
    <Modal labelledBy={titleId} width="w-sheet" onClose={cancel}>
      <ModalHeader id={titleId} icon={<Icon icon={Files} />} title={t('merge.title')} />
      <div
        ref={list}
        role="listbox"
        aria-label={t('merge.list')}
        aria-orientation="vertical"
        className="relative mt-4 flex max-h-[calc(var(--space-12)*6+var(--space-2)*6)] flex-col gap-2 overflow-y-auto"
      >
        {entries.map((entry, index) => (
          <div key={entry.key} className="relative">
            {drag !== null && drag.over === index && drag.key !== entry.key && (
              <span aria-hidden="true" className="absolute inset-x-0 -top-1 h-insert-marker rounded-full bg-accent" />
            )}
            <div
              role="option"
              aria-selected={false}
              aria-invalid={entry.error !== undefined ? true : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              data-key={entry.key}
              tabIndex={entry.key === tabStop ? 0 : -1}
              onKeyDown={(event) => onRowKey(event, index)}
              className={`flex ${rowHeight} items-center gap-2 rounded-card border border-divider bg-surface-solid px-2 ${
                drag?.key === entry.key ? 'opacity-60' : ''
              }`}
            >
              <span
                aria-hidden="true"
                onPointerDown={(event) => startDrag(event, entry.key)}
                onPointerMove={dragMove}
                onPointerUp={(event) => endDrag(event, true)}
                onPointerCancel={(event) => endDrag(event, false)}
                className="flex shrink-0 cursor-grab touch-none items-center text-text-muted"
              >
                <Icon icon={GripVertical} />
              </span>
              <span className="flex h-10 w-8 shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon">
                <Icon icon={entry.error !== undefined ? CircleAlert : FileText} />
              </span>
              <span className="flex min-w-0 flex-auto flex-col">
                {entry.error !== undefined ? (
                  <span className="truncate text-error-text">{t('merge.unreadable')}</span>
                ) : (
                  <>
                    <span className="truncate font-semibold">{entry.name}</span>
                    <span className="text-sm text-text-muted">{t('merge.pages', { count: entry.pages })}</span>
                  </>
                )}
              </span>
              <IconButton
                size="sm"
                icon={X}
                label={t('merge.remove', { name: entry.error !== undefined ? t('merge.unreadable') : entry.name })}
                tabIndex={-1}
                disabled={run.running}
                onClick={() => remove(entry.key)}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Button variant="secondary" size="sm" onClick={add} disabled={adding || run.running} focusableWhenDisabled>
          {t('merge.add')}
        </Button>
        <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
          {t('merge.total', { count: totalPages })}
        </p>
      </div>
      <JobError error={run.error ?? addError} />
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={cancel}>
          {t('merge.cancel')}
        </Button>
        <Button
          variant="primary"
          data-autofocus=""
          disabled={!canMerge}
          focusableWhenDisabled
          aria-busy={run.running ? true : undefined}
          aria-label={run.running ? t('merge.working') : undefined}
          onClick={merge}
        >
          {run.running ? <Spinner /> : t('merge.merge')}
        </Button>
      </div>
    </Modal>
  );
}

/** The merge sheet (DESIGN 3.29). `held` are the documents of a multi-file drop. */
export function MergeSheet({ held }: { held: readonly DocumentInfo[] | null }) {
  return <MergeModal held={held} />;
}
