import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { MAX_LINE_CHARS } from '../../api/textEdit';
import { textEditPreview, type TextPreview } from '../../api/textPreview';
import type { Rect } from '../../api/wire';
import { runAction } from '../../actions/dispatch';
import { useT } from '../../i18n';
import { subscribeViewRect } from '../viewer/scrollBridge';
import {
  canStepParagraph,
  cancelEdit,
  commitAndClose,
  commitEdit,
  stepEdit,
  stepParagraph,
  takeCaret,
  type Caret,
} from './actions';
import { editKeyOf } from './keyboard';
import { distinctChars, familyFor, overflowOf, textSpan, type Growth } from './lines';
import { createPreviewScheduler, inkSpan, previewScale, scaleXFor, type PreviewScheduler } from './preview';
import { useTextEdit, type EditSession } from './store';
import './textedit.css';

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

const HIGHLIGHT = 'sheer-fallback';

interface HighlightRegistry {
  set: (name: string, value: unknown) => void;
  delete: (name: string) => void;
}

/** The Custom Highlight API, where the webview has it (it underlines single characters of a contenteditable). */
function highlights(): HighlightRegistry | null {
  const registry = (globalThis as { CSS?: { highlights?: unknown } }).CSS?.highlights;
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return registry != null && typeof ctor === 'function' ? (registry as HighlightRegistry) : null;
}

/** Marks `chars` of the text node of `el` with the dotted substitute underline; `false` when the API is missing. */
function markChars(el: HTMLElement, chars: readonly string[]): boolean {
  const registry = highlights();
  if (registry === null) return false;
  const Ctor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  const text = el.firstChild;
  const ranges: Range[] = [];
  if (text !== null && chars.length > 0) {
    const set = new Set(chars);
    const value = text.textContent ?? '';
    for (let i = 0; i < value.length; i += 1) {
      if (!set.has(value.charAt(i))) continue;
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      ranges.push(range);
    }
  }
  registry.set(HIGHLIGHT, new Ctor(...ranges));
  return true;
}

export interface EditBoxProps {
  session: EditSession;
  growth: Growth;
  /** The unrotated page's width in points, for nothing but the hatch (kept for the page edge). */
  pageWidth: number;
  /** The boxes of the line's paragraph: what the preview's mask covers with Umbrechen on. Default: the line. */
  paragraph?: readonly Rect[];
  /** Screen pixels per point of the page, for the preview's picture scale. */
  pxPerPt?: number;
}

interface Frame {
  url: string;
  rect: Rect;
  pxPerPt: number;
}

/** The width of the text of `el` in layout pixels (without the page's scale and the box's own `scaleX`). */
function textWidthOf(el: HTMLElement): number | null {
  if (el.firstChild === null || el.offsetWidth <= 0) return null;
  const outer = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const inner = range.getBoundingClientRect();
  const k = outer.width / el.offsetWidth;
  return k > 0 && inner.width > 0 ? inner.width / k : null;
}

/**
 * The in-place box of one line (DESIGN 3.10 E1, E2, E6, E8; ADR-128). It draws the draft over a page-coloured mask in the nearest
 * CSS family of the line's font, sized to the line box; Apply renders the real result. In page space (the parent is scaled).
 * Overflow past the limit shows the danger marker and the redaction hatch. The paragraph rule is `aria-hidden`.
 */
export function EditBox({ session, growth, pageWidth, paragraph, pxPerPt = 1 }: EditBoxProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const ruleRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const { line, status, draft } = session;
  const busy = status === 'busy';
  const failed = status === 'error';
  const [measured, setMeasured] = useState(line.box.w);
  const family = familyFor(line.font.name);
  const reflow = useTextEdit((s) => s.reflow);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [scaleX, setScaleX] = useState(1);
  const imgRef = useRef<HTMLImageElement>(null);
  const latest = useRef({ draft, reflow, pxPerPt });
  const scheduler = useRef<PreviewScheduler | null>(null);
  const first = useRef(true);
  const url = useRef<string | null>(null);

  // The text goes in once, by hand: React must not re-render children of a contenteditable the user is changing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.textContent = line.text;
    el.focus({ preventScroll: true });
    placeCaret(el, takeCaret());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the box is keyed by its line: this runs once per line
  }, []);

  useLayoutEffect(() => {
    latest.current = { draft, reflow, pxPerPt };
  }, [draft, reflow, pxPerPt]);

  // The live preview (ADR-129 section 1): the backend draws the edited line; the box keeps the real text, transparent over it.
  useEffect(() => {
    const onPreview = (p: TextPreview) => {
      if (typeof URL.createObjectURL !== 'function') return;
      const next = URL.createObjectURL(new Blob([p.png as BlobPart], { type: 'image/png' }));
      if (url.current !== null) URL.revokeObjectURL(url.current);
      url.current = next;
      setFrame({ url: next, rect: p.rect, pxPerPt: p.pxPerPt });
      const patch: Partial<EditSession> = { overflowPt: Math.round(p.overflowPt * 10) / 10 };
      if (p.fallback !== null) patch.fallback = p.fallback;
      useTextEdit.getState().patchSession(patch);
    };
    const made = createPreviewScheduler({
      run: (generation) =>
        textEditPreview({
          docId: session.docId,
          pageId: session.pageId,
          key: line.key,
          text: latest.current.draft,
          fit: 'keepStart',
          scope: latest.current.reflow ? 'paragraph' : 'line',
          generation,
          scale: previewScale(latest.current.pxPerPt, window.devicePixelRatio || 1),
        }),
      onPreview,
    });
    scheduler.current = made;
    return () => {
      made.dispose();
      scheduler.current = null;
      if (url.current !== null) URL.revokeObjectURL(url.current);
      url.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one scheduler per open line (the box is keyed by it)
  }, []);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    scheduler.current?.schedule();
  }, [draft, reflow]);

  // Where the picture's glyphs are: the CSS text is stretched to the same width, so caret and selection land on them.
  const onFrameLoad = () => {
    const img = imgRef.current;
    const el = ref.current;
    if (img === null || el === null || frame === null) return;
    let width: number | null = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context !== null && canvas.width > 0 && canvas.height > 0) {
        context.drawImage(img, 0, 0);
        const ink = inkSpan(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (ink !== null) width = (ink.right - ink.left) / frame.pxPerPt;
      }
    } catch {
      width = null;
    }
    const css = textWidthOf(el);
    setScaleX(width === null || css === null ? 1 : scaleXFor(width, css));
  };

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

  // Substitute glyphs carry the dotted mark while editing, once the characters are known (E4).
  const markers = session.fallback?.chars;
  const [perChar, setPerChar] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const done = markers !== undefined && markChars(el, markers);
    setPerChar((old) => (old === done ? old : done));
  }, [markers, draft]);
  useEffect(
    () => () => {
      highlights()?.delete(HIGHLIGHT);
    },
    [],
  );

  // The width of the draft decides the overflow; the box and the rule tell the mini bar where they are on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const width = el.offsetWidth;
    const next = width > 0 ? width : line.box.w;

    setMeasured(next);
    // A preview's own answer replaces the CSS measurement.
    if (frame !== null) return;
    const over = Math.round(overflowOf(growth, next) * 10) / 10;
    if (over !== useTextEdit.getState().session?.overflowPt) useTextEdit.getState().patchSession({ overflowPt: over });
  }, [draft, growth, line.box.w, frame]);

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
    switch (editKeyOf(event.nativeEvent, reflow)) {
      case 'lineUp':
      case 'lineDown': {
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        if (canStepParagraph(direction)) {
          event.preventDefault();
          void stepParagraph(direction);
        }
        break;
      }
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
  const stretch = frame !== null && scaleX !== 1 ? ` scaleX(${scaleX})` : '';
  const masks = reflow && paragraph !== undefined && paragraph.length > 0 ? paragraph : [line.box];
  // Without the highlight API the whole line of a substitute carries the mark.
  const dotted = (line.editable.type === 'fallback' || session.fallback !== null) && !perChar;
  const rule = growth.rule;

  return (
    <>
      {frame !== null &&
        masks.map((m) => (
          <div
            key={`${m.x}:${m.y}`}
            aria-hidden="true"
            data-textedit-mask=""
            className="bg-page"
            style={{ ...CHROME, left: m.x, top: m.y, width: m.w, height: m.h }}
          />
        ))}
      {frame !== null && (
        <img
          ref={imgRef}
          src={frame.url}
          alt=""
          aria-hidden="true"
          data-textedit-preview=""
          draggable={false}
          onLoad={onFrameLoad}
          style={{ ...CHROME, left: frame.rect.x, top: frame.rect.y, width: frame.rect.w, height: frame.rect.h }}
        />
      )}
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
        // Popovers, tips and notices never cover the line being edited (DESIGN 3.10 E4, Q8).
        data-protect=""
        role="textbox"
        aria-label={t('editText.aria.line', { line: line.key.line + 1, page: session.pageNumber })}
        aria-multiline={reflow}
        aria-busy={busy || undefined}
        aria-invalid={failed || undefined}
        aria-describedby={hintId}
        contentEditable={busy ? false : 'plaintext-only'}
        suppressContentEditableWarning
        spellCheck={false}
        tabIndex={0}
        data-testid="textedit-box"
        data-textedit-box=""
        data-align={growth.align}
        className={`${frame === null ? 'bg-page' : 'bg-transparent'} selection:bg-(--color-doc-text-select) ${failed ? 'shadow-none' : 'shadow-(--ring-focus)'}`}
        onInput={onInput}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute',
          ...anchorStyle,
          ...(stretch === ''
            ? {}
            : {
                transform: `${anchorStyle.transform ?? ''}${stretch}`.trim(),
                transformOrigin:
                  growth.align === 'right' ? 'right center' : growth.align === 'center' ? 'center' : 'left center',
              }),
          top: box.y,
          minWidth: box.w,
          height: box.h,
          lineHeight: `${box.h}px`,
          fontSize: line.font.size,
          fontFamily: family,
          whiteSpace: 'pre',
          color: frame === null ? 'var(--color-ink)' : 'transparent',
          caretColor: busy ? 'transparent' : 'var(--color-ink)',
          // Active: the focus pair; failed: a 2 px danger outline replaces it (DESIGN 3.10 E6).
          outline: failed ? `${px(2)} solid var(--color-danger)` : 'none',

          pointerEvents: 'auto',
          ...(dotted
            ? {
                textDecorationLine: 'underline',
                textDecorationStyle: 'dotted',
                textDecorationColor: 'var(--text-secondary)',
                textDecorationThickness: 'var(--hairline)',
                textUnderlineOffset: 'var(--focus-offset)',
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

/**
 * The 2 px danger marker at the limit: the full line height with a small cap at the top and bottom, so it never reads as the caret
 * (a plain 2 px bar at the text position).
 */
function Marker({ at, box }: { at: number; box: Rect }) {
  const cap: CSSProperties = {
    ...CHROME,
    left: px(-3),
    width: px(8),
    height: px(2),
    background: 'var(--color-danger)',
  };
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
    >
      <div data-textedit-limit-cap="" style={{ ...cap, top: px(-1) }} />
      <div data-textedit-limit-cap="" style={{ ...cap, bottom: px(-1) }} />
    </div>
  );
}
