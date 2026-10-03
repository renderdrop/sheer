import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { MAX_TEXT_BOX_CHARS } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { useAutosize } from '../annotations/note/useAutosize';
import { rgbToCss } from '../inspector/palette';
import { charsetError, createTextBox, deleteObjects, updateObject } from './actions';
import { LINE_HEIGHT } from './geometry';
import { useInsert, type ContentObject, type Editing, type TextBoxObject } from './store';
import { FONT_STACKS } from './view';

export interface TextEditorProps {
  editing: Editing;
  /** The text box being edited; `undefined` for a new one. */
  object: TextBoxObject | undefined;
  /** Called after a new text box was made, with it. */
  onCreated: (object: ContentObject) => void;
}

/**
 * The inline editor of a text box (DESIGN 3.36, as the free text of 3.25): a textarea in page space exactly over the box, the width
 * fixed and the height growing with the text, a dashed outline. Enter is a newline. Esc and a click outside (blur) commit; an empty
 * text removes the box (a new one is never made). A character that WinAnsi lacks keeps the box in editing with `insert.charset`
 * below it. Everything of one edit is one undo step.
 */
export function TextEditor({ editing, object, onCreated }: TextEditorProps) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(object?.text ?? '');
  const [bad, setBad] = useState<string | null>(null);
  const busy = useRef(false);
  const style = useInsert((s) => s.style);
  useAutosize(ref, text);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    // The caret goes to the end of what is there.
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const { docId, pageId, box } = editing;
  const font = object?.font ?? style.font;
  const fontSize = object?.fontSize ?? style.fontSize;
  const color = object?.color ?? style.color;

  const finish = () => {
    if (busy.current) return;
    busy.current = true;
    const stop = () => useInsert.getState().stopEditing();
    const settle = async () => {
      try {
        if (text.trim() === '') {
          if (object !== undefined) await deleteObjects(docId, [object.id]);
        } else if (object === undefined) {
          const created = await createTextBox({ docId, pageId, box, text, font, fontSize, color });
          if (created !== null) onCreated(created);
        } else if (text !== object.text) {
          await updateObject(docId, object.id, { text });
        }
        stop();
      } catch (caught) {
        const error = toAppError(caught);
        const char = charsetError(error);
        if (char !== null) {
          // Stays in editing: the user removes the character.
          setBad(char);
          busy.current = false;
          ref.current?.focus({ preventScroll: true });
          return;
        }
        useUi.getState().showBanner(error);
        stop();
      }
    };
    void settle();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Commits; the Esc is for this editor, not for the selection or the tool below.
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  };

  return (
    <>
      <textarea
        ref={ref}
        data-insert-editor=""
        aria-label={t('insert.textRole')}
        aria-invalid={bad !== null}
        maxLength={MAX_TEXT_BOX_CHARS}
        value={text}
        rows={1}
        spellCheck
        onChange={(event) => {
          setText(event.target.value);
          setBad(null);
        }}
        onBlur={finish}
        onKeyDown={onKeyDown}
        // The box in page space (the layer scales it); colour, face and size are those of the object, which are data.
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.w,
          minHeight: box.h,
          fontFamily: FONT_STACKS[font],
          fontSize,
          lineHeight: LINE_HEIGHT,
          color: rgbToCss(color),
          textAlign: object?.align ?? 'left',
          outline: 'calc(var(--hairline) / var(--page-scale, 1)) dashed var(--color-doc-select)',
          pointerEvents: 'auto',
        }}
        className="m-0 box-border resize-none overflow-hidden border-0 bg-transparent p-0"
      />
      {bad !== null && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            left: box.x,
            top: box.y + box.h + 2,
            width: Math.max(box.w, 200),
            fontSize: 'calc(var(--text-sm) / var(--page-scale, 1))',
            lineHeight: 'calc(var(--text-sm--line-height) / var(--page-scale, 1))',
            color: 'var(--color-error-text)',
          }}
        >
          {t('insert.charset', { char: bad })}
        </div>
      )}
    </>
  );
}
