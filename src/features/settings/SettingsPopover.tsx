import { useId, useLayoutEffect, type ReactNode } from 'react';

import { Button, Popover } from '../../components';
import type { GlassMode, ThemeMode } from '../../api/app';
import { errorText, useT, type Language, type PlainKey } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';
import { restartTour } from '../tour/runtime';
import { useTour } from '../tour/store';
import { useSettingsPopover } from './state';

/** The values of each setting with the catalog key of their text, in the order the segments show them. */
const THEMES: readonly { value: ThemeMode; labelKey: PlainKey }[] = [
  { value: 'system', labelKey: 'settings.theme.system' },
  { value: 'light', labelKey: 'settings.theme.light' },
  { value: 'dark', labelKey: 'settings.theme.dark' },
];
const GLASS: readonly { value: GlassMode; labelKey: PlainKey }[] = [
  { value: 'auto', labelKey: 'settings.glass.auto' },
  { value: 'solid', labelKey: 'settings.glass.solid' },
];
const LANGUAGE_CHOICES: readonly { value: Language; labelKey: PlainKey }[] = [
  { value: 'system', labelKey: 'settings.language.system' },
  { value: 'en', labelKey: 'settings.language.en' },
  { value: 'de', labelKey: 'settings.language.de' },
];

/** Where the popover is anchored: the toolbar's More button (the command's home, `data-toolbar-item="more"`), else the toolbar. */
const ANCHORS = ['[data-toolbar-item="more"]', '[role="toolbar"]'];

function findAnchor(): HTMLElement | null {
  for (const selector of ANCHORS) {
    const found = document.querySelector<HTMLElement>(selector);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Hands the popover an anchor that lives elsewhere. The Popover takes its anchor from the trigger it renders, and this
 * popover has no trigger of its own: the command is chosen in More, or typed as a shortcut with focus anywhere. So the
 * "trigger" renders nothing and gives the popover the toolbar's own button when the popover opens, which is also where
 * focus returns on close.
 */
function ToolbarAnchor({ attach, open }: { attach: (element: HTMLElement | null) => void; open: boolean }): null {
  useLayoutEffect(() => {
    if (open) attach(findAnchor());
  }, [attach, open]);
  return null;
}

function Setting({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-sm font-semibold text-text-muted">
        {label}
      </span>
      {children(labelId)}
      {hint !== undefined && <p className="m-0 text-sm text-text-muted">{hint}</p>}
    </div>
  );
}

/** The welcome tour row (DESIGN 3.14): starts it, or restarts it while it runs; the popover closes and the welcome document opens fresh. */
function TourRow() {
  const t = useT();
  const running = useTour((state) => state.docId !== null);
  return (
    <Setting label={t('settings.tour')} hint={t('settings.tour.hint')}>
      {(labelId) => (
        <Button variant="secondary" size="sm" aria-describedby={labelId} onClick={() => void restartTour()}>
          {running ? t('settings.tour.restart') : t('settings.tour.start')}
        </Button>
      )}
    </Setting>
  );
}

/** The three settings as segmented controls; each choice is saved and applied at once (the store answers `update_settings`). */
function SettingsForm() {
  const t = useT();
  const theme = useSettings((state) => state.theme);
  const glass = useSettings((state) => state.glass);
  const language = useSettings((state) => state.language);
  const error = useSettings((state) => state.error);
  const setTheme = useSettings((state) => state.setTheme);
  const setGlass = useSettings((state) => state.setGlass);
  const setLanguage = useSettings((state) => state.setLanguage);

  const options = <Value extends string>(
    choices: readonly { value: Value; labelKey: PlainKey }[],
  ): SegmentOption<Value>[] => choices.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }));

  return (
    <div className="flex flex-col gap-2 p-1">
      <Setting label={t('settings.theme')}>
        {(labelId) => (
          <SegmentedControl
            labelledBy={labelId}
            value={theme}
            options={options(THEMES)}
            onChange={(v) => void setTheme(v)}
          />
        )}
      </Setting>
      <Setting label={t('settings.glass')} hint={t('settings.glass.hint')}>
        {(labelId) => (
          <SegmentedControl
            labelledBy={labelId}
            value={glass}
            options={options(GLASS)}
            onChange={(v) => void setGlass(v)}
          />
        )}
      </Setting>
      <Setting label={t('settings.language')}>
        {(labelId) => (
          <SegmentedControl
            labelledBy={labelId}
            value={language}
            options={options(LANGUAGE_CHOICES)}
            onChange={(v) => void setLanguage(v)}
          />
        )}
      </Setting>
      <TourRow />
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-error-text">
          {errorText(t, error)}
        </p>
      )}
    </div>
  );
}

/**
 * The settings popover (DESIGN 3.13): theme, glass and language as segmented controls in a G2 Popover under the toolbar.
 * It opens from the `settings` action, whichever way it was run (Ctrl or Cmd and comma, More, the macOS menu bar), through
 * `useSettingsPopover`. Mounted once, with the toolbar.
 */
export function SettingsPopover() {
  const t = useT();
  const open = useSettingsPopover((state) => state.open);
  const setOpen = useSettingsPopover((state) => state.setOpen);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('settings.title')}
      side="bottom"
      align="start"
      trigger={(props) => <ToolbarAnchor attach={props.ref} open={open} />}
    >
      <SettingsForm />
    </Popover>
  );
}
