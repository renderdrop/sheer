import { Copy, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { MAX_ANNOT_CONTENTS_CHARS, type Annotation, type DocCommand } from '../../../api/annotations';
import { toAppError } from '../../../api/errors';
import { Button, IconButton, Popover } from '../../../components';
import { cx } from '../../../components/cx';
import { useT } from '../../../i18n';
import { useAnnotations } from '../../../stores/annotations';
import { isOwnReply, markOwnReply, useOwnReplies } from './ownReplies';
import { useSettings } from '../../../stores/settings';
import { useUi } from '../../../stores/ui';
import { formatAnnotationDate } from './date';
import { isConfirmKey } from './confirmKey';
import { useAutosize } from './useAutosize';

/** The step label the model gives a create; a new note that is closed empty takes it back with Undo instead of adding a delete. */
const LABEL_CREATE = 'annotation.create';
const COALESCE_BODY = 'note.contents';

/** Text areas of the popover: Field styles, 3 to 10 lines (DESIGN 3.25), then they scroll. */
const TEXTAREA =
  'block w-full resize-none rounded-sm border border-control-border bg-transparent px-2 py-1 text-md text-text ' +
  'placeholder:text-text-muted disabled:cursor-not-allowed disabled:text-text-disabled';

/** Reports a failed command in the banner (errors never toast) and resolves either way. */
async function run(docId: number, command: DocCommand): Promise<boolean> {
  try {
    await useAnnotations.getState().apply(docId, command);
    return true;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return false;
  }
}

/** Hands the popover an anchor that lives elsewhere (the note's icon on the page); focus returns to it on close. */
function AnchorAttach({
  attach,
  anchor,
}: {
  attach: (element: HTMLElement | null) => void;
  anchor: HTMLElement | null;
}): null {
  useLayoutEffect(() => {
    attach(anchor);
  }, [attach, anchor]);
  return null;
}

interface TextPartProps {
  docId: number;
  annotation: Annotation;
  /** Whether the user may change this text. */
  editable: boolean;
  label: string;
  autoFocus?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Called with the pending text whenever it changes, and with `null` once it is committed, so the popover can flush it on close. */
  onDraft?: (text: string | null) => void;
  /** Enter (without Shift, outside an IME composition) confirms the field; without it the field blurs, which commits. */
  onConfirm?: () => void;
}

/**
 * The text of a note or reply as a textarea (plain text, a text node only). The change commits on blur and when the popover closes
 * (`flush` of the parent), as one update that coalesces with the ones before it into one undo step.
 */
function TextPart({
  docId,
  annotation,
  editable,
  label,
  autoFocus = false,
  textareaRef,
  onDraft,
  onConfirm,
}: TextPartProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? own;
  const [draft, setDraft] = useState(annotation.contents);
  const contents = annotation.contents;
  // The text changed from outside (Undo, Redo): show it, unless the user is typing.
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(contents);
  }, [contents, ref]);
  useAutosize(ref, draft);

  const commit = useCallback(
    (text: string) => {
      if (text !== annotation.contents) {
        void run(docId, {
          type: 'updateAnnotation',
          id: annotation.id,
          patch: { contents: text },
          coalesce: COALESCE_BODY,
        });
      }
    },
    [docId, annotation.id, annotation.contents],
  );

  return (
    <textarea
      ref={ref}
      aria-label={label}
      readOnly={!editable}
      data-autofocus={autoFocus ? '' : undefined}
      maxLength={MAX_ANNOT_CONTENTS_CHARS}
      value={draft}
      rows={1}
      // Three to ten lines of the text size.
      style={{ minHeight: 'calc(3lh + 2 * var(--spacing-1))', maxHeight: 'calc(10lh + 2 * var(--spacing-1))' }}
      className={cx(TEXTAREA, 'overflow-auto', !editable && 'cursor-default border-transparent px-0')}
      onChange={(event) => {
        setDraft(event.target.value);
        onDraft?.(event.target.value);
      }}
      onKeyDown={(event) => {
        if (!editable || !isConfirmKey(event)) return;
        event.preventDefault();
        if (onConfirm !== undefined) onConfirm();
        else event.currentTarget.blur();
      }}
      onBlur={(event) => {
        if (!editable) return;
        commit(event.target.value);
        onDraft?.(null);
      }}
    />
  );
}

function Reply({ docId, reply, own }: { docId: number; reply: Annotation; own: boolean }) {
  const t = useT();
  const author = reply.author ?? t('note.unknownAuthor');
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 truncate font-semibold">{author}</span>
        <span className="shrink-0 text-text-muted">{formatAnnotationDate(reply.modified, t.locale)}</span>
      </div>
      <TextPart docId={docId} annotation={reply} editable={own} label={t('note.replyBy', { author })} />
    </li>
  );
}

export interface NotePopoverProps {
  docId: number;
  /** The note whose popover this is. */
  noteId: number;
  /** The note's icon on the page: the popover opens right-start of it and focus returns to it. */
  anchor: HTMLElement | null;
  open: boolean;
  /** Called once the popover has closed (Esc, outside click, the close button, Delete). */
  onClose: () => void;
  /** The note was just created: focus goes to the body, and closing it empty removes it. */
  isNew?: boolean;
}

/**
 * The sticky-note popover (DESIGN 3.25): author and date, the note's text, its replies (`/IRT`) and a reply field. The body commits on
 * blur or close as one coalesced undo step. A new note closed empty is taken back (Undo of its creation, so no step is left).
 * Enter confirms (the body closes the popover, a reply is posted), Shift+Enter is a line break.
 */
export function NotePopover({ docId, noteId, anchor, open, onClose, isNew = false }: NotePopoverProps) {
  const t = useT();
  const note = useAnnotations((state) => state.byDoc[docId]?.byId[noteId]);
  const byId = useAnnotations((state) => state.byDoc[docId]?.byId);
  const ownName = useSettings((state) => state.authorName);
  const ownReplies = useOwnReplies((state) => state.byDoc[docId]);
  const replies = useMemo(
    () =>
      Object.values(byId ?? {})
        .filter((annotation) => annotation.inReplyTo === noteId)
        .sort((a, b) => a.id - b.id),
    [byId, noteId],
  );
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<string | null>(null);
  const [reply, setReply] = useState('');
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  useAutosize(replyRef, reply);
  const wasOpen = useRef(open);

  /** Writes the body text that was typed and not yet committed. */
  const flush = useCallback(() => {
    const text = pending.current;
    pending.current = null;
    const current = useAnnotations.getState().byDoc[docId]?.byId[noteId];
    if (text !== null && current !== undefined && text !== current.contents) {
      void run(docId, {
        type: 'updateAnnotation',
        id: noteId,
        patch: { contents: text },
        coalesce: COALESCE_BODY,
      });
    }
  }, [docId, noteId]);

  /** A new note that ends up empty and without replies is removed again, without an undo step of its own. */
  const settle = useCallback(
    async (typed: string | null) => {
      const state = useAnnotations.getState();
      const doc = state.byDoc[docId];
      const current = doc?.byId[noteId];
      if (!isNew || current === undefined || doc === undefined) return;
      const text = typed ?? current.contents;
      const hasReplies = Object.values(doc.byId).some((annotation) => annotation.inReplyTo === noteId);
      if (text.trim() !== '' || hasReplies) return;
      if (doc.history.canUndo && doc.history.undoLabel === LABEL_CREATE) {
        try {
          await state.undo(docId);
        } catch (caught) {
          useUi.getState().showBanner(toAppError(caught));
        }
      } else {
        await run(docId, { type: 'deleteAnnotations', ids: [noteId] });
      }
    },
    [docId, noteId, isNew],
  );

  /** The end of the popover: the typed text is written, then a new note that is still empty is taken back. */
  const finish = useCallback(() => {
    const typed = pending.current;
    flush();
    void settle(typed);
  }, [flush, settle]);

  // The parent closed the popover (the anchor scrolled out): the same end as a close from inside.
  useEffect(() => {
    if (wasOpen.current && !open) {
      finish();
    }
    wasOpen.current = open;
  }, [open, finish]);

  // The popover goes away with text still being typed (the page was closed): the text is not lost.
  useEffect(() => flush, [flush]);

  const close = useCallback(() => {
    finish();
    onClose();
  }, [finish, onClose]);

  const remove = () => {
    pending.current = null;
    void run(docId, { type: 'deleteAnnotations', ids: [noteId, ...replies.map((r) => r.id)] });
    onClose();
  };

  const post = () => {
    const text = reply.trim();
    if (text === '' || note === undefined || note.kind !== 'note') return;
    flush();
    setReply('');
    void useAnnotations
      .getState()
      .apply(docId, {
        type: 'createAnnotation',
        draft: {
          kind: 'note',
          pageId: note.pageId,
          at: note.at,
          icon: note.icon,
          color: note.color,
          contents: text,
          author: ownName === '' ? null : ownName,
          inReplyTo: note.id,
        },
      })
      .then(
        (changes) => {
          // The reply belongs to this session's user, whatever the author name becomes later.
          for (const created of changes.upserted) {
            if (created.inReplyTo === note.id && created.contents === text) markOwnReply(docId, created.id);
          }
        },
        (caught: unknown) => useUi.getState().showBanner(toAppError(caught)),
      );
  };

  const onReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isConfirmKey(event)) {
      event.preventDefault();
      post();
    }
  };

  const copy = () => {
    const text = pending.current ?? note?.contents ?? '';
    // The OS clipboard is local; failing to write it (no permission) is not worth a message.
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  if (note === undefined) return null;
  const author = note.author ?? t('note.unknownAuthor');
  const date = formatAnnotationDate(note.modified, t.locale);
  const canPost = reply.trim() !== '';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      label={t('note.label', { author })}
      side="right"
      align="start"
      trigger={(props) => <AnchorAttach attach={props.ref} anchor={anchor} />}
    >
      <div className="flex w-note flex-col gap-2">
        <div className="flex h-control-md items-center gap-2">
          <span className="min-w-0 flex-auto truncate text-md font-semibold" title={author}>
            {author}
          </span>
          <span className="shrink-0 text-sm text-text-muted">{date}</span>
          <IconButton size="sm" icon={Copy} label={t('note.copy')} onClick={copy} />
          <IconButton size="sm" icon={Trash2} label={t('note.delete')} onClick={remove} />
          <IconButton size="sm" icon={X} label={t('note.close')} onClick={() => close()} />
        </div>
        <TextPart
          docId={docId}
          annotation={note}
          editable={!note.locked}
          label={t('note.body')}
          autoFocus={isNew}
          textareaRef={bodyRef}
          onConfirm={() => close()}
          onDraft={(text) => {
            pending.current = text;
          }}
        />
        {replies.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 border-t border-divider p-0 pt-2">
            {replies.map((item) => (
              <Reply
                key={item.id}
                docId={docId}
                reply={item}
                own={isOwnReply(ownReplies, item, ownName) && !item.locked}
              />
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 border-t border-divider pt-2">
          <textarea
            ref={replyRef}
            aria-label={t('note.replyField')}
            placeholder={t('note.replyPlaceholder')}
            rows={1}
            maxLength={MAX_ANNOT_CONTENTS_CHARS}
            value={reply}
            style={{ maxHeight: 'calc(10lh + 2 * var(--spacing-1))' }}
            className={cx(TEXTAREA, 'overflow-auto')}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={onReplyKeyDown}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!canPost}
            focusableWhenDisabled
            className="self-end"
            onClick={() => {
              if (canPost) post();
            }}
          >
            {t('note.reply')}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
