import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { MAX_ANNOT_CONTENTS_CHARS, MAX_FREE_TEXT_LINES, type Annotation } from '../../../api/annotations';
import { toAppError } from '../../../api/errors';
import { useT } from '../../../i18n';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { rgbToCss } from '../../inspector/palette';
import { useAutosize } from './useAutosize';

/** Helvetica is the only face in M2 (ADR-029); the stack names its metric-compatible neighbours for systems without it. */
const HELVETICA = 'Helvetica, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
const LABEL_CREATE = 'annotation.create';

type FreeText = Extract<Annotation, { kind: 'freeText' }>;

export interface FreeTextEditorProps {
  docId: number;
  /** The free text being edited. */
  annotation: FreeText;
  /** Screen pixels per point of the page (zoom × device scale): the box and the font are scaled by it. */
  scale: number;
  /** The annotation was just created by the Text tool: if it is left empty it is taken back without an undo step. */
  isNew?: boolean;
  /** Called after the edit ended (committed, or removed because empty). */
  onDone: () => void;
}

/** The lines of the box as one text, and back. A line break is `\n`; a trailing empty line is a line. */
export function textOf(lines: readonly string[]): string {
  return lines.join('\n');
}

export function linesOf(text: string): string[] {
  return text === '' ? [] : text.split(/\r\n|\r|\n/).slice(0, MAX_FREE_TEXT_LINES);
}

/**
 * The inline editor of a free text (DESIGN 3.25): a textarea in the page's annotation layer exactly over the box (the layer positions
 * this component; it fills the box's rectangle in `scale`d pixels), the font size × zoom, a 1 px dashed `--color-doc-select` outline,
 * the width fixed and the height growing with the text. It takes focus when it appears. Enter is a newline. Esc and a click outside
 * (blur) commit; an empty text removes the annotation. Primary+Z inside is the field's own undo (the shortcuts ignore text fields).
 */
export function FreeTextEditor({ docId, annotation, scale, isNew = false, onDone }: FreeTextEditorProps) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(textOf(annotation.lines));
  const done = useRef(false);
  useAutosize(ref, text);

  // Another annotation in the same editor starts a new edit: it can end (once) again with its own text.
  const editedId = useRef(annotation.id);
  useEffect(() => {
    if (editedId.current === annotation.id) return;
    editedId.current = annotation.id;
    done.current = false;
    setText(textOf(annotation.lines));
  }, [annotation.id, annotation.lines]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    // The caret goes to the end of what is there.
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  // Ends the edit once: writes the text (or takes the annotation back when it is empty).
  const finish = () => {
    if (done.current) return;
    done.current = true;
    const lines = linesOf(text);
    const state = useAnnotations.getState();
    const report = (caught: unknown) => useUi.getState().showBanner(toAppError(caught));
    const settle = async () => {
      try {
        if (text.trim() === '') {
          const history = state.byDoc[docId]?.history;
          if (isNew && history?.canUndo === true && history.undoLabel === LABEL_CREATE) await state.undo(docId);
          else await state.apply(docId, { type: 'deleteAnnotations', ids: [annotation.id] });
        } else if (textOf(lines) !== textOf(annotation.lines)) {
          await state.apply(docId, { type: 'updateAnnotation', id: annotation.id, patch: { lines } });
        }
      } catch (caught) {
        report(caught);
      }
    };
    void settle().finally(onDone);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Commits; the Esc is for this editor, not for the selection or the tool below.
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  };

  const { box } = annotation;
  return (
    <textarea
      ref={ref}
      aria-label={t('freeText.edit')}
      maxLength={MAX_ANNOT_CONTENTS_CHARS}
      value={text}
      rows={1}
      spellCheck
      onChange={(event) => setText(event.target.value)}
      onBlur={finish}
      onKeyDown={onKeyDown}
      // The box in screen pixels; the colour and size are those of the annotation, which are data. The height is at least the box's.
      style={{
        position: 'absolute',
        left: box.x * scale,
        top: box.y * scale,
        width: box.w * scale,
        minHeight: box.h * scale,
        fontFamily: HELVETICA,
        fontSize: annotation.fontSize * scale,
        lineHeight: 'var(--free-text-line-height)',
        color: rgbToCss(annotation.color),
        opacity: annotation.opacity,
      }}
      className="m-0 box-border resize-none overflow-hidden border border-dashed border-doc-select bg-transparent p-0 outline-none"
    />
  );
}
