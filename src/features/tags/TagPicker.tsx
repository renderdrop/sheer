import { Check, Tag } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { TAGS_MAX, TAGS_PER_ANNOT } from '../../api/cite';
import { toAppError } from '../../api/errors';
import { Field, IconButton, Popover, type IconButtonSize } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useSignatureLock } from '../lock/useSignatureLock';
import { TagDot } from './palette';
import { createTag, tagNameProblem, useTags, type TagProblem } from './store';
import { TagManager } from './TagManager';

const STEP_LABEL = 'tags.assign';
const NO_TAGS: readonly string[] = [];
const ITEM =
  'flex h-control-md w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 text-start text-md text-text ' +
  'hover:bg-subtle focus-visible:bg-subtle focus-visible:outline-2 focus-visible:outline-focus aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)';

const has = (names: readonly string[], name: string): boolean =>
  names.some((other) => other.toLowerCase() === name.toLowerCase());

/** Sets the tag lists of the annotations in one undo step (one command when there is one annotation). */
async function assign(docId: number, lists: readonly { id: number; tags: string[] }[]): Promise<void> {
  if (lists.length === 0) return;
  const commands = lists.map(({ id, tags }) => ({ type: 'updateAnnotation' as const, id, patch: { tags } }));
  try {
    await useAnnotations
      .getState()
      .apply(
        docId,
        commands.length === 1 && commands[0] !== undefined
          ? commands[0]
          : { type: 'batch', label: STEP_LABEL, commands },
      );
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
  }
}

interface BodyProps {
  docId: number;
  annotIds: readonly number[];
}

/** The picker (DESIGN 3.7 C6): find-or-create input, one checkbox item per tag, "Create" and "Manage tags…". */
function PickerBody({ docId, annotIds }: BodyProps) {
  const t = useT();
  const tags = useTags();
  const [query, setQuery] = useState('');
  const [managing, setManaging] = useState(false);
  const [problem, setProblem] = useState<TagProblem | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const byId = useAnnotations((state) => state.byDoc[docId]?.byId);

  const current = useMemo(() => annotIds.map((id) => byId?.[id]?.tags ?? NO_TAGS), [annotIds, byId]);
  const text = query.trim();
  const shown = tags.filter((tag) => tag.name.toLowerCase().includes(text.toLowerCase()));
  const canCreate =
    text !== '' &&
    !tags.some((tag) => tag.name.toLowerCase() === text.toLowerCase()) &&
    tagNameProblem(text, tags) === null;

  const state = (name: string): 'all' | 'some' | 'none' => {
    const count = current.filter((names) => has(names, name)).length;
    return count === 0 ? 'none' : count === current.length ? 'all' : 'some';
  };
  /** Adding to an annotation that has all eight already is refused; the item says so by being disabled. */
  const full = (name: string): boolean =>
    state(name) !== 'all' && current.some((names) => !has(names, name) && names.length >= TAGS_PER_ANNOT);

  const toggle = (name: string) => {
    const removing = state(name) === 'all';
    if (!removing && full(name)) return;
    const lists = annotIds.flatMap((id, i) => {
      const names = current[i] ?? NO_TAGS;
      if (removing) return [{ id, tags: names.filter((other) => other.toLowerCase() !== name.toLowerCase()) }];
      return has(names, name) ? [] : [{ id, tags: [...names, name] }];
    });
    void assign(docId, lists);
  };

  const create = async () => {
    if (!canCreate) return;
    const result = await createTag(text);
    if (!result.ok) return setProblem(result.problem);
    setProblem(null);
    setQuery('');
    const lists = annotIds.flatMap((id, i) => {
      const names = current[i] ?? NO_TAGS;
      return names.length >= TAGS_PER_ANNOT ? [] : [{ id, tags: [...names, result.name] }];
    });
    void assign(docId, lists);
    inputRef.current?.focus();
  };

  const items = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-tag-item]') ?? [])];
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items()[0]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (canCreate) void create();
      else if (shown.length === 1 && shown[0] !== undefined) toggle(shown[0].name);
    }
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[Math.min(at + 1, list.length - 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (at === 0) inputRef.current?.focus();
      else list[at - 1]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list[list.length - 1]?.focus();
    }
  };

  if (managing) return <TagManager docId={docId} />;

  const limitReached = tags.length >= TAGS_MAX;
  return (
    <div className="-m-3 flex w-[var(--tag-picker-width)] flex-col gap-1">
      <Field
        ref={inputRef}
        data-autofocus=""
        className="w-full"
        value={query}
        placeholder={t('tags.find')}
        aria-label={t('tags.find')}
        maxLength={80}
        onChange={(event) => {
          setQuery(event.target.value);
          setProblem(null);
        }}
        onKeyDown={onInputKeyDown}
      />
      <div
        ref={listRef}
        role="group"
        aria-label={t('tags.title')}
        onKeyDown={onListKeyDown}
        className="flex max-h-60 flex-col overflow-y-auto"
      >
        {shown.map((tag) => {
          const checked = state(tag.name);
          const blocked = full(tag.name);
          return (
            <button
              key={tag.name}
              type="button"
              role="checkbox"
              data-tag-item=""
              aria-checked={checked === 'some' ? 'mixed' : checked === 'all'}
              aria-disabled={blocked ? true : undefined}
              className={ITEM}
              onClick={() => toggle(tag.name)}
            >
              <TagDot color={tag.color} />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
              <Icon icon={Check} className={cx(checked === 'none' && 'invisible')} />
            </button>
          );
        })}
        {canCreate && (
          <button
            type="button"
            data-tag-item=""
            className={ITEM}
            aria-disabled={limitReached ? true : undefined}
            onClick={() => void create()}
          >
            <span className="min-w-0 flex-1 truncate">{t('tags.create', { name: text })}</span>
          </button>
        )}
      </div>
      {(problem === 'limit' || (canCreate && limitReached)) && (
        <p role="status" className="t-caption m-0 px-2">
          {t('tags.limit')}
        </p>
      )}
      {problem === 'duplicate' && (
        <p role="status" className="t-caption m-0 px-2">
          {t('tags.duplicate')}
        </p>
      )}
      <div role="separator" className="my-1 h-px bg-divider" />
      <button type="button" data-tag-item="" className={ITEM} onClick={() => setManaging(true)}>
        {t('tags.manage')}
      </button>
    </div>
  );
}

export interface TagPickerButtonProps {
  docId: number;
  annotIds: readonly number[];
  /** `sm` 28 (the default; bubbles, cards) or `md` 36 (the mini bar). */
  size?: IconButtonSize;
}

/**
 * The Tags icon button (DESIGN 3.7 C6) and the picker it opens. Toggling a tag applies at once as one undo step. Disabled, with the read-only
 * tooltip, on a document that cannot be edited.
 */
export function TagPickerButton({ docId, annotIds, size = 'sm' }: TagPickerButtonProps) {
  const t = useT();
  const welcome = useDocuments((state) => state.byId[docId]?.kind === 'welcome');
  const locked = useSignatureLock(docId).locked;
  const readOnly = welcome || locked;
  const disabled = readOnly || annotIds.length === 0;
  return (
    <Popover
      label={t('tags.assign')}
      side="bottom"
      align="start"
      disabled={disabled}
      trigger={(trigger) => (
        <IconButton
          {...trigger}
          size={size}
          icon={Tag}
          label={t('tags.assign')}
          hint={locked ? t('cert.locked.tool') : readOnly ? t('tool.readOnly') : undefined}
          disabled={disabled}
          focusableWhenDisabled
          tooltipSide="bottom"
        />
      )}
    >
      <PickerBody docId={docId} annotIds={annotIds} />
    </Popover>
  );
}
