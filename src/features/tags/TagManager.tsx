import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { TAGS_MAX, TAG_NAME_MAX, TAG_PALETTE, type TagDef } from '../../api/cite';
import { Button, IconButton, Menu } from '../../components';
import { useT } from '../../i18n';
import { TAG_COLOURS, TagDot, paletteIndex } from './palette';
import {
  createTag,
  currentTags,
  deleteTag,
  nextTagColor,
  recolorTag,
  renameTag,
  tagNameProblem,
  useTagUsage,
  useTags,
  type TagProblem,
} from './store';

const NAME_INPUT =
  'h-control-md min-w-0 flex-1 rounded-button border border-transparent bg-transparent px-2 text-md text-text ' +
  'hover:border-border-subtle hover:border-b-control-border focus:border-border-subtle focus:border-b-control-border ' +
  'focus:bg-surface aria-invalid:border-error-icon';

const PROBLEM_KEY = {
  duplicate: 'tags.duplicate',
  limit: 'tags.limit',
} as const;

function problemText(problem: TagProblem | null, t: ReturnType<typeof useT>): string | null {
  if (problem === 'duplicate') return t(PROBLEM_KEY.duplicate);
  if (problem === 'limit') return t(PROBLEM_KEY.limit);
  return null;
}

interface RowProps {
  tag: TagDef;
  count: number;
  /** A just-added row takes the focus in its name. */
  autoFocus: boolean;
  onProblem: (problem: TagProblem | null) => void;
}

/** One row (DESIGN 3.7 C6): colour menu, name input, usage count, delete. An empty name on blur reverts. */
function Row({ tag, count, autoFocus, onProblem }: RowProps) {
  const t = useT();
  const [draft, setDraft] = useState(tag.name);
  const ref = useRef<HTMLInputElement | null>(null);
  // A rename that comes from outside (or a revert) shows in the field.
  const [seen, setSeen] = useState(tag.name);
  if (seen !== tag.name) {
    setSeen(tag.name);
    setDraft(tag.name);
  }
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);

  const problem = draft.trim() === tag.name ? null : tagNameProblem(draft, currentTags(), tag.name);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === tag.name) return onProblem(null);
    if (trimmed === '' || problem !== null) {
      setDraft(tag.name);
      return;
    }
    void renameTag(tag.name, trimmed).then((result) => {
      if (!result.ok) setDraft(tag.name);
      onProblem(result.ok ? null : result.problem);
    });
  };

  return (
    <li className="flex h-control-md items-center gap-1">
      <Menu
        label={t('tags.colour')}
        side="bottom"
        align="start"
        entries={TAG_PALETTE.map((color, i) => ({
          id: `colour-${i}`,
          label: t((TAG_COLOURS[i] as (typeof TAG_COLOURS)[number]).name),
          leading: <TagDot color={color} />,
          checked: paletteIndex(tag.color) === i,
          radio: true,
          onSelect: () => void recolorTag(tag.name, color),
        }))}
        trigger={(trigger) => (
          <button
            {...trigger}
            type="button"
            aria-label={`${t('tags.colour')}: ${tag.name}`}
            className="group flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-pill hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus"
          >
            <TagDot color={tag.color} />
          </button>
        )}
      />
      <input
        ref={ref}
        value={draft}
        aria-label={t('tags.name')}
        aria-invalid={problem === 'duplicate' ? true : undefined}
        maxLength={TAG_NAME_MAX * 2}
        className={NAME_INPUT}
        onChange={(event) => {
          setDraft(event.target.value);
          onProblem(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape' && draft !== tag.name) {
            // The first Esc takes the edit back; the popover closes with the next one.
            event.stopPropagation();
            setDraft(tag.name);
            onProblem(null);
          }
        }}
      />
      <span className="t-caption min-w-5 text-end tabular-nums" aria-label={String(count)}>
        {count}
      </span>
      <IconButton
        size="sm"
        icon={Trash2}
        label={`${t('tags.delete')}: ${tag.name}`}
        tooltipSide="bottom"
        onClick={() => void deleteTag(tag.name)}
      />
    </li>
  );
}

/**
 * The tag manager (DESIGN 3.7 C6): rename, recolour, delete (with Undo, in the toast) and add tags. It replaces its opener in the same popover
 * (Esc closes it). `docId` is the document whose usage counts show.
 */
export function TagManager({ docId }: { docId?: number }) {
  const t = useT();
  const tags = useTags();
  const usage = useTagUsage(docId);
  const [fresh, setFresh] = useState<string | null>(null);
  const [problem, setProblem] = useState<TagProblem | null>(null);
  const full = tags.length >= TAGS_MAX;

  const add = async () => {
    // A name that is free: "New tag", "New tag 2", ...
    const base = t('tags.new');
    let name = base;
    for (let n = 2; tagNameProblem(name, currentTags()) === 'duplicate'; n += 1) name = `${base} ${n}`;
    const result = await createTag(name, nextTagColor(currentTags()));
    if (result.ok) {
      setFresh(result.name);
      setProblem(null);
    } else setProblem(result.problem);
  };

  const message = problemText(problem, t) ?? (full ? t('tags.limit') : null);
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex items-center gap-1">
        <h2 className="t-title m-0">{t('tags.title')}</h2>
      </div>
      {tags.length === 0 ? (
        <p className="t-caption m-0">{t('tags.empty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {tags.map((tag) => (
            <Row
              key={tag.name}
              tag={tag}
              count={usage.get(tag.name.toLowerCase()) ?? 0}
              autoFocus={fresh === tag.name}
              onProblem={setProblem}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" icon={Plus} disabled={full} onClick={() => void add()}>
          {t('tags.new')}
        </Button>
        {message !== null && (
          <span role="status" className="t-caption">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
