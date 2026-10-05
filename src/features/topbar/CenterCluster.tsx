import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { currentPlatform } from '../../actions/keys';
import { Button, Field, Icon, Menu } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useDocView } from '../../stores/view';
import { FIND_KEYS_ATTRIBUTE } from '../search/commands';
import { useActionState } from '../shell/useActionState';
import { useViewer } from '../viewer/useViewer';
import { zoomEntries } from './entries';
import { formatPageTotal, formatZoomStatus, parsePageInput } from './format';
import { useGoToPage } from './goToState';

/** The zoom dropdown, 88 x 36: the value (tabular) and a chevron; it opens zoom, scroll mode and view rotation. */
function ZoomMenu() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const docId = useDocuments(selectActiveId);
  const { zoom, opening, scrollMode } = useDocView(docId);
  const value = formatZoomStatus(opening ? Number.NaN : zoom, t.locale);
  const entries = useMemo(() => zoomEntries({ t, platform, state }, scrollMode), [t, platform, state, scrollMode]);
  return (
    <Menu
      label={t('status.zoomMenu')}
      side="bottom"
      align="center"
      entries={entries}
      trigger={(trigger) => (
        <Button
          {...trigger}
          data-toolbar-item="zoom-in"
          variant="ghost"
          disabled={!state.hasDocument}
          focusableWhenDisabled
          aria-label={Number.isFinite(zoom) ? `${value} · ${t('toolbar.zoomLevel')}` : t('toolbar.zoomLevel')}
          className="w-[calc(var(--space-12)+var(--space-10))]! justify-between px-3! tabular-nums"
        >
          <span>{value}</span>
          <Icon icon={ChevronDown} size={16} />
        </Button>
      )}
    />
  );
}

/**
 * The page field "3 / 12": a 48 wide field with the current page and the total beside it. Enter goes to the typed page (a wrong
 * number marks the field and stays), Esc or leaving restores the current page. The `go-to-page` action focuses and selects it.
 */
function PageField() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const { pageIndex, pageCount } = useDocView(docId);
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
      const page = parsePageInput(draft ?? String(pageIndex + 1), pageCount);
      if (page === null) {
        setInvalid(true);
        return;
      }
      goToPage(page);
      reset();
      event.currentTarget.blur();
    }
  };
  return (
    <div data-tour-anchor="topbar-page-field" className="flex items-center gap-2">
      <Field
        ref={input}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        {...{ [FIND_KEYS_ATTRIBUTE]: '' }}
        align="end"
        aria-label={t('status.goToPage')}
        aria-invalid={invalid || undefined}
        disabled={pageCount === 0}
        className="w-12! px-2! tabular-nums"
        value={draft ?? String(pageIndex + 1)}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={reset}
        onKeyDown={onKeyDown}
      />
      <span className="t-label text-text-muted tabular-nums">{formatPageTotal(pageCount, t.locale)}</span>
    </div>
  );
}

/** Centre of the top bar: zoom dropdown, 8 gap, page field. */
export function CenterCluster() {
  return (
    <div className="flex items-center gap-2">
      <ZoomMenu />
      <PageField />
    </div>
  );
}
