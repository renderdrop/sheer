import { CircleCheck, CircleX, Ellipsis, ThumbsUp, type LucideIcon } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { MAX_ANNOT_CONTENTS_CHARS, type Annotation } from '../../api/annotations';
import { Button, IconButton, Menu } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useT, type PlainKey } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { pageNumberOf } from '../../stores/pages';
import { useSettings } from '../../stores/settings';
import { isOwnReply, useOwnReplies } from '../annotations/note/ownReplies';
import { useAutosize } from '../annotations/note/useAutosize';
import { rgbToCss } from '../inspector/palette';
import { deleteThread, discardNew, postReply, run, setReviewState } from './actions';
import type { Status, Thread } from './model';
import { useComments } from './store';
import { relativeTime } from './time';
import { isTextMarkup, typeOf } from './typeInfo';
import { useQuote } from './useQuote';

/** The text areas of a card: the look of a Field (DESIGN 3.7) over several lines. */
export const CARD_TEXTAREA =
  'block w-full resize-none rounded-sm border border-control-border bg-transparent px-1 py-0-5 text-md text-text ' +
  'placeholder:text-text-muted disabled:cursor-not-allowed disabled:text-text-disabled';

const STATUS_PILL: Record<Exclude<Status, 'open'>, { key: PlainKey; icon: LucideIcon }> = {
  resolved: { key: 'comments.resolved', icon: CircleCheck },
  accepted: { key: 'comments.accepted', icon: ThumbsUp },
  rejected: { key: 'comments.rejected', icon: CircleX },
};

/** The kinds whose text the user can write and change in a card. */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  'highlight',
  'underline',
  'strikeout',
  'note',
  'ink',
  'rect',
  'ellipse',
  'line',
]);

const COALESCE_REPLY = 'comment.reply';
/** A field grows to this many lines, then scrolls. */
const MAX_LINES = { maxHeight: 'calc(10lh + 2 * var(--spacing-0-5))' } as const;

interface ReplyTextProps {
  docId: number;
  reply: number;
  text: string;
  editable: boolean;
  label: string;
}

/** The text of a reply: read-only, or (the user's own) a textarea that commits on blur as one coalesced step. */
function ReplyText({ docId, reply, text, editable, label }: ReplyTextProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(text);
  }, [text]);
  useAutosize(ref, draft);
  if (!editable) return <p className="m-0 text-md break-words whitespace-pre-wrap">{text}</p>;
  return (
    <textarea
      ref={ref}
      aria-label={label}
      rows={1}
      maxLength={MAX_ANNOT_CONTENTS_CHARS}
      value={draft}
      className={cx(CARD_TEXTAREA, 'overflow-auto')}
      style={MAX_LINES}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        const next = event.target.value;
        if (next !== text && next.trim() !== '') {
          void run(docId, {
            type: 'updateAnnotation',
            id: reply,
            patch: { contents: next },
            coalesce: `${COALESCE_REPLY}.${reply}`,
          });
        } else setDraft(text);
      }}
    />
  );
}

function ReplyItem({ docId, summary, now }: { docId: number; summary: Thread['replies'][number]; now: number }) {
  const t = useT();
  const full: Annotation | undefined = useAnnotations((state) => state.byDoc[docId]?.byId[summary.id]);
  const mine = useOwnReplies((state) => state.byDoc[docId]);
  const ownName = useSettings((state) => state.authorName);
  const author = summary.author ?? t('note.unknownAuthor');
  const own = full !== undefined && !full.locked && isOwnReply(mine, full, ownName);
  return (
    <li className="flex flex-col gap-0-5">
      <div className="flex items-baseline gap-1 text-sm">
        <span className="min-w-0 truncate font-semibold">{author}</span>
        <span className="shrink-0 text-text-muted" title={summary.modified ?? undefined}>
          {relativeTime(summary.modified, t.locale, now)}
        </span>
      </div>
      <ReplyText
        docId={docId}
        reply={summary.id}
        text={full?.contents ?? summary.contents}
        editable={own}
        label={t('note.replyBy', { author })}
      />
    </li>
  );
}

export interface CommentCardProps {
  docId: number;
  thread: Thread;
  /** The card is the canvas selection: it shows its footer. */
  selected: boolean;
  tabStop: boolean;
  /** Now in ms, for the relative times. */
  now: number;
  onActivate: (thread: Thread) => void;
}

/** One comment card (DESIGN 3.59): type, quote, text, author and time, status, replies, and for the selected one the reply footer. */
export const CommentCard = memo(function CommentCard({
  docId,
  thread,
  selected,
  tabStop,
  now,
  onActivate,
}: CommentCardProps) {
  const t = useT();
  const { root, replies, status } = thread;
  const ids = useId();
  const full: Annotation | undefined = useAnnotations((state) => state.byDoc[docId]?.byId[root.id]);
  const editing = useComments((state) => state.editing[docId]);
  const isEditing = editing?.id === root.id;
  const info = typeOf(root);
  const quote = useQuote(docId, root.id, isTextMarkup(root.kind));
  const text = full?.contents ?? root.contents;
  const author = root.author ?? '';
  const collapsed = status !== 'open' && !selected && !isEditing;
  const canEdit = full !== undefined && !full.locked && TEXT_KINDS.has(root.kind);
  const canDelete = root.kind !== 'opaque';

  // The page of a comment is read so that the full text, the replies and the geometry are there when they are needed.
  useEffect(() => {
    void useAnnotations
      .getState()
      .loadPage(docId, root.pageId)
      .catch(() => undefined);
  }, [docId, root.pageId]);

  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  useAutosize(bodyRef, draft);
  // The draft starts from the text when the editing starts.
  const [editFor, setEditFor] = useState<number | null>(null);
  if (isEditing && editFor !== root.id) {
    setEditFor(root.id);
    setDraft(text);
  } else if (!isEditing && editFor !== null) setEditFor(null);
  useEffect(() => {
    if (!isEditing) return;
    // The field takes the focus once, when the editing starts.
    const element = bodyRef.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [isEditing]);
  const canPost = draft.trim() !== '';

  const cancel = () => {
    useComments.getState().stopEdit(docId);
    if (editing?.fresh === true) void discardNew(docId, root.id);
  };
  const post = () => {
    if (!canPost) return;
    useComments.getState().stopEdit(docId);
    if (draft !== text) void run(docId, { type: 'updateAnnotation', id: root.id, patch: { contents: draft } });
  };
  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      post();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  const [reply, setReply] = useState('');
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  useAutosize(replyRef, reply);
  const sendReply = () => {
    const body = reply.trim();
    if (body === '') return;
    setReply('');
    void postReply(docId, root.id, root.pageId, body);
  };

  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('button, textarea, input, a, [role="menu"]') !== null)
      return;
    onActivate(thread);
  };

  const statusPill = status === 'open' ? null : STATUS_PILL[status];
  const time = relativeTime(root.modified, t.locale, now);
  const page = pageNumberOf(docId, root.pageId);
  const review = (next: 'completed' | 'accepted' | 'rejected' | 'none') => () =>
    void setReviewState(docId, root.id, root.pageId, next);
  const copy = () => void navigator.clipboard?.writeText(text).catch(() => undefined);
  const describedBy =
    [quote !== null && quote !== undefined ? `${ids}-q` : null, text !== '' ? `${ids}-b` : null]
      .filter((id) => id !== null)
      .join(' ') || undefined;

  return (
    <article
      data-key={`a${root.id}`}
      data-state={selected ? 'selected' : 'idle'}
      aria-labelledby={`${ids}-h`}
      aria-describedby={describedBy}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabStop ? 0 : -1}
      onClick={onClick}
      className={cx(
        'box-border flex cursor-pointer flex-col gap-1 rounded-panel p-1-5 ring-1 ring-inset focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
        'transition-colors duration-fast motion-reduce:transition-none',
        'forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]',
        selected ? 'bg-selected ring-accent' : 'bg-card ring-divider hover:bg-control-hover',
      )}
    >
      <header className="flex h-control-sm items-center gap-1">
        <span
          aria-hidden="true"
          className="flex size-control-sm shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon"
        >
          <Icon icon={info.icon} size={12} />
        </span>
        <span id={`${ids}-h`} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t(info.key)}
        </span>
        <span className="shrink-0 rounded-pill px-1 text-sm text-text-muted ring-1 ring-divider ring-inset">
          {t('comments.page', { n: page })}
        </span>
        <Menu
          label={t('comments.more')}
          side="bottom"
          align="end"
          entries={[
            {
              id: 'edit',
              label: t('comments.edit'),
              disabled: !canEdit,
              onSelect: () => useComments.getState().startEdit(docId, root.id, false),
            },
            {
              id: 'delete',
              label: t('comments.delete'),
              disabled: !canDelete,
              onSelect: () =>
                void deleteThread(docId, [root.id, ...replies.map((r) => r.id), ...thread.states.map((s) => s.id)]),
            },
            { type: 'separator', id: 'review' },
            {
              id: 'accept',
              label: t('comments.accept'),
              disabled: status === 'accepted',
              onSelect: review('accepted'),
            },
            {
              id: 'reject',
              label: t('comments.reject'),
              disabled: status === 'rejected',
              onSelect: review('rejected'),
            },
            { id: 'reopen', label: t('comments.reopen'), disabled: status === 'open', onSelect: review('none') },
            { type: 'separator', id: 'copy-sep' },
            { id: 'copy', label: t('comments.copyText'), disabled: text === '', onSelect: copy },
          ]}
          trigger={(trigger) => (
            <IconButton {...trigger} size="sm" icon={Ellipsis} label={t('comments.more')} tooltipSide="bottom" />
          )}
        />
      </header>

      {quote !== null && quote !== undefined && (
        <blockquote
          id={`${ids}-q`}
          className={cx(
            'm-0 border-0 border-s-2 border-solid ps-1 text-sm text-text-muted [overflow-wrap:anywhere]',
            collapsed ? 'line-clamp-1' : 'line-clamp-3',
          )}
          style={{ borderInlineStartColor: rgbToCss(root.color) }}
        >
          {t('comments.quote', { text: quote })}
        </blockquote>
      )}

      {!collapsed && (
        <>
          {isEditing ? (
            <textarea
              ref={bodyRef}
              aria-label={t('note.body')}
              placeholder={t('comments.placeholder')}
              rows={1}
              maxLength={MAX_ANNOT_CONTENTS_CHARS}
              value={draft}
              style={{ minHeight: 'calc(2lh + 2 * var(--spacing-0-5))', ...MAX_LINES }}
              className={cx(CARD_TEXTAREA, 'overflow-auto')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onBodyKeyDown}
            />
          ) : (
            text !== '' && (
              <p id={`${ids}-b`} className="m-0 text-md whitespace-pre-wrap [overflow-wrap:anywhere]">
                {text}
              </p>
            )
          )}
          {isEditing ? (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={cancel}>
                {t('comments.cancel')}
              </Button>
              <Button size="sm" variant="primary" disabled={!canPost} focusableWhenDisabled onClick={post}>
                {t('comments.post')}
              </Button>
            </div>
          ) : (
            <div className="flex items-baseline gap-1 text-sm">
              <span className={cx('min-w-0 truncate font-semibold', author === '' && 'text-text-muted')}>
                {author === '' ? t('comments.noAuthor') : author}
              </span>
              {time !== '' && (
                <span className="shrink-0 text-text-muted" title={root.modified ?? undefined}>
                  {time}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {statusPill !== null && (
        <span className="flex w-fit items-center gap-0-5 rounded-pill bg-tile px-1 text-sm text-tile-icon forced-colors:bg-[Canvas] forced-colors:ring-1 forced-colors:ring-[CanvasText]">
          <Icon icon={statusPill.icon} size={12} />
          {t(statusPill.key)}
        </span>
      )}

      {!collapsed && replies.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 border-0 border-t border-solid border-divider p-0 pt-1">
          {replies.map((item) => (
            <ReplyItem key={item.id} docId={docId} summary={item} now={now} />
          ))}
        </ul>
      )}

      {selected && !isEditing && (
        <div className="flex items-end gap-1 border-0 border-t border-solid border-divider pt-1">
          <textarea
            ref={replyRef}
            aria-label={t('note.replyField')}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            placeholder={t('note.replyPlaceholder')}
            rows={1}
            maxLength={MAX_ANNOT_CONTENTS_CHARS}
            value={reply}
            style={MAX_LINES}
            className={cx(CARD_TEXTAREA, 'min-w-0 flex-1 overflow-auto text-sm')}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                sendReply();
              }
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={CircleCheck}
            onClick={review(status === 'open' ? 'completed' : 'none')}
          >
            {status === 'open' ? t('comments.resolve') : t('comments.reopen')}
          </Button>
        </div>
      )}
    </article>
  );
});
