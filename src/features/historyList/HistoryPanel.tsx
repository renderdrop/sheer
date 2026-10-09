import { History, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { IconButton } from '../../components';
import { cx } from '../../components/cx';
import { isPlainKey, useLocale, useT, type Translate } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { InspectorFrame } from '../inspector/InspectorFrame';
import { useToolInspector } from '../inspector/toolInspector';
import {
  deleteFromHistory,
  installHistoryLog,
  jumpTo,
  logOf,
  refreshHistory,
  useHistoryLog,
  type HistoryEntry,
} from './log';

installHistoryLog();

/** "Highlight · p. 3": the kind or operation, then the page when the step has one. */
export function entryLabel(t: Translate, entry: HistoryEntry, pageNumber: number | null): string {
  let what: string;
  if (entry.batchLabel !== null && entry.what === 'batch')
    what = isPlainKey(entry.batchLabel) ? t(entry.batchLabel) : entry.batchLabel;
  else if (entry.group === 'annotation' && entry.what !== 'update') {
    what = t(`historyList.kind.${entry.what}` as 'historyList.kind.highlight');
  } else what = t(`historyList.op.${entry.what}` as 'historyList.op.change');
  return pageNumber === null ? what : `${what} · ${t('comments.page', { n: pageNumber })}`;
}

interface RowProps {
  entry: HistoryEntry;
  label: string;
  time: string;
  /** 0-based position in the list, oldest first; the state after this entry is `index + 1`. */
  index: number;
  current: boolean;
  undone: boolean;
  canDelete: boolean;
  tabbable: boolean;
  onJump: () => void;
  onDelete: () => void;
  onMove: (to: 'prev' | 'next' | 'first' | 'last') => void;
  setRef: (element: HTMLButtonElement | null) => void;
}

function Row({ entry, label, time, current, undone, canDelete, tabbable, onJump, onDelete, onMove, setRef }: RowProps) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const to = { ArrowUp: 'prev', ArrowDown: 'next', Home: 'first', End: 'last' }[event.key] as
      'prev' | 'next' | 'first' | 'last' | undefined;
    if (to !== undefined) {
      event.preventDefault();
      onMove(to);
    } else if (event.key === 'Delete' && entry.annotationId !== null && canDelete) {
      event.preventDefault();
      onDelete();
    }
  };
  return (
    <li className="flex items-center gap-1" data-history-entry={entry.id}>
      <button
        ref={setRef}
        type="button"
        tabIndex={tabbable ? 0 : -1}
        aria-current={current ? 'step' : undefined}
        onClick={onJump}
        onKeyDown={onKeyDown}
        className={cx(
          'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border-0 px-2 py-1 text-start text-sm',
          'bg-transparent hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-0',
          current && 'bg-selected font-medium',
          undone ? 'text-text-disabled' : 'text-text',
        )}
      >
        <span className="truncate">
          {label}
          {current && <span className="sr-only">{`, ${t('historyList.current')}`}</span>}
          {undone && <span className="sr-only">{`, ${t('historyList.undone')}`}</span>}
        </span>
        <span className="t-caption shrink-0 tabular-nums text-text-muted">{time}</span>
      </button>
      {entry.annotationId !== null && (
        <IconButton
          icon={Trash2}
          size="sm"
          iconSize={16}
          tabIndex={-1}
          label={t('historyList.delete', { what: label })}
          disabled={!canDelete}
          onClick={onDelete}
        />
      )}
    </li>
  );
}

/**
 * The history list of the tool inspector (F19.23, DESIGN §3.18 E3/E5): every step of the session for the active document, newest
 * on top, the current state marked, the states after it greyed. A click takes the document to the state after that entry by undo
 * and redo steps in order; the trash button of an annotation entry deletes the annotation through the normal, undoable command.
 */
export function HistoryPanel() {
  const t = useT();
  const locale = useLocale();
  const docId = useDocuments((state) => state.activeId);
  const log = useHistoryLog((state) => logOf(state, docId));
  const byId = useAnnotations((state) => (docId === null ? undefined : state.byDoc[docId]?.byId));
  const slots = usePages((state) => (docId === null ? undefined : state.slotsByDoc[docId]));
  const [announce, setAnnounce] = useState('');
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const [focusIndex, setFocusIndex] = useState(0);

  // The backend's list may hold steps from before the panel was open.
  useEffect(() => {
    if (docId !== null) void refreshHistory(docId);
  }, [docId]);

  const formatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const pageNumber = (pageId: number | null): number | null => {
    if (pageId === null || slots === undefined) return null;
    const at = slots.findIndex((slot) => slot.id === pageId);
    return at < 0 ? null : at + 1;
  };

  // Rows are shown newest first; `position` 0 is the "as opened" row at the bottom.
  const rows = [...log.entries.keys()].reverse();
  const count = rows.length + 1;
  const focusTo = (position: number) => {
    const next = Math.min(count - 1, Math.max(0, position));
    setFocusIndex(next);
    refs.current.get(next)?.focus();
  };
  const move = (from: number, to: 'prev' | 'next' | 'first' | 'last') =>
    focusTo(to === 'prev' ? from - 1 : to === 'next' ? from + 1 : to === 'first' ? 0 : count - 1);

  const jump = (state: number, said: string | null) => {
    if (docId === null) return;
    void jumpTo(docId, state).then((reached) => {
      if (reached) setAnnounce(said === null ? t('historyList.jumpedStart') : t('historyList.jumped', { what: said }));
    });
  };

  const original = (
    <li key="original" className="flex items-center gap-1">
      <button
        ref={(element) => {
          if (element === null) refs.current.delete(rows.length);
          else refs.current.set(rows.length, element);
        }}
        type="button"
        tabIndex={focusIndex === rows.length ? 0 : -1}
        aria-current={log.cursor === 0 ? 'step' : undefined}
        onClick={() => jump(0, null)}
        onKeyDown={(event) => {
          const to = { ArrowUp: 'prev', ArrowDown: 'next', Home: 'first', End: 'last' }[event.key] as
            'prev' | 'next' | 'first' | 'last' | undefined;
          if (to === undefined) return;
          event.preventDefault();
          move(rows.length, to);
        }}
        className={cx(
          'flex min-w-0 flex-1 items-center rounded-md border-0 px-2 py-1 text-start text-sm text-text',
          'bg-transparent hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-0',
          log.cursor === 0 && 'bg-selected font-medium',
        )}
      >
        {t('historyList.original')}
      </button>
    </li>
  );

  return (
    <InspectorFrame
      icon={History}
      title={t('historyList.title')}
      surface="history"
      footer={null}
      onDismiss={() => useToolInspector.getState().closeToolInspector('history')}
    >
      {log.entries.length === 0 && <p className="m-0 text-sm text-text-muted">{t('historyList.empty')}</p>}
      <ul aria-label={t('historyList.label')} className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((entryIndex, position) => {
          const entry = log.entries[entryIndex] as HistoryEntry;
          const label = entryLabel(t, entry, pageNumber(entry.pageId));
          return (
            <Row
              key={entry.id}
              entry={entry}
              label={label}
              time={formatter.format(entry.time)}
              index={entryIndex}
              current={entryIndex === log.cursor - 1}
              undone={entryIndex >= log.cursor}
              canDelete={entry.annotationId !== null && byId?.[entry.annotationId] !== undefined}
              tabbable={focusIndex === position}
              onJump={() => jump(entryIndex + 1, label)}
              onDelete={() => {
                if (docId !== null && entry.annotationId !== null) void deleteFromHistory(docId, entry.annotationId);
              }}
              onMove={(to) => move(position, to)}
              setRef={(element) => {
                if (element === null) refs.current.delete(position);
                else refs.current.set(position, element);
              }}
            />
          );
        })}
        {original}
      </ul>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </InspectorFrame>
  );
}
