import { useRef, type FormEvent } from 'react';

import { Button, Field, Menu, Popover, usePulseMessage } from '../../components';
import { useT } from '../../i18n';
import { useSettledValue } from './hooks';
import { formatPageStatus, formatZoomStatus, splitForMiddleTruncation } from './status';
import { zoomMenuEntries } from './toolbarEntries';

/** The page announcement waits this long after the page last changed (DESIGN 3.10). */
export const ANNOUNCE_DELAY_MS = 500;

export interface StatusBarProps {
  /** The open document's file name; `null` while no document is open (the bar then has nothing to show). */
  fileName: string | null;
  /** Zero-based. */
  pageIndex: number;
  pageCount: number;
  zoom: number;
  /** A render is in flight: shown as activity text. */
  rendering: boolean;
  onGoToPage: (pageIndex: number) => void;
  onZoom: (zoom: number) => void;
}

/** The name, cut in the middle when it does not fit: the end with the extension always stays (DESIGN 3.10: at most 40 % of the bar). */
function FileName({ name }: { name: string }) {
  const { head, tail } = splitForMiddleTruncation(name);
  return (
    <span className="flex min-w-0 max-w-status-name items-center">
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="min-w-0 truncate">
        {head}
      </span>
      <span aria-hidden="true" className="shrink-0">
        {tail}
      </span>
    </span>
  );
}

/** The "Go to page" popover behind the page button: one number field and a Go button. */
function GoToPage({
  pageIndex,
  pageCount,
  onGo,
}: {
  pageIndex: number;
  pageCount: number;
  onGo: (pageIndex: number) => void;
}) {
  const t = useT();
  const label = formatPageStatus(pageIndex, pageCount, t.locale);
  return (
    <Popover
      label={t('status.goToPage')}
      side="top"
      align="end"
      trigger={(trigger) => (
        // The visible text is part of the name (WCAG 2.5.3); the rest says what the button does.
        <Button {...trigger} variant="ghost" size="sm" aria-label={`${label} · ${t('status.goToPage')}`}>
          {label}
        </Button>
      )}
    >
      {({ close }) => (
        <GoToPageForm pageIndex={pageIndex} pageCount={pageCount} onGo={onGo} done={() => close('select')} />
      )}
    </Popover>
  );
}

function GoToPageForm({
  pageIndex,
  pageCount,
  onGo,
  done,
}: {
  pageIndex: number;
  pageCount: number;
  onGo: (pageIndex: number) => void;
  done: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const page = Number.parseInt(input.current?.value ?? '', 10);
    if (Number.isFinite(page)) onGo(page - 1);
    done();
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-1 p-1">
      <label className="flex flex-col gap-0-5 text-sm text-text-muted">
        {t('status.pageNumber')}
        <Field
          ref={input}
          type="number"
          inputMode="numeric"
          min={1}
          max={pageCount}
          defaultValue={pageIndex + 1}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <Button type="submit" variant="primary" size="md">
        {t('status.go')}
      </Button>
    </form>
  );
}

/**
 * The status bar (DESIGN 3.10): 32 high on the page background with no surface, padding 0 16, meta type, gap 16. Leading:
 * the file name. Trailing: what the viewer is doing, the page ("3 / 120", opens Go to page) and the zoom ("125 %", opens the
 * zoom menu) as small ghost buttons. A polite live region says "Page 3 of 120" 500 ms after the page stopped changing.
 * It is a `<footer>`; a window without a document leaves it empty.
 */
export function StatusBar({ fileName, pageIndex, pageCount, zoom, rendering, onGoToPage, onZoom }: StatusBarProps) {
  const t = useT();
  const hasDocument = fileName !== null;
  const settledPage = useSettledValue(pageIndex, ANNOUNCE_DELAY_MS);
  const pulseMessage = usePulseMessage();

  return (
    <footer
      aria-label={t('status.label')}
      className="flex h-status shrink-0 items-center gap-2 px-2 text-sm text-text-muted"
    >
      {hasDocument && <FileName name={fileName === '' ? t('status.untitled') : fileName} />}
      <span className="flex-auto" />
      <span role="status" className="shrink-0">
        {rendering ? t('status.rendering') : ''}
      </span>
      {hasDocument && pageCount > 0 && <GoToPage pageIndex={pageIndex} pageCount={pageCount} onGo={onGoToPage} />}
      {hasDocument && (
        <Menu
          label={t('status.zoomMenu')}
          side="top"
          align="end"
          entries={zoomMenuEntries(zoom, onZoom, t.locale)}
          trigger={(trigger) => (
            <Button
              {...trigger}
              variant="ghost"
              size="sm"
              aria-label={`${formatZoomStatus(zoom, t.locale)} · ${t('toolbar.zoomLevel')}`}
            >
              {formatZoomStatus(zoom, t.locale)}
            </Button>
          )}
        />
      )}
      {/* The settled page, for screen readers only (the visible page number changes at once). */}
      <span role="status" className="sr-only">
        {hasDocument && pageCount > 0 ? t('status.page', { page: settledPage + 1, total: pageCount }) : ''}
      </span>
      {/* Success pulses announce here (MOTION 4.7). */}
      <span role="status" className="sr-only">
        {pulseMessage}
      </span>
    </footer>
  );
}
