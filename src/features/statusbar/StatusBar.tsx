import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { runAction } from '../../actions/dispatch';
import { Field, IconButton } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSlots } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useDocView } from '../../stores/view';
import { BackControl, pushView } from '../history';
import { FIND_KEYS_ATTRIBUTE } from '../search/commands';
import { useActionState } from '../shell/useActionState';
import { formatPageTotal, formatZoomStatus, pageLabelOf, parsePageTarget } from '../topbar/format';
import { useGoToPage } from '../topbar/goToState';
import { SaveStatus } from '../topbar/SaveStatus';
import { useViewer } from '../viewer/useViewer';

/** A number field of the status bar: 24 high, White, subtle border, radius sm, 13 tabular, centred (DESIGN 3.18 E7). */
const FIELD = 'h-status-control! rounded-sm! text-center text-(length:--type-label-size)! font-normal';

/** What a typed zoom means: "125", "125 %", "125%" or "1,5 %" as a factor; `null` for anything else. */
export function parseZoomInput(text: string): number | null {
  const cleaned = text.replace(/[%\s]/g, '').replace(',', '.');
  if (!/^[0-9]{1,4}(\.[0-9]+)?$/.test(cleaned)) return null;
  const percent = Number.parseFloat(cleaned);
  return Number.isFinite(percent) && percent > 0 ? percent / 100 : null;
}

/**
 * The page field "3" with "/ 12" beside it, between the previous and next buttons. Enter goes to the typed page (a wrong number marks
 * the field and stays), Esc or leaving restores the current page. The `go-to-page` action focuses and selects it.
 */
function PageControls() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const { pageIndex, pageCount } = useDocView(docId);
  const slots = useSlots(docId);
  const labels = useMemo(() => slots.map((slot) => slot.label), [slots]);
  const hasLabels = labels.some((label) => label !== null);
  const shown = pageLabelOf(slots[pageIndex]?.label, pageIndex);
  const goToPage = useViewer((state) => state.goToPage);
  const requested = useGoToPage((state) => state.open);
  const setRequested = useGoToPage((state) => state.setOpen);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!requested) return;
    setRequested(false);
    input.current?.focus();
    input.current?.select();
  }, [requested, setRequested]);

  const reset = () => {
    setDraft(null);
    setInvalid(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      reset();
      event.currentTarget.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const page = parsePageTarget(draft ?? shown, pageCount, labels);
      if (page === null) {
        setInvalid(true);
        return;
      }
      if (docId !== null) pushView(docId);
      goToPage(page);
      reset();
      event.currentTarget.blur();
    }
  };
  return (
    <>
      <IconButton
        size="sm"
        icon={ChevronLeft}
        iconSize={16}
        label={t('status.prev')}
        className="size-6!"
        disabled={pageIndex <= 0 || pageCount === 0}
        focusableWhenDisabled
        onClick={() => goToPage(pageIndex - 1)}
      />
      <Field
        ref={input}
        data-tour-anchor="topbar-page-field"
        type="text"
        inputMode={hasLabels ? 'text' : 'numeric'}
        autoComplete="off"
        spellCheck={false}
        {...{ [FIND_KEYS_ATTRIBUTE]: '' }}
        aria-label={t('status.goToPage')}
        aria-invalid={invalid || undefined}
        disabled={pageCount === 0}
        tight
        className={cx(FIELD, 'w-10!')}
        value={draft ?? shown}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={reset}
        onKeyDown={onKeyDown}
      />
      <span className="t-label font-normal text-text-muted tabular-nums">
        {hasLabels
          ? t('status.pageOfLabelled', { page: pageIndex + 1, total: formatPageTotal(pageCount, t.locale) })
          : formatPageTotal(pageCount, t.locale)}
      </span>
      <IconButton
        size="sm"
        icon={ChevronRight}
        iconSize={16}
        label={t('status.next')}
        className="size-6!"
        disabled={pageIndex >= pageCount - 1}
        focusableWhenDisabled
        onClick={() => goToPage(pageIndex + 1)}
      />
    </>
  );
}

/** Zoom out, the zoom field ("100 %", accepts a typed percentage), zoom in. Seiten mode shows the page grid: disabled there. */
function ZoomControls() {
  const t = useT();
  const state = useActionState();
  const docId = useDocuments(selectActiveId);
  const { zoom, opening } = useDocView(docId);
  const gridMode = useUi((ui) => ui.mode) === 'pages';
  const off = !state.hasDocument || gridMode;
  const value = formatZoomStatus(opening ? Number.NaN : zoom, t.locale);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const reset = () => {
    setDraft(null);
    setInvalid(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      reset();
      event.currentTarget.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const next = parseZoomInput(draft ?? value);
      if (next === null) {
        setInvalid(true);
        return;
      }
      useViewer.getState().setZoom(next);
      reset();
      event.currentTarget.blur();
    }
  };
  return (
    <>
      <IconButton
        size="sm"
        icon={Minus}
        iconSize={16}
        label={t('status.zoomOut')}
        className="size-6!"
        disabled={off || state.zoomAtMin}
        focusableWhenDisabled
        onClick={() => void runAction('zoom-out')}
      />
      <Field
        data-toolbar-item="zoom-in"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        {...{ [FIND_KEYS_ATTRIBUTE]: '' }}
        aria-label={t('status.zoom')}
        aria-invalid={invalid || undefined}
        disabled={off}
        tight
        className={cx(FIELD, 'w-[calc(var(--space-16)+var(--space-2))]! tabular-nums')}
        value={draft ?? value}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={reset}
        onKeyDown={onKeyDown}
      />
      <IconButton
        size="sm"
        icon={Plus}
        iconSize={16}
        label={t('status.zoomIn')}
        className="size-6!"
        disabled={off || state.zoomAtMax}
        focusableWhenDisabled
        onClick={() => void runAction('zoom-in')}
      />
    </>
  );
}

/** A Ghost fit button, 24 high; the active fit is Sand + Ink 500 + `aria-pressed`. */
function FitButton({
  id,
  label,
  active,
  disabled,
}: {
  id: 'fit-width' | 'fit-page';
  label: string;
  active: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-disabled={disabled ? true : undefined}
      onClick={() => {
        if (!disabled) void runAction(id);
      }}
      className={cx(
        't-label inline-flex h-status-control shrink-0 items-center rounded-sm px-2 transition-colors duration-fast',
        active ? 'bg-subtle font-medium' : 'font-normal',
        disabled
          ? 'cursor-not-allowed opacity-(--opacity-disabled)'
          : 'cursor-pointer hover:bg-subtle active:bg-pressed',
      )}
    >
      {label}
    </button>
  );
}

/**
 * The status bar (DESIGN 3.18 E7): 30 high, White, border above. Left the save status, right the page controls, the zoom controls and the
 * two fit buttons that used to sit in the top row.
 */
export function StatusBar() {
  const t = useT();
  const state = useActionState();
  const docId = useDocuments(selectActiveId);
  const { fit } = useDocView(docId);
  const gridMode = useUi((ui) => ui.mode) === 'pages';
  const off = !state.hasDocument || gridMode;
  return (
    <div
      role="toolbar"
      aria-label={t('status.label')}
      data-slot="statusbar"
      className="bg-panel flex h-statusbar min-w-0 items-center justify-between gap-4 border-t border-border-subtle px-4"
    >
      <div className="flex min-w-0 items-center gap-1">
        <SaveStatus />
        <BackControl />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <PageControls />
        <span aria-hidden="true" className="mx-3 h-4 w-px bg-(--color-border)" />
        <ZoomControls />
        <span aria-hidden="true" className="w-2" />
        <FitButton id="fit-width" label={t('status.fitWidth')} active={fit === 'width'} disabled={off} />
        <FitButton id="fit-page" label={t('status.fitPage')} active={fit === 'page'} disabled={off} />
      </div>
    </div>
  );
}
