import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { MAX_ANNOT_CONTENTS_CHARS, MAX_FREE_TEXT_LINES, type Annotation } from '../../../api/annotations';
import { toAppError } from '../../../api/errors';
import { useT } from '../../../i18n';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { rgbToCss } from '../../inspector/palette';
import { FREE_TEXT_LEADING, FREE_TEXT_MIN_WIDTH, FREE_TEXT_PAD, layoutText } from '../create/freeTextLayout';
import { isConfirmKey } from './confirmKey';

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
  /** The page's width in points: the box grows to the right with the text up to what is left of it (DESIGN 3.5 B4). */
  pageWidth?: number;
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
 * The inline editor of a free text (DESIGN 3.5 B4): a textarea in the page's annotation layer exactly over the box (the layer positions
 * this component; it fills the box's rectangle in `scale`d pixels), the font size × zoom, a 1 px dashed `--color-doc-select` outline.
 * A box that was just made by a click hugs its text: it grows to the right up to the maximum width, then wraps and grows downward; an
 * existing box keeps its size unless the text needs more. The alignment, border and fill of the annotation show while typing. It takes
 * focus when it appears. Enter and Esc and a click outside (blur) commit, Shift+Enter breaks the line; an empty text removes the
 * annotation. Primary+Z inside is the field's own undo (the shortcuts ignore text fields).
 */
export function FreeTextEditor({
  docId,
  annotation,
  scale,
  pageWidth = Infinity,
  isNew = false,
  onDone,
}: FreeTextEditorProps) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(textOf(annotation.lines));
  const done = useRef(false);
  // The box as the edit started: growth starts from it (the live annotation's box changes when the mini bar changes something).
  const [start, setStart] = useState(annotation.box);
  // A box a click made is 24 pt wide: it hugs the text. One that was dragged or already existed keeps its size.
  const keep = !(isNew && annotation.box.w <= FREE_TEXT_MIN_WIDTH + 0.01);
  const layout = useMemo(
    () => layoutText(text, annotation.fontSize, start, pageWidth, keep),
    [text, annotation.fontSize, start, pageWidth, keep],
  );

  // Another annotation in the same editor starts a new edit: it can end (once) again with its own text.
  const editedId = useRef(annotation.id);
  useEffect(() => {
    if (editedId.current === annotation.id) return;
    editedId.current = annotation.id;
    done.current = false;
    setText(textOf(annotation.lines));
    setStart(annotation.box);
  }, [annotation.id, annotation.lines, annotation.box]);

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
    // What is stored is what is seen: the lines as they wrap in the box, and the box that holds them.
    const lines = layout.lines.slice(0, MAX_FREE_TEXT_LINES);
    const boxChanged = (['x', 'y', 'w', 'h'] as const).some(
      (key) => Math.abs(layout.box[key] - annotation.box[key]) > 0.01,
    );
    const state = useAnnotations.getState();
    const report = (caught: unknown) => useUi.getState().showBanner(toAppError(caught));
    const settle = async () => {
      try {
        if (text.trim() === '') {
          const history = state.byDoc[docId]?.history;
          if (isNew && history?.canUndo === true && history.undoLabel === LABEL_CREATE) await state.undo(docId);
          else await state.apply(docId, { type: 'deleteAnnotations', ids: [annotation.id] });
        } else if (textOf(lines) !== textOf(annotation.lines) || boxChanged) {
          await state.apply(docId, {
            type: 'updateAnnotation',
            id: annotation.id,
            patch: boxChanged ? { lines, box: layout.box } : { lines },
          });
        }
      } catch (caught) {
        report(caught);
      }
    };
    void settle().finally(onDone);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isConfirmKey(event)) {
      // Enter commits (Shift+Enter breaks the line).
      event.preventDefault();
      event.stopPropagation();
      finish();
      return;
    }
    if (event.key === 'Escape') {
      // Commits; the Esc is for this editor, not for the selection or the tool below.
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  };

  const { box } = layout;
  const border = annotation.borderWidth > 0 ? rgbToCss(annotation.borderColor ?? annotation.color) : null;
  return (
    <textarea
      ref={ref}
      aria-label={t('freeText.edit')}
      maxLength={MAX_ANNOT_CONTENTS_CHARS}
      value={text}
      rows={1}
      spellCheck
      placeholder={t('textComment.placeholder')}
      onChange={(event) => setText(event.target.value)}
      onBlur={finish}
      onKeyDown={onKeyDown}
      // The box in screen pixels; the colours, size, alignment and border are those of the annotation, which are data.
      style={{
        position: 'absolute',
        left: box.x * scale,
        top: box.y * scale,
        width: box.w * scale,
        height: box.h * scale,
        padding: FREE_TEXT_PAD * scale,
        fontFamily: HELVETICA,
        fontSize: annotation.fontSize * scale,
        lineHeight: FREE_TEXT_LEADING,
        textAlign: annotation.align ?? 'left',
        color: rgbToCss(annotation.color),
        // The border sits inside the box as the appearance stream draws it; the dashed outline is the editor's own.
        boxShadow: border === null ? undefined : `inset 0 0 0 ${annotation.borderWidth * scale}px ${border}`,
        // A fill is the box's background. Text that is on the page already: the paper covers the old rendering so it is not seen twice.
        backgroundColor:
          annotation.fill === null ? (isNew ? 'transparent' : 'var(--color-doc-paper)') : rgbToCss(annotation.fill),
        opacity: annotation.opacity,
      }}
      className="m-0 box-border resize-none overflow-hidden border-0 outline-1 -outline-offset-1 outline-dashed outline-doc-select placeholder:text-text-muted"
    />
  );
}
