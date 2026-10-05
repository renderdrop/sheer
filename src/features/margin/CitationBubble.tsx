import { Copy, Ellipsis, Quote } from 'lucide-react';
import { forwardRef, memo, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { MAX_ANNOT_CONTENTS_CHARS } from '../../api/annotations';
import { Button, IconButton, Menu } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { pageNumberOf } from '../../stores/pages';
import { isConfirmKey } from '../annotations/note/confirmKey';
import { useAutosize } from '../annotations/note/useAutosize';
import { useBibliography } from '../citations/bibliography';
import { copyCitation } from '../citations/exportActions';
import { useCitationStyle } from '../citations/style';
import { useCitations } from '../citations/store';
import { deleteThread, postReply, run } from '../comments/actions';
import { useCommentHover } from '../comments/useCommentsData';
import { openReferenceDetails } from '../properties/openReference';
import { TagChips } from '../tags/TagChips';
import { TagPickerButton } from '../tags/TagPicker';
import { FIELD, REPLY_MAX, Reply, type BubbleProps } from './Bubble';
import { quoteMarks, referenceIncomplete, shortCitationText } from './citation';

/** The quote shows this many lines, then "More" (DESIGN 3.7 C3). */
export const QUOTE_LINES = 4;

/**
 * A citation bubble of the margin (DESIGN 3.7 C3): White with a subtle border, a `quote` icon and the page label (the PDF's label
 * when the file has them) in the header with Tags, Copy and options; the quote in locale quotation marks (4 lines, then "More"), the
 * short citation in the current style (with "Add reference details" while author or year is missing), the tag chips, then the
 * optional comment and the replies as in B9.
 */
export const CitationBubble = memo(
  forwardRef<HTMLElement, BubbleProps>(function CitationBubble(
    { docId, thread, selected, tabStop, now, onEscape, onSelect },
    ref,
  ) {
    const t = useT();
    const { root, replies } = thread;
    const ids = useId();
    const full = useAnnotations((state) => state.byDoc[docId]?.byId[root.id]);
    const citations = useCitations(docId);
    const info = citations.find((item) => item.id === root.id);
    const { info: bibliography } = useBibliography(docId);
    const [style] = useCitationStyle();
    const hovered = useCommentHover((state) => state.hovered === root.id);

    const locator = info?.locator ?? String(pageNumberOf(docId, root.pageId));
    const quote = info?.quote ?? full?.cite?.quote ?? '';
    const tags = info?.tags ?? full?.tags ?? root.tags ?? [];
    const comment = full?.contents ?? info?.contents ?? root.contents;
    const record = bibliography?.record ?? null;
    const short = record === null ? '' : shortCitationText(record, locator, style, t.locale);
    const incomplete = record !== null && referenceIncomplete(record);
    const page = t('citation.page', { label: locator });
    const canEdit = full !== undefined && !full.locked;

    const [more, setMore] = useState(false);
    const [commentMore, setCommentMore] = useState(false);

    // The comment: edited in place; "Add comment" opens it empty.
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(comment);
    const editRef = useRef<HTMLTextAreaElement | null>(null);
    useAutosize(editRef, draft);
    useEffect(() => {
      if (!editing) return;
      const element = editRef.current;
      element?.focus();
      element?.setSelectionRange(element.value.length, element.value.length);
    }, [editing]);
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (next !== comment.trim())
        void run(docId, { type: 'updateAnnotation', id: root.id, patch: { contents: next } });
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

    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) {
        if (event.key === 'Escape' && onEscape !== undefined) {
          event.stopPropagation();
          onEscape();
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onSelect(thread);
      } else if (event.key === 'Escape' && onEscape !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
    };

    const marks = quoteMarks(t.locale);
    const quoteLong = quote.split('\n').length > QUOTE_LINES || quote.length > 200;
    const commentLong = comment.split('\n').length > 6 || comment.length > 240;

    return (
      <article
        ref={ref}
        data-bubble={root.id}
        data-citation=""
        lang={t.locale}
        aria-label={t('citation.aria', { page })}
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
          'box-border flex w-full cursor-pointer flex-col gap-2 rounded-lg rounded-tl-sm border border-border-subtle bg-surface p-3 text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          'transition-shadow duration-fast motion-reduce:transition-none',
          selected ? 'shadow-floating ring-1 ring-text' : 'shadow-standard',
          hovered && !selected && 'shadow-floating',
          'forced-colors:border forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]',
        )}
      >
        <header className="flex min-h-6 items-center gap-2">
          <Icon icon={Quote} size={16} />
          <span id={`${ids}-n`} className="t-label min-w-0 flex-1 truncate text-text">
            {page}
          </span>
          <TagPickerButton docId={docId} annotIds={[root.id]} />
          <IconButton
            size="sm"
            icon={Copy}
            label={t('citation.copy')}
            tooltipSide="bottom"
            onClick={() => void copyCitation(docId, root.id)}
          />
          <Menu
            label={t('comments.more')}
            side="bottom"
            align="end"
            entries={[
              {
                id: 'comment',
                label: comment === '' ? t('comments.add') : t('comments.edit'),
                disabled: !canEdit,
                onSelect: () => {
                  setDraft(comment);
                  setEditing(true);
                },
              },
              { id: 'reference', label: t('citation.editReference'), onSelect: () => openReferenceDetails(docId) },
              {
                id: 'delete',
                label: t('comments.delete'),
                onSelect: () =>
                  void deleteThread(docId, [root.id, ...replies.map((r) => r.id), ...thread.states.map((s) => s.id)]),
              },
            ]}
            trigger={(trigger) => (
              <IconButton {...trigger} size="sm" icon={Ellipsis} label={t('comments.more')} tooltipSide="bottom" />
            )}
          />
        </header>

        {quote !== '' && (
          <>
            <p
              className={cx(
                't-body m-0 whitespace-pre-wrap text-text [overflow-wrap:break-word]',
                !more && 'line-clamp-4',
              )}
            >
              {marks[0]}
              {quote}
              {marks[1]}
            </p>
            {quoteLong && (
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
        )}

        {short !== '' && <p className="t-caption m-0 text-text-muted">{short}</p>}
        {incomplete && (
          <button
            type="button"
            onClick={() => openReferenceDetails(docId)}
            className="t-caption cursor-pointer self-start border-0 bg-transparent p-0 text-text underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t('citation.addDetails')}
          </button>
        )}

        <TagChips names={[...tags]} />

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
          comment.trim() !== '' && (
            <div className="flex flex-col gap-2 border-0 border-t border-solid border-text/12 pt-2">
              <p
                className={cx(
                  't-body m-0 whitespace-pre-wrap text-text [overflow-wrap:break-word]',
                  !commentMore && 'line-clamp-6',
                )}
              >
                {comment}
              </p>
              {commentLong && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  aria-expanded={commentMore}
                  onClick={() => setCommentMore(!commentMore)}
                >
                  {commentMore ? t('comment.less') : t('comment.more')}
                </Button>
              )}
            </div>
          )
        )}

        {replies.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 border-0 border-t border-solid border-text/12 p-0 pt-2">
            {replies.map((item) => (
              <Reply key={item.id} docId={docId} reply={item} now={now} locale={t.locale} />
            ))}
          </ul>
        )}

        {(replies.length > 0 || selected) && (
          <textarea
            ref={replyRef}
            aria-label={t('note.replyField')}
            aria-keyshortcuts="Enter"
            placeholder={t('note.replyPlaceholder')}
            rows={1}
            maxLength={MAX_ANNOT_CONTENTS_CHARS}
            value={reply}
            className={cx(FIELD, 'h-8 overflow-hidden')}
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
