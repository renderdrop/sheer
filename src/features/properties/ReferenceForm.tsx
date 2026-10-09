import { GripVertical, Info, Plus, RotateCcw, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

import {
  BIB_AUTHORS_MAX,
  BIB_DOI_MAX,
  BIB_FIELD_MAX,
  BIB_PERSON_MAX,
  BIB_URL_MAX,
  BIB_YEAR_MAX,
  type BibKind,
  type BibTextField,
  type BibliographyInfo,
} from '../../api/citations';
import { Button, Field, Icon, IconButton, Skeleton } from '../../components';
import { cx } from '../../components/cx';
import { announce } from '../../components/SuccessPulse';
import { FIELD_BASE, FIELD_SIZES } from '../../components/controlStyles';
import { useT } from '../../i18n';
import {
  KIND_OPTIONS,
  captionOf,
  draftOf,
  hasFileValue,
  labelKey,
  moveRow,
  newAuthorRow,
  validate,
  visibleFields,
  type RefDraft,
  type SourceCaption,
} from './referenceRules';

const MAX_LEN: Record<BibTextField, number> = {
  title: BIB_FIELD_MAX,
  year: BIB_YEAR_MAX,
  containerTitle: BIB_FIELD_MAX,
  volume: BIB_FIELD_MAX,
  issue: BIB_FIELD_MAX,
  pages: BIB_FIELD_MAX,
  edition: BIB_FIELD_MAX,
  publisher: BIB_FIELD_MAX,
  place: BIB_FIELD_MAX,
  doi: BIB_DOI_MAX,
  isbn: 24,
  url: BIB_URL_MAX,
  accessed: 10,
};

const CAPTION_KEY = {
  file: 'ref.source.file',
  page1: 'ref.source.page1',
  edited: 'ref.source.edited',
} as const satisfies Record<Exclude<SourceCaption, null>, string>;

export interface ReferenceFormProps {
  /** What was loaded: the record and where each field came from. */
  info: BibliographyInfo;
  draft: RefDraft;
  onChange: (next: RefDraft) => void;
  /** The document forbids edits: every field is read-only text. */
  readOnly: boolean;
  /** The preview (C7), shown last; made by the caller. */
  preview?: ReactNode;
}

/** The loading state: skeleton inputs for the type, title, authors and year (MOTION spell 15). */
export function ReferenceSkeleton() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label={t('ref.title')}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-1">
          <Skeleton shape="line" className="w-20" />
          <Skeleton className="h-control-md w-full" />
        </div>
      ))}
    </div>
  );
}

function CaptionRow({
  id,
  label,
  caption,
  restorable,
  onRestore,
  disabled,
}: {
  id: string;
  label: string;
  caption: SourceCaption;
  restorable: boolean;
  onRestore: () => void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <div className="flex min-h-control-sm items-center gap-2">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <span className="flex-1" />
      {caption !== null && <span className="t-caption text-text-muted">{t(CAPTION_KEY[caption])}</span>}
      {restorable && !disabled && (
        <IconButton size="sm" icon={RotateCcw} label={t('ref.restore')} tooltipSide="bottom" onClick={onRestore} />
      )}
    </div>
  );
}

/**
 * The Reference tab's form (DESIGN 3.7 C5): Type, Title, Authors, Year and the fields of the type, each with where its value came
 * from, an "edited" caption and a restore button for a value the file has. Validation runs on blur; the caller reads
 * `invalidFields` to block Apply. Values of fields a type switch hides are kept in the draft until the record is made.
 */
export function ReferenceForm({ info, draft, onChange, readOnly, preview }: ReferenceFormProps) {
  const t = useT();
  const id = useId();
  const loaded = draftOf(info.record);
  const [blurred, setBlurred] = useState<ReadonlySet<BibTextField>>(new Set());

  const setText = (field: BibTextField, value: string) =>
    onChange({ ...draft, text: { ...draft.text, [field]: value } });
  const blur = (field: BibTextField) => setBlurred((before) => new Set(before).add(field));
  const edited = (field: BibTextField) => draft.text[field] !== loaded.text[field];

  const textField = (field: BibTextField, inputClass = 'w-full', type: 'text' | 'date' = 'text') => {
    const fieldId = `${id}-${field}`;
    const error = blurred.has(field) || edited(field) ? validate(field, draft.text[field]) : null;
    const isEdited = edited(field);
    const restorable = isEdited && hasFileValue(info, field);
    return (
      <div key={field} className="flex flex-col gap-1">
        <CaptionRow
          id={fieldId}
          label={t(labelKey(draft.kind, field))}
          caption={captionOf(info.sources[field], isEdited, draft.text[field].trim() === '')}
          restorable={restorable}
          disabled={readOnly}
          onRestore={() => {
            setText(field, loaded.text[field]);
            setBlurred((before) => {
              const next = new Set(before);
              next.delete(field);
              return next;
            });
          }}
        />
        <Field
          id={fieldId}
          type={type}
          value={draft.text[field]}
          readOnly={readOnly}
          maxLength={MAX_LEN[field]}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : `${fieldId}-error`}
          data-autofocus={field === 'title' ? '' : undefined}
          onChange={(event) => setText(field, event.target.value)}
          onBlur={() => blur(field)}
          className={cx(inputClass, field === 'year' && 'tabular-nums', error !== null && 'border-error-text!')}
        />
        {error !== null && (
          <span id={`${fieldId}-error`} className="t-caption text-error-text">
            {t(error)}
          </span>
        )}
      </div>
    );
  };

  const kindId = `${id}-kind`;
  const nothing =
    info.record.title === null &&
    info.record.year === null &&
    info.record.authors.length === 0 &&
    Object.keys(info.sources).every((field) => info.sources[field as keyof typeof info.sources] === 'none');

  return (
    <div className="flex flex-col gap-4 pt-4">
      {readOnly && (
        <p role="status" className="t-caption m-0 text-text-muted">
          {t('tool.readOnly')}
        </p>
      )}
      {nothing && (
        <div className="flex min-h-8 shrink-0 items-center gap-2 rounded-sm border border-border-subtle bg-subtle px-2">
          <Icon icon={Info} size={16} />
          <span className="t-caption">{t('ref.nothingFound')}</span>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <CaptionRow
          id={kindId}
          label={t('ref.type')}
          caption={captionOf(info.sources.kind, draft.kind !== loaded.kind, false)}
          restorable={draft.kind !== loaded.kind && hasFileValue(info, 'kind')}
          disabled={readOnly}
          onRestore={() => onChange({ ...draft, kind: loaded.kind })}
        />
        <select
          id={kindId}
          value={draft.kind}
          disabled={readOnly}
          onChange={(event) => onChange({ ...draft, kind: event.target.value as BibKind })}
          className={cx(FIELD_BASE, FIELD_SIZES.md, 'w-full')}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {t(option.key)}
            </option>
          ))}
        </select>
      </div>
      {textField('title')}
      <Authors info={info} draft={draft} onChange={onChange} readOnly={readOnly} loaded={loaded} />
      {textField('year', 'w-year!')}
      {visibleFields(draft.kind, draft.text.url).map((field) =>
        textField(field, 'w-full', field === 'accessed' ? 'date' : 'text'),
      )}
      {preview}
    </div>
  );
}

function Authors({
  info,
  draft,
  onChange,
  readOnly,
  loaded,
}: {
  info: BibliographyInfo;
  draft: RefDraft;
  onChange: (next: RefDraft) => void;
  readOnly: boolean;
  loaded: RefDraft;
}) {
  const t = useT();
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<{ key: number; part: 'family' | 'given' } | null>(null);
  const [drag, setDrag] = useState<{ key: number; over: number } | null>(null);
  const rows = draft.authors;
  const edited =
    rows.length !== loaded.authors.length ||
    rows.some((row, i) => row.family !== loaded.authors[i]?.family || row.given !== loaded.authors[i]?.given);

  // Focus follows a new or moved row (a keyed move can drop it).
  useLayoutEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null) return;
    const element = list.current?.querySelector<HTMLElement>(`[data-key="${wanted.key}"] [data-part="${wanted.part}"]`);
    if (element !== null && element !== undefined) {
      focusAfter.current = null;
      element.focus();
    }
  });

  const set = (authors: typeof rows) => onChange({ ...draft, authors });
  const move = (from: number, to: number, part: 'family' | 'given') => {
    if (to < 0 || to >= rows.length || from === to) return;
    const row = rows[from];
    if (row === undefined) return;
    focusAfter.current = { key: row.key, part };
    set(moveRow(rows, from, to));
    announce(t('ref.authorMoved', { n: to + 1, total: rows.length }));
  };
  const remove = (position: number) => {
    const next = rows.filter((_, i) => i !== position);
    const neighbour = next[Math.min(position, next.length - 1)];
    if (neighbour !== undefined) focusAfter.current = { key: neighbour.key, part: 'family' };
    set(next);
  };
  const add = () => {
    const row = newAuthorRow();
    focusAfter.current = { key: row.key, part: 'family' };
    set([...rows, row]);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>, position: number, part: 'family' | 'given') => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    move(position, position + (event.key === 'ArrowUp' ? -1 : 1), part);
  };

  const overPosition = (clientY: number): number => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('li') ?? []);
    let over = items.length - 1;
    for (const [position, item] of items.entries()) {
      const box = item.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) {
        over = position;
        break;
      }
    }
    return Math.max(0, over);
  };
  const startDrag = (event: PointerEvent<HTMLElement>, key: number) => {
    if (event.button !== 0 || readOnly) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ key, over: overPosition(event.clientY) });
  };
  const endDrag = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    if (drag === null) return;
    const from = rows.findIndex((row) => row.key === drag.key);
    const to = overPosition(event.clientY);
    setDrag(null);
    if (commit && from >= 0) move(from, to, 'family');
  };

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-2">
      <div className="flex min-h-control-sm items-center gap-2">
        <span id={`${id}-label`} className="text-sm font-semibold">
          {t('ref.authors')}
        </span>
        <span className="flex-1" />
        {(edited || info.sources.authors !== undefined) && (
          <span className="t-caption text-text-muted">
            {(() => {
              const caption = captionOf(info.sources.authors, edited, rows.length === 0);
              return caption === null ? '' : t(CAPTION_KEY[caption]);
            })()}
          </span>
        )}
        {edited && hasFileValue(info, 'authors') && !readOnly && (
          <IconButton
            size="sm"
            icon={RotateCcw}
            label={t('ref.restore')}
            tooltipSide="bottom"
            onClick={() => set(loaded.authors.map((row) => newAuthorRow(row.family, row.given)))}
          />
        )}
      </div>
      {rows.length > 0 && (
        <ul ref={list} aria-label={t('ref.authors')} className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((row, position) => (
            <li
              key={row.key}
              data-key={row.key}
              className={cx('relative flex min-h-control-md items-center gap-2', drag?.key === row.key && 'opacity-60')}
            >
              {drag !== null && drag.over === position && drag.key !== row.key && (
                <span aria-hidden="true" className="absolute h-insert-marker w-full rounded-full bg-accent" />
              )}
              {!readOnly && (
                <span
                  aria-hidden="true"
                  onPointerDown={(event) => startDrag(event, row.key)}
                  onPointerMove={(event) => {
                    if (drag !== null) setDrag({ ...drag, over: overPosition(event.clientY) });
                  }}
                  onPointerUp={(event) => endDrag(event, true)}
                  onPointerCancel={(event) => endDrag(event, false)}
                  className="flex shrink-0 cursor-grab touch-none items-center text-text-muted"
                >
                  <Icon icon={GripVertical} size={16} />
                </span>
              )}
              <Field
                data-part="family"
                aria-label={t('ref.family')}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                placeholder={t('ref.family')}
                value={row.family}
                readOnly={readOnly}
                maxLength={BIB_PERSON_MAX}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(event) => onKey(event, position, 'family')}
                onChange={(event) =>
                  set(rows.map((r) => (r.key === row.key ? { ...r, family: event.target.value } : r)))
                }
                className="min-w-0 flex-1"
              />
              <Field
                data-part="given"
                aria-label={t('ref.given')}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                placeholder={t('ref.given')}
                value={row.given}
                readOnly={readOnly}
                maxLength={BIB_PERSON_MAX}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(event) => onKey(event, position, 'given')}
                onChange={(event) =>
                  set(rows.map((r) => (r.key === row.key ? { ...r, given: event.target.value } : r)))
                }
                className="min-w-0 flex-1"
              />
              {!readOnly && (
                <IconButton size="sm" icon={X} label={t('ref.removeAuthor')} onClick={() => remove(position)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <Button variant="ghost" className="self-start" disabled={rows.length >= BIB_AUTHORS_MAX} onClick={add}>
          <Icon icon={Plus} size={16} />
          {t('ref.addAuthor')}
        </Button>
      )}
    </div>
  );
}
