import { useCallback, useEffect, useRef, useState } from 'react';

import { closeDocument, openDocumentDialog, renderPage, type DocumentInfo } from './api/documents';
import { toAppError, type AppError } from './api/errors';
import {
  CSS_PX_PER_PT,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  formatZoom,
  scaleForZoom,
  stepZoom,
  wheelZoom,
} from './lib/zoom';
import { strings } from './strings';

/** A rendered page and its size in PDF points, so it can be shown at any zoom while a sharper render is in flight. */
interface PageView {
  url: string;
  widthPt: number;
}

/** Coalesces bursts of zoom changes (wheel, held key) into one render request. */
const RENDER_DEBOUNCE_MS = 80;

// Class strings of the spike UI, all from role tokens (src/styles/tokens.css). Primitives I replaces them with components.
// Hover only where enabled (and under (hover: hover), which Tailwind adds); pressed scales through --scale-press, which
// reduced motion turns into 1. Focus rings come from the global :focus-visible rule.
const BUTTON =
  'inline-flex h-control-md min-w-control-md cursor-pointer items-center justify-center rounded-button px-1-5 text-md font-semibold transition-[background-color,scale] enabled:active:scale-(--scale-press) disabled:cursor-not-allowed';
const BUTTON_GHOST =
  'bg-transparent text-text enabled:hover:bg-control-hover enabled:active:bg-control-pressed disabled:text-text-disabled';
const BUTTON_PRIMARY =
  'bg-accent text-on-accent enabled:hover:bg-accent-hover enabled:active:bg-accent-pressed disabled:bg-fill-disabled disabled:text-text-disabled';
/** A toolbar cluster: items 4 px apart, clusters split by a 1 px divider (DESIGN 3.3). */
const GROUP = 'flex items-center gap-0-5 not-first:border-s not-first:border-divider not-first:ps-1';
const EMPTY_CARD = 'glass-1 m-auto flex flex-col items-center gap-2 rounded-card p-4 text-center';

export function App() {
  const [doc, setDoc] = useState<DocumentInfo | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [view, setView] = useState<PageView | null>(null);
  const [opening, setOpening] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const canvasRef = useRef<HTMLElement>(null);
  const docRef = useRef<DocumentInfo | null>(null);
  const openingRef = useRef(false);

  const open = useCallback(async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      const info = await openDocumentDialog();
      if (info === null) return;
      const previous = docRef.current;
      docRef.current = info;
      setDoc(info);
      setPageIndex(0);
      setView(null);
      if (previous !== null) {
        closeDocument(previous.id).catch(() => undefined);
      }
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, []);

  // Render the current page whenever document, page or zoom changes. Stale results are dropped.
  useEffect(() => {
    if (doc === null || doc.pageCount === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const scale = scaleForZoom(zoom, window.devicePixelRatio);
      setRendering(true);
      // Until pages can be reordered (M3) a page id is its position.
      renderPage(doc.id, pageIndex, scale)
        .then((page) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([page.data], { type: 'image/png' }));
          // `page.scale` is lower than `scale` only if the backend refused the full-size frame.
          setView({ url, widthPt: page.width / page.scale });
          setError(null);
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(toAppError(caught));
        })
        .finally(() => {
          if (!cancelled) setRendering(false);
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [doc, pageIndex, zoom]);

  // Free the previous page image once it has been replaced.
  const viewUrl = view?.url;
  useEffect(() => {
    return () => {
      if (viewUrl !== undefined) URL.revokeObjectURL(viewUrl);
    };
  }, [viewUrl]);

  // Ctrl/Cmd+wheel and trackpad pinch (which browsers report as ctrl+wheel). Needs a non-passive listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((current) => wheelZoom(current, event.deltaY, event.deltaMode));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // Keyboard: Ctrl/Cmd + O, +, -, 0.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      switch (event.key) {
        case 'o':
        case 'O':
          event.preventDefault();
          void open();
          break;
        case '+':
        case '=':
          event.preventDefault();
          setZoom((current) => stepZoom(current, 1));
          break;
        case '-':
        case '_':
          event.preventDefault();
          setZoom((current) => stepZoom(current, -1));
          break;
        case '0':
          event.preventDefault();
          setZoom(DEFAULT_ZOOM);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const pageCount = doc?.pageCount ?? 0;
  const hasPages = pageCount > 0;
  // The opaque canvas exists only while a document is open; the empty state sits on the page background (DESIGN 2).
  const onCanvas = doc !== null && hasPages;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-col gap-1 px-2 py-1">
        <div
          className="glass-1 flex flex-wrap items-center gap-1 rounded-panel p-0-5"
          role="toolbar"
          aria-label={strings.toolbarLabel}
        >
          <div className={GROUP}>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_PRIMARY}`}
              onClick={() => void open()}
              disabled={opening}
              title={strings.openHint}
              aria-keyshortcuts="Control+O Meta+O"
            >
              {opening ? strings.opening : strings.open}
            </button>
          </div>
          <div className={GROUP}>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_GHOST}`}
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              disabled={!hasPages || pageIndex === 0}
              aria-label={strings.previousPage}
              title={strings.previousPage}
            >
              ‹
            </button>
            <span className="min-w-6 px-1 text-center text-text-muted" aria-live="polite">
              {hasPages ? strings.page(pageIndex + 1, pageCount) : ''}
            </span>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_GHOST}`}
              onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
              disabled={!hasPages || pageIndex >= pageCount - 1}
              aria-label={strings.nextPage}
              title={strings.nextPage}
            >
              ›
            </button>
          </div>
          <div className={GROUP}>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_GHOST}`}
              onClick={() => setZoom((current) => stepZoom(current, -1))}
              disabled={!hasPages || zoom <= MIN_ZOOM}
              aria-label={strings.zoomOut}
              title={strings.zoomOut}
              aria-keyshortcuts="Control+Minus Meta+Minus"
            >
              −
            </button>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_GHOST}`}
              onClick={() => setZoom(DEFAULT_ZOOM)}
              disabled={!hasPages}
              aria-label={strings.zoomReset}
              title={strings.zoomReset}
              aria-keyshortcuts="Control+0 Meta+0"
            >
              {formatZoom(zoom)}
            </button>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_GHOST}`}
              onClick={() => setZoom((current) => stepZoom(current, 1))}
              disabled={!hasPages || zoom >= MAX_ZOOM}
              aria-label={strings.zoomIn}
              title={strings.zoomIn}
              aria-keyshortcuts="Control+Plus Meta+Plus"
            >
              +
            </button>
          </div>
          <span className="flex-auto" />
          <span className="px-1 text-sm text-text-muted" role="status">
            {rendering ? strings.rendering : ''}
          </span>
        </div>
        {error !== null && (
          <div
            className="glass-1 flex min-h-6 items-center gap-1 rounded-panel py-1 pe-1 ps-2 text-error-text"
            role="alert"
          >
            <span aria-hidden="true" className="w-0-5 self-stretch rounded-pill bg-error-icon" />
            <span className="flex-auto">{strings.error(error)}</span>
            <button type="button" className={`${BUTTON} ${BUTTON_GHOST}`} onClick={() => setError(null)}>
              {strings.dismiss}
            </button>
          </div>
        )}
      </header>
      <main
        className={`isolate mx-1 mb-1 flex min-h-0 overflow-auto ${onCanvas ? 'rounded-panel bg-canvas p-3' : 'p-1'}`}
        ref={canvasRef}
        tabIndex={0}
        aria-label={strings.documentRegion}
        aria-busy={rendering}
      >
        {view !== null ? (
          <div className="m-auto flex-none bg-page shadow-page">
            <img
              className="block h-auto max-w-none"
              src={view.url}
              alt={strings.pageImageAlt(pageIndex + 1, pageCount)}
              style={{ width: Math.round(view.widthPt * CSS_PX_PER_PT * zoom) }}
              draggable={false}
            />
          </div>
        ) : doc === null ? (
          <div className={EMPTY_CARD}>
            <h1 className="m-0 font-display text-xl">{strings.emptyTitle}</h1>
            <p className="m-0 text-text-muted">{strings.emptyHint}</p>
            <button
              type="button"
              className={`${BUTTON} ${BUTTON_PRIMARY} h-control-lg px-2`}
              onClick={() => void open()}
              disabled={opening}
            >
              {strings.open}
            </button>
          </div>
        ) : !hasPages ? (
          <div className={EMPTY_CARD}>
            <p className="m-0 text-text-muted">{strings.noPages}</p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
