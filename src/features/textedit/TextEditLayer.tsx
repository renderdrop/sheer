import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { TextLineInfo } from '../../api/textEdit';
import type { Point, Rect } from '../../api/wire';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { isSignatureLocked, useSignatureLock } from '../lock/useSignatureLock';
import { fileRotationOf } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import {
  normalizeRotation,
  overlayBox,
  swapsSides,
  totalRotation,
  unrotatedSize,
  viewToPage,
} from '../viewer/transform';
import { cancelEdit, commitEdit, openEdit } from './actions';
import { EditBox } from './EditBox';
import { isFocused, useLineFocus, useLineKeys } from './keyboard';
import { growthOf, hitLine, isEditable, useLines } from './lines';
import { useTextEdit } from './store';

const px = (n: number) => `calc(${n}px / var(--page-scale, 1))`;

/** A line's outline: hover (1 px Stone, 2 pt off), refused (dashed), keyboard focus (Ink and Solar pair). */
function outlineStyle(line: TextLineInfo, kind: 'hover' | 'refused' | 'focus'): CSSProperties {
  const { box } = line;
  return {
    position: 'absolute',
    pointerEvents: 'none',
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    ...(kind === 'focus'
      ? {}
      : {
          outline: `${px(1)} ${kind === 'refused' ? 'dashed' : 'solid'} var(--color-stone)`,
          outlineOffset: 2,
        }),
  };
}

/**
 * Canvas layer of "Edit text" (layer 3, DESIGN 3.10 E1 to E8): while the tool is active it takes the pointer to outline the line under
 * it, open it on a click and show why a refused line is. The open line is an `EditBox`. Nothing renders outside the tool, or before
 * the page's own rotation is known. A tool switch commits the line.
 */
export const TextEditLayer = memo(function TextEditLayer(props: PageLayerProps) {
  const tool = useUi((s) => s.activeTool);
  const here = useTextEdit(
    (s) => s.session !== null && s.session.docId === props.docId && s.session.pageId === props.pageIndex,
  );
  const open = useDocuments((s) => s.byId[props.docId] !== undefined);
  useLineKeys();

  // Switching the tool or mode commits (Esc is the box's own); a document that went away takes its edit with it.
  useEffect(() => {
    if (here && tool !== 'editText') void commitEdit();
  }, [here, tool]);
  useEffect(() => {
    if (here && !open) cancelEdit();
  }, [here, open]);

  if (!props.ready || (tool !== 'editText' && !here)) return null;
  return <ReadyLayer {...props} active={tool === 'editText'} />;
});

function ReadyLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  active,
}: PageLayerProps & { active: boolean }) {
  const locked = useSignatureLock(docId).locked;
  const session = useTextEdit((s) =>
    s.session !== null && s.session.docId === docId && s.session.pageId === pageIndex ? s.session : null,
  );
  const lines = useLines(docId, pageIndex, active || session !== null);
  const focus = useLineFocus((s) => s.focus);
  const [hover, setHover] = useState<TextLineInfo | null>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = useMemo(() => unrotatedSize([widthPt, heightPt], file), [widthPt, heightPt, file]);
  const total = totalRotation(file, rotation);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;
  const viewW = swapsSides(total) ? page[1] : page[0];
  const viewH = swapsSides(total) ? page[0] : page[1];
  const style = {
    ...overlayBox(boxWidth, boxHeight, page, pxPerPt, total),
    transformOrigin: 'center',
    '--page-scale': pxPerPt,
  } as CSSProperties;

  const toPage = useCallback(
    (event: { clientX: number; clientY: number }): Point | null => {
      const element = surface.current;
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const view = {
        x: ((event.clientX - rect.left) / rect.width) * viewW,
        y: ((event.clientY - rect.top) / rect.height) * viewH,
      };
      return viewToPage(view, page, total);
    },
    [page, total, viewW, viewH],
  );

  const lineAt = (event: { clientX: number; clientY: number }): TextLineInfo | null => {
    const at = toPage(event);
    return at === null || lines === null ? null : hitLine(lines, at, pxPerPt);
  };

  // The hover outline of a refused line is also its tooltip's anchor; leaving or switching clears it.
  const refused = hover !== null && !isEditable(hover);
  useLayoutEffect(() => {
    const store = useTextEdit.getState();
    const current = store.refusal;
    if (hover !== null && hover.editable.type === 'no' && hoverRef.current !== null) {
      const r = hoverRef.current.getBoundingClientRect();
      const rect: Rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      if (current?.via === 'click' && current.reason === hover.editable.reason) return;
      store.set({ refusal: { reason: hover.editable.reason, rect, via: 'hover' } });
    } else if (current !== null && current.via === 'hover') {
      store.set({ refusal: null });
    }
  }, [hover]);
  useEffect(
    () => () => {
      if (useTextEdit.getState().refusal?.via === 'hover') useTextEdit.getState().set({ refusal: null });
    },
    [],
  );

  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const next = lineAt(event);
    setHover((prev) => (prev?.key.line === next?.key.line && prev?.key.rev === next?.key.rev ? prev : next));
  };

  const onDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // The box takes the focus itself once it is open; the page must not take it back.
    event.preventDefault();
    useLineFocus.getState().set(null);
    const line = lineAt(event);
    const store = useTextEdit.getState();
    if (line !== null && isEditable(line)) {
      void openEdit({ docId, pageId: pageIndex, line, caret: { x: event.clientX, y: event.clientY } });
      return;
    }
    if (store.session !== null) void commitEdit();
    if (line !== null && line.editable.type === 'no') {
      const r = hoverRef.current?.getBoundingClientRect();
      store.set({
        refusal: {
          reason: line.editable.reason,
          rect:
            r === undefined
              ? { x: event.clientX, y: event.clientY, w: 0, h: 0 }
              : { x: r.left, y: r.top, w: r.width, h: r.height },
          via: 'click',
        },
      });
      return;
    }
    if (line === null && lines !== null && !lines.some(isEditable)) {
      store.set({
        refusal: { reason: 'noText', rect: { x: event.clientX, y: event.clientY, w: 0, h: 0 }, via: 'click' },
      });
    } else if (store.refusal !== null) {
      store.set({ refusal: null });
    }
  };

  const growth = useMemo(
    () => (session === null ? null : growthOf(lines ?? [session.line], session.line, page[0])),
    [lines, session, page],
  );

  const hovered = hover !== null && !(session !== null && session.line.key.line === hover.key.line) ? hover : null;
  const focused =
    session === null && lines !== null ? (lines.find((l) => isFocused(focus, docId, pageIndex, l.key)) ?? null) : null;
  const cursor = hovered === null ? undefined : refused ? 'not-allowed' : 'text';

  return (
    <div data-textedit-layer="" className="pointer-events-none absolute inset-0 z-canvas-annotations">
      {active && !locked && !isSignatureLocked(docId) && (
        <div
          ref={surface}
          data-textedit-surface=""
          className="pointer-events-auto absolute inset-0 select-none"
          style={{ cursor }}
          onMouseDown={onDown}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      )}
      <div aria-hidden={session === null ? true : undefined} className="absolute" style={style}>
        {hovered !== null && (
          <div ref={hoverRef} aria-hidden="true" style={outlineStyle(hovered, refused ? 'refused' : 'hover')} />
        )}
        {focused !== null && (
          <div aria-hidden="true" className="shadow-(--ring-focus)" style={outlineStyle(focused, 'focus')} />
        )}
        {session !== null && growth !== null && (
          <EditBox
            key={`${session.line.key.rev}:${session.line.key.line}`}
            session={session}
            growth={growth}
            pageWidth={page[0]}
          />
        )}
      </div>
    </div>
  );
}
