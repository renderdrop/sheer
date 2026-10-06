import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { MAX_LINE_CHARS } from '../../api/textEdit';
import type { Rect } from '../../api/wire';
import { runAction } from '../../actions/dispatch';
import { useT } from '../../i18n';
import { subscribeViewRect } from '../viewer/scrollBridge';
import { cancelEdit, commitAndClose, commitEdit, stepEdit, takeCaret, type Caret } from './actions';
import { editKeyOf } from './keyboard';
import { distinctChars, familyFor, overflowOf, textSpan, type Growth } from './lines';
import { useTextEdit, type EditSession } from './store';

/** One CSS px, in page space (the layer is scaled by `--page-scale`). */
const px = (n: number) => `calc(${n}px / var(--page-scale, 1))`;
/** Hit-free chrome: the page-space children never take the pointer, except the box itself. */
const CHROME: CSSProperties = { position: 'absolute', pointerEvents: 'none' };
/** What the box keeps out of the commit-on-outside-click: the box, the layers' surfaces, the mini bar and what it opens. */
const KEEP = '[data-textedit-box], [data-textedit-surface], [data-surface="textedit-bar"], [data-protect]';

const clientRect = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** Puts the caret in `el`: at the end, or at the glyph boundary nearest to a client point. */
function placeCaret(el: HTMLElement, caret: Caret): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  if (caret !== 'end') {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    const position = doc.caretPositionFromPoint?.(caret.x, caret.y);
    if (position != null) {
      node = position.offsetNode;
      offset = position.offset;
    } else {
      const hit = doc.caretRangeFromPoint?.(caret.x, caret.y);
      if (hit != null) {
        node = hit.startContainer;
        offset = hit.startOffset;
      }
    }
    if (node !== null && el.contains(node)) {
      range.setStart(node, offset);
      range.collapse(true);
    } else {
      // No caret API (or the point is not on the text): the share of the line's width, at the nearest character.
      const box = el.getBoundingClientRect();
      const text = el.firstChild;
      if (text !== null && box.width > 0) {
        const share = Math.min(1, Math.max(0, (caret.x - box.left) / box.width));
        range.setStart(text, Math.round(share * (text.textContent?.length ?? 0)));
        range.collapse(true);
      }
    }
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

export interface EditBoxProps {
  session: EditSession;
  growth: Growth;
  /** The unrotated page's width in points, for nothing but the hatch (kept for the page edge). */
  pageWidth: number;
}

/**
 * The in-place box of one line (DESIGN 3.10 E1, E2, E6, E8; ADR-128). It draws the draft over a page-coloured mask in the nearest
 * CSS family of the line's font, sized to the line box; Apply renders the real result. In page space (the parent is scaled).
 * Overflow past the limit shows the danger marker and the redaction hatch. The paragraph rule is `aria-hidden`.
 */
export function EditBox({ session, growth, pageWidth }: EditBoxProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const ruleRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const { line, status, draft } = session;
  const busy = status === 'busy';
  const failed = status === 'error';
  const [measured, setMeasured] = useState(line.box.w);
  const family = familyFor(line.font.name);

  // The text goes in once, by hand: React must not re-render children of a contenteditable the user is changing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.textContent = line.text;
    el.focus({ preventScroll: true });
    placeCaret(el, takeCaret());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the box is keyed by its line: this runs once per line
  }, []);

  // After a failed or finished write the text is editable again, and the caret comes back.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      const el = ref.current;
      if (el !== null) {
        el.focus({ preventScroll: true });
        placeCaret(el, 'end');
      }
    }
  }, [busy]);

  // The width of the draft decides the overflow; the box and the rule tell the mini bar where they are on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const width = el.offsetWidth;
    const next = width > 0 ? width : line.box.w;

    setMeasured(next);
    const over = Math.round(overflowOf(growth, next) * 10) / 10;
    if (over !== useTextEdit.getState().session?.overflowPt) useTextEdit.getState().patchSession({ overflowPt: over });
  }, [draft, growth, line.box.w]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const rule = ruleRef.current;
      useTextEdit.getState().set({ anchor: clientRect(el), rule: rule === null ? null : clientRect(rule) });
    };
    measure();
    window.addEventListener('resize', measure);
    const off = subscribeViewRect(measure);
    return () => {
      window.removeEventListener('resize', measure);
      off();
    };
  }, [draft, growth]);

  // A click anywhere else on the canvas (a gap, the grey area) commits; a click on a line is the layer's (it commits and opens).
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(KEEP) !== null) return;
      if (target.closest('[data-action-scope="canvas"]') === null) return;
      void commitEdit();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  const onInput = () => {
    const el = ref.current;
    if (el === null) return;
    let text = el.textContent ?? '';
    const clean = text.replace(/[\r\n]+/g, ' ').slice(0, MAX_LINE_CHARS);
    if (clean !== text) {
      el.textContent = clean;
      placeCaret(el, 'end');
      text = clean;
    }
    const state = useTextEdit.getState();
    state.patchSession({
      draft: text,
      ...(session.fallback === null ? {} : { fallback: { face: session.fallback.face, chars: distinctChars(text) } }),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    switch (editKeyOf(event.nativeEvent)) {
      case 'commit':
        event.preventDefault();
        void commitEdit();
        break;
      case 'cancel':
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
        break;
      case 'next':
      case 'previous': {
        event.preventDefault();
        void stepEdit(event.shiftKey ? -1 : 1);
        break;
      }
      case 'ignore':
        event.preventDefault();
        break;
      case 'undoTyping':
        // The browser undoes the typing in the box; this key never reaches the document's undo while a line is open.
        event.stopPropagation();
        break;
      case 'save':
        event.preventDefault();
        event.stopPropagation();
        void commitAndClose().then((ok) => {
          if (ok) runAction('save');
        });
        break;
      default:
        break;
    }
  };

  const { box } = line;
  const over = session.overflowPt > 0;
  const span = textSpan(growth, box, measured);
  const anchorStyle: CSSProperties =
    growth.align === 'right'
      ? { left: box.x + box.w, transform: 'translateX(-100%)' }
      : growth.align === 'center'
        ? { left: box.x + box.w / 2, transform: 'translateX(-50%)' }
        : { left: box.x };
  const dotted = line.editable.type === 'fallback';
  const rule = growth.rule;

  return (
    <>
      {rule !== null && (
        <div
          ref={ruleRef}
          aria-hidden="true"
          data-textedit-rule=""
          style={{
            ...CHROME,
            left: rule.x,
            top: rule.y,
            width: rule.w,
            height: rule.h,
            background: 'var(--color-stone)',
          }}
        />
      )}
      <div
        ref={ref}
        role="textbox"
        aria-label={t('editText.aria.line', { line: line.key.line + 1, page: session.pageNumber })}
        aria-multiline={false}
        aria-busy={busy || undefined}
        aria-invalid={failed || undefined}
        aria-describedby={hintId}
        contentEditable={busy ? false : 'plaintext-only'}
        suppressContentEditableWarning
        spellCheck={false}
        tabIndex={0}
        data-testid="textedit-box"
        data-textedit-box=""
        className={`bg-page selection:bg-(--color-doc-text-select) ${failed ? 'shadow-none' : 'shadow-(--ring-focus)'}`}
        onInput={onInput}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute',
          ...anchorStyle,
          top: box.y,
          minWidth: box.w,
          height: box.h,
          lineHeight: `${box.h}px`,
          fontSize: line.font.size,
          fontFamily: family,
          whiteSpace: 'pre',
          color: 'var(--color-ink)',
          caretColor: busy ? 'transparent' : 'var(--color-ink)',
          // Active: the focus pair; failed: a 2 px danger outline replaces it (DESIGN 3.10 E6).
          outline: failed ? `${px(2)} solid var(--color-danger)` : 'none',

          pointerEvents: 'auto',
          ...(dotted
            ? {
                textDecorationLine: 'underline',
                textDecorationStyle: 'dotted',
                textDecorationColor: 'var(--text-secondary)',
                textUnderlineOffset: 2,
              }
            : {}),
        }}
      />
      {over && (
        <>
          {span.right > growth.right && (
            <>
              <Hatch from={growth.right} to={Math.min(span.right, pageWidth)} box={box} />
              <Marker at={growth.right} box={box} />
            </>
          )}
          {span.left < growth.left && (
            <>
              <Hatch from={span.left} to={growth.left} box={box} />
              <Marker at={growth.left} box={box} />
            </>
          )}
        </>
      )}
      <span id={hintId} className="sr-only">
        {t('editText.announce.start')}
      </span>
    </>
  );
}

/** The part of the draft past the limit sits on the redaction fill. */
function Hatch({ from, to, box }: { from: number; to: number; box: Rect }) {
  return (
    <div
      aria-hidden="true"
      data-textedit-hatch=""
      style={{
        ...CHROME,
        left: from,
        top: box.y,
        width: Math.max(0, to - from),
        height: box.h,
        background: 'var(--color-doc-redact-fill)',
      }}
    />
  );
}

/** The 2 px danger marker at the limit. */
function Marker({ at, box }: { at: number; box: Rect }) {
  return (
    <div
      aria-hidden="true"
      data-textedit-limit=""
      style={{
        ...CHROME,
        left: at,
        top: box.y,
        width: px(2),
        height: box.h,
        background: 'var(--color-danger)',
      }}
    />
  );
}
