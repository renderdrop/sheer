import { RotateCw } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { FIND_KEYS_ATTRIBUTE } from '../search/commands';
import { Button, Field, Menu, Popover, usePulseMessage } from '../../components';
import { PILL } from '../../components/controlStyles';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import { useSettledValue } from './hooks';
import { formatPageStatus, formatZoomStatus, splitForMiddleTruncation } from './status';
import { FormPill } from '../forms/FormPill';
import { TourPill } from '../tour/TourPill';
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
  /** A save is running ("Saving…") or just finished ("Saved"); said in the same live region as the render activity (DESIGN 3.27). */
  saveHint?: 'saving' | 'saved' | null;
  /** The document has changes that are not saved: an "Edited" badge follows the name (DESIGN 3.10, 3.27). */
  edited?: boolean;
  onGoToPage: (pageIndex: number) => void;
  onZoom: (zoom: number) => void;
  /** The view rotation in degrees (DESIGN 3.20); a button that resets it is shown while it is not 0. */
  rotation?: number;
  onResetRotation?: () => void;
  /** The Go to page popover is open (controlled, so the `go-to-page` action can open it); uncontrolled without these. */
  goToOpen?: boolean;
  onGoToOpenChange?: (open: boolean) => void;
}

/** The name, cut in the middle when it does not fit: the end with the extension always stays (DESIGN 3.10: at most 40 % of the bar). */
function FileName({ name }: { name: string }) {
  const { head, tail } = splitForMiddleTruncation(name);
  return (
    <span data-tour-anchor="status-file-name" className="flex min-w-0 max-w-status-name items-center">
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

/** The "Go to page" popover behind the page button (DESIGN 3.20): a number field, "of n" and a Go button. */
function GoToPage({
  pageIndex,
  pageCount,
  onGo,
  open,
  onOpenChange,
}: {
  pageIndex: number;
  pageCount: number;
  onGo: (pageIndex: number) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const label = formatPageStatus(pageIndex, pageCount, t.locale);
  return (
    <Popover
      label={t('goto.label')}
      side="top"
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      trigger={(trigger) => (
        // The visible text is part of the name (WCAG 2.5.3); the rest says what the button does.
        <Button
          {...trigger}
          data-tour-anchor="status-page-button"
          variant="ghost"
          size="sm"
          aria-label={`${label} · ${t('status.goToPage')}`}
        >
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
  const errorId = useId();
  const [value, setValue] = useState(String(pageIndex + 1));
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    const page = /^[0-9]{1,6}$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    if (!(page >= 1 && page <= pageCount)) {
      // The popover stays: the field says what is wrong.
      setInvalid(true);
      return;
    }
    onGo(page - 1);
    done();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1 p-1">
      <span className="text-sm font-semibold text-text-muted">{t('goto.label')}</span>
      <div className="flex items-center gap-1">
        <Field
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          {...{ [FIND_KEYS_ATTRIBUTE]: '' }}
          aria-label={t('status.pageNumber')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          onFocus={(event) => event.currentTarget.select()}
        />
        <span className="text-sm text-text-muted">{t('goto.of', { n: pageCount })}</span>
        <Button type="submit" variant="primary" size="sm">
          {t('goto.go')}
        </Button>
      </div>
      {invalid && (
        <span id={errorId} role="alert" className="text-sm text-error-text">
          {t('goto.invalid', { n: pageCount })}
        </span>
      )}
    </form>
  );
}

/**
 * The status bar (DESIGN 3.10): 32 high on the page background with no surface, padding 0 16, meta type, gap 16. Leading:
 * the file name. Trailing: what the viewer is doing, the page ("3 / 120", opens Go to page) and the zoom ("125 %", opens the
 * zoom menu) as small ghost buttons. A polite live region says "Page 3 of 120" 500 ms after the page stopped changing.
 * It is a `<footer>`; a window without a document leaves it empty.
 */
export function StatusBar({
  fileName,
  pageIndex,
  pageCount,
  zoom,
  rendering,
  saveHint = null,
  edited = false,
  onGoToPage,
  onZoom,
  rotation = 0,
  onResetRotation,
  goToOpen,
  onGoToOpenChange,
}: StatusBarProps) {
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
      {hasDocument && edited && (
        <span data-edited="" className={`${PILL} pulse-target`}>
          {t('status.edited')}
        </span>
      )}
      <FormPill />
      <TourPill />
      <span className="flex-auto" />
      <span role="status" className="shrink-0">
        {saveHint === 'saving'
          ? t('save.saving')
          : saveHint === 'saved'
            ? t('save.saved')
            : rendering
              ? t('status.rendering')
              : ''}
      </span>
      {hasDocument && rotation !== 0 && (
        <Button variant="ghost" size="sm" aria-label={t('rotate.reset')} onClick={() => onResetRotation?.()}>
          <Icon icon={RotateCw} size={12} />
          {rotation}°
        </Button>
      )}
      {hasDocument && pageCount > 0 && (
        <GoToPage
          pageIndex={pageIndex}
          pageCount={pageCount}
          onGo={onGoToPage}
          open={goToOpen}
          onOpenChange={onGoToOpenChange}
        />
      )}
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
              aria-label={
                Number.isFinite(zoom)
                  ? `${formatZoomStatus(zoom, t.locale)} · ${t('toolbar.zoomLevel')}`
                  : t('toolbar.zoomLevel')
              }
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
