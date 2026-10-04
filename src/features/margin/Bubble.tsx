import { Check, Ellipsis, RotateCcw, User } from 'lucide-react';
import { forwardRef, memo, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { MAX_ANNOT_CONTENTS_CHARS, type AnnotationSummary } from '../../api/annotations';
import { Button, IconButton, Menu } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { pageNumberOf } from '../../stores/pages';
import { isConfirmKey } from '../annotations/note/confirmKey';
import { useAutosize } from '../annotations/note/useAutosize';
import { deleteThread, postReply, run, setReviewState } from '../comments/actions';
import { parseDate, type Thread } from '../comments/model';
import { typeOf } from '../comments/typeInfo';
import { useCommentHover } from '../comments/useCommentsData';
import { bubbleDate, initialOf } from './layout';

/** The body shows this many lines, then "More". */
export const BODY_LINES = 6;
/** A reply field grows to this many lines, then scrolls. */
const REPLY_MAX = { maxHeight: 'calc(4lh + 2 * var(--spacing-1))' } as const;
const FIELD =
  'block w-full resize-none rounded-sm border border-control-border bg-surface-solid px-2 py-1 text-sm text-text ' +
  'placeholder:text-text-muted';

function Avatar({ author, size }: { author: string | null; size: 'md' | 'sm' }) {
  const initial = initialOf(author);
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-pill bg-text font-medium text-surface-solid',
        size === 'md' ? 'size-6 text-xs' : 'size-5 text-xs',
      )}
    >
      {initial === '' ? <Icon icon={User} size={16} /> : initial}
    </span>
  );
}

/** The avatar marker of the compact column (24 px). */
export const Marker = forwardRef<
  HTMLButtonElement,
  { id: number; author: string | null; label: string; selected: boolean; onClick: () => void; onFocus?: () => void }
>(function Marker({ id, author, label, selected, onClick, onFocus }, ref) {
  const initial = initialOf(author);
  return (
    <button
      ref={ref}
      type="button"
      data-marker={id}
      aria-label={label}
      onClick={onClick}
      onFocus={onFocus}
      className={cx(
        'inline-flex size-6 cursor-pointer items-center justify-center rounded-pill border-0 bg-text p-0 text-xs font-medium text-surface-solid',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected && 'outline-2 outline-offset-2 outline-text',
      )}
    >
      {initial === '' ? <Icon icon={User} size={16} /> : initial}
    </button>
  );
});

export interface BubbleProps {
  docId: number;
  thread: Thread;
  selected: boolean;
  tabStop: boolean;
  now: number;
  /** The bubble opened from a marker (compact column): it closes with Esc. */
  onEscape?: () => void;
  onSelect: (thread: Thread) => void;
}

function Reply({
  docId,
  reply,
  now,
  locale,
}: {
  docId: number;
  reply: AnnotationSummary;
  now: number;
  locale: string;
}) {
  const t = useT();
  const full = useAnnotations((state) => state.byDoc[docId]?.byId[reply.id]);
  const author = reply.author ?? t('note.unknownAuthor');
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Avatar author={reply.author} size="sm" />
        <span className="t-label min-w-0 flex-1 truncate text-text">{author}</span>
        <span className="t-caption shrink-0 text-text">{bubbleDate(parseDate(reply.modified), locale, now)}</span>
      </div>
      <p className="t-body m-0 whitespace-pre-wrap text-text [overflow-wrap:break-word]">
        {full?.contents ?? reply.contents}
      </p>
    </li>
  );
}

/**
 * A comment bubble of the margin (DESIGN 3.5 B9, the note paper): Solar, radius lg with a small top-left corner, header with
 * avatar, name, date, resolve and options; the text (6 lines then "More"), the replies and a reply field. Resolved: White, subtle
 * border, 60 %, collapsed to the header and the first line.
 */
export const Bubble = memo(
  forwardRef<HTMLElement, BubbleProps>(function Bubble(
    { docId, thread, selected, tabStop, now, onEscape, onSelect },
    ref,
  ) {
    const t = useT();
    const { root, replies, status } = thread;
    const ids = useId();
    const full = useAnnotations((state) => state.byDoc[docId]?.byId[root.id]);
    const text = full?.contents ?? root.contents;
    const author = root.author ?? '';
    const resolved = status !== 'open';
    const [expanded, setExpanded] = useState(false);
    const [more, setMore] = useState(false);
    const collapsed = resolved && !selected && !expanded;
    const info = typeOf(root);
    const page = pageNumberOf(docId, root.pageId);
    const hovered = useCommentHover((state) => state.hovered === root.id);

    // Editing the text in place.
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(text);
    const editRef = useRef<HTMLTextAreaElement | null>(null);
    useAutosize(editRef, draft);
    useEffect(() => {
      if (!editing) return;
      const element = editRef.current;
      element?.focus();
      element?.setSelectionRange(element.value.length, element.value.length);
    }, [editing]);
    const canEdit = full !== undefined && !full.locked;
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (next !== '' && next !== text)
        void run(docId, { type: 'updateAnnotation', id: root.id, patch: { contents: next } });
    };

    // The reply field.
    const [reply, setReply] = useState('');
    const replyRef = useRef<HTMLTextAreaElement | null>(null);
    useAutosize(replyRef, reply);
    const sendReply = () => {
      const body = reply.trim();
      if (body === '') return;
      setReply('');
      void postReply(docId, root.id, root.pageId, body);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) {
        if (event.key === 'Escape' && onEscape !== undefined) {
          event.stopPropagation();
          onEscape();
        }
        return;
      }
      if (event.key === 'Enter') {
        // Enter expands the bubble and goes to its reply field.
        event.preventDefault();
        setExpanded(true);
        setMore(true);
        onSelect(thread);
        window.requestAnimationFrame(() => replyRef.current?.focus());
      } else if (event.key === 'Escape' && onEscape !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
    };

    const long = text.split('\n').length > BODY_LINES || text.length > 240;
    const name = author === '' ? t('margin.noAuthor') : author;
    const date = bubbleDate(parseDate(root.modified), t.locale, now);

    return (
      <article
        ref={ref}
        data-bubble={root.id}
        lang={t.locale}
        aria-label={t('margin.bubble', { type: t(info.key), author: name, n: page })}
        aria-current={selected ? 'true' : undefined}
        tabIndex={tabStop ? 0 : -1}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('button, textarea, input, a, [role="menu"]') !== null
          )
            return;
          onSelect(thread);
        }}
        onPointerEnter={() => useCommentHover.getState().hover(root.id)}
        onPointerLeave={() => useCommentHover.getState().hover(null)}
        className={cx(
          'box-border flex w-full cursor-pointer flex-col gap-2 rounded-lg rounded-tl-sm p-3 text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          'transition-shadow duration-fast motion-reduce:transition-none',
          resolved ? 'border border-border-subtle bg-(--note-bubble-resolved) opacity-60' : 'bg-(--note-bubble)',
          selected ? 'shadow-floating ring-1 ring-text' : 'shadow-standard',
          hovered && !selected && 'shadow-floating',
          'forced-colors:border forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]',
        )}
      >
        <header className="flex h-6 items-center gap-2">
          <Avatar author={root.author} size="md" />
          <span id={`${ids}-n`} className="t-label min-w-0 flex-1 truncate text-text">
            {name}
          </span>
          <span className="t-caption shrink-0 text-text" title={root.modified ?? undefined}>
            {date}
          </span>
          <IconButton
            size="sm"
            icon={resolved ? RotateCcw : Check}
            label={resolved ? t('comments.reopen') : t('comments.resolve')}
            tooltipSide="bottom"
            onClick={() => void setReviewState(docId, root.id, root.pageId, resolved ? 'none' : 'completed')}
          />
          <Menu
            label={t('comments.more')}
            side="bottom"
            align="end"
            entries={[
              {
                id: 'edit',
                label: t('comments.edit'),
                disabled: !canEdit,
                onSelect: () => {
                  setDraft(text);
                  setEditing(true);
                },
              },
              {
                id: 'delete',
                label: t('comments.delete'),
                disabled: root.kind === 'opaque',
                onSelect: () =>
                  void deleteThread(docId, [root.id, ...replies.map((r) => r.id), ...thread.states.map((s) => s.id)]),
              },
            ]}
            trigger={(trigger) => (
              <IconButton {...trigger} size="sm" icon={Ellipsis} label={t('comments.more')} tooltipSide="bottom" />
            )}
          />
        </header>

        {editing ? (
          <textarea
            ref={editRef}
            aria-label={t('note.body')}
            rows={1}
            maxLength={MAX_ANNOT_CONTENTS_CHARS}
            value={draft}
            className={cx(FIELD, 'overflow-auto')}
            style={REPLY_MAX}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (isConfirmKey(event)) {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
        ) : (
          text !== '' && (
            <>
              <p
                className={cx(
                  't-body m-0 whitespace-pre-wrap text-text [overflow-wrap:break-word]',
                  collapsed ? 'line-clamp-1' : !more && 'line-clamp-6',
                )}
              >
                {text}
              </p>
              {!collapsed && long && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  aria-expanded={more}
                  onClick={() => setMore(!more)}
                >
                  {more ? t('comment.less') : t('comment.more')}
                </Button>
              )}
            </>
          )
        )}

        {!collapsed && replies.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 border-0 border-t border-solid border-text/12 p-0 pt-2">
            {replies.map((item) => (
              <Reply key={item.id} docId={docId} reply={item} now={now} locale={t.locale} />
            ))}
          </ul>
        )}

        {!collapsed && (
          <textarea
            ref={replyRef}
            aria-label={t('note.replyField')}
            aria-keyshortcuts="Enter"
            placeholder={t('note.replyPlaceholder')}
            rows={1}
            maxLength={MAX_ANNOT_CONTENTS_CHARS}
            value={reply}
            className={cx(FIELD, 'h-8 overflow-auto')}
            style={REPLY_MAX}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (isConfirmKey(event)) {
                event.preventDefault();
                sendReply();
              }
            }}
          />
        )}
      </article>
    );
  }),
);
