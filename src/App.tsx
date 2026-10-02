import { useCallback, useEffect, useRef, useState } from 'react';

import { closeDocument, openDocumentDialog, renderPage, type DocumentInfo } from './api/documents';
import { toAppError, type AppError } from './api/errors';
import { readPngSize } from './lib/png';
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
      renderPage(doc.id, pageIndex, scale)
        .then((png) => {
          if (cancelled) return;
          const size = readPngSize(png);
          if (size === null) {
            setError(toAppError(null));
            return;
          }
          const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
          setView({ url, widthPt: size.width / scale });
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

  return (
    <div className="app">
      <header className="chrome">
        <div className="toolbar glass" role="toolbar" aria-label={strings.toolbarLabel}>
          <div className="toolbar-group">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void open()}
              disabled={opening}
              title={strings.openHint}
              aria-keyshortcuts="Control+O Meta+O"
            >
              {opening ? strings.opening : strings.open}
            </button>
          </div>
          <div className="toolbar-group">
            <button
              type="button"
              className="btn"
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              disabled={!hasPages || pageIndex === 0}
              aria-label={strings.previousPage}
              title={strings.previousPage}
            >
              ‹
            </button>
            <span className="readout" aria-live="polite">
              {hasPages ? strings.page(pageIndex + 1, pageCount) : ''}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
              disabled={!hasPages || pageIndex >= pageCount - 1}
              aria-label={strings.nextPage}
              title={strings.nextPage}
            >
              ›
            </button>
          </div>
          <div className="toolbar-group">
            <button
              type="button"
              className="btn"
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
              className="btn"
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
              className="btn"
              onClick={() => setZoom((current) => stepZoom(current, 1))}
              disabled={!hasPages || zoom >= MAX_ZOOM}
              aria-label={strings.zoomIn}
              title={strings.zoomIn}
              aria-keyshortcuts="Control+Plus Meta+Plus"
            >
              +
            </button>
          </div>
          <span className="toolbar-spacer" />
          <span className="status" role="status">
            {rendering ? strings.rendering : ''}
          </span>
        </div>
        {error !== null && (
          <div className="banner" role="alert">
            <span className="banner-message">{error.message}</span>
            <button type="button" className="btn" onClick={() => setError(null)}>
              {strings.dismiss}
            </button>
          </div>
        )}
      </header>
      <main
        className="canvas"
        ref={canvasRef}
        tabIndex={0}
        aria-label={strings.documentRegion}
        aria-busy={rendering}
      >
        {view !== null ? (
          <div className="page">
            <img
              src={view.url}
              alt={strings.pageImageAlt(pageIndex + 1, pageCount)}
              style={{ width: Math.round(view.widthPt * CSS_PX_PER_PT * zoom) }}
              draggable={false}
            />
          </div>
        ) : doc === null ? (
          <div className="empty glass">
            <h1>{strings.emptyTitle}</h1>
            <p>{strings.emptyHint}</p>
            <button type="button" className="btn btn-primary" onClick={() => void open()} disabled={opening}>
              {strings.open}
            </button>
          </div>
        ) : !hasPages ? (
          <div className="empty glass">
            <p>{strings.noPages}</p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
