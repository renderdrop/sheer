import { useEffect, useId, useLayoutEffect, useState, type ReactNode } from 'react';

import { Button, Field, Popover, Toggle, Tooltip } from '../../components';
import { AUTHOR_NAME_MAX, isAuthorName } from '../../api/app';
import { APP_NAME } from '../../config/app';
import { errorText, useT, type Language, type PlainKey } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { setSmartLinksEverywhere } from '../smartlinks/actions';
import { useSmartLinks } from '../smartlinks/store';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';
import { openAbout } from '../about/state';
import { useUpdate } from '../update/store';
import { resetTips } from '../tips/runtime';
import { restartTour } from '../tour/runtime';
import { useTour } from '../tour/store';
import { UpdateRow } from '../update/UpdateRow';
import { takeSettingsOpener, useSettingsPopover } from './state';

/** The values of each setting with the catalog key of their text, in the order the segments show them. */
const LANGUAGE_CHOICES: readonly { value: Language; labelKey: PlainKey }[] = [
  { value: 'system', labelKey: 'settings.language.system' },
  { value: 'en', labelKey: 'settings.language.en' },
  { value: 'de', labelKey: 'settings.language.de' },
];

/** Where the popover is anchored: Home's Settings row, else the Datei menu title or the top bar's first control, else the Home strip. */
const ANCHORS = [
  '[data-home-settings]',
  '[data-menubar-item]',
  '[data-slot="topbar"] button',
  '[data-slot="home-strip"]',
];

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
 * "trigger" renders nothing and gives the popover the menu bar's or top bar's own button when the popover opens, which is also where
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
  live = false,
  children,
}: {
  label: string;
  hint?: string;
  /** The hint is a polite live region (its text changes after an action). */
  live?: boolean;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="t-label text-text">
        {label}
      </span>
      {children(labelId)}
      {hint !== undefined && (
        <p aria-live={live ? 'polite' : undefined} className="t-caption m-0 text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The Help row (DESIGN 3.14 Restart, 3.47): the welcome tour (start, or restart while it runs; the popover closes and the welcome
 * document opens fresh) and "Show tips again". The second is aria-disabled while no tip has been seen; its press is confirmed by
 * the hint, read politely.
 */
function HelpRow() {
  const t = useT();
  const running = useTour((state) => state.docId !== null);
  const seen = useSettings((state) => state.tipsSeen?.length ?? 0);
  const tipsOn = useSettings((state) => state.tipsEnabled !== false);
  const update = useSettings((state) => state.update);
  const [done, setDone] = useState(false);
  const switchId = useId();
  // Nothing to bring back while no tip was seen or while tips are off (DESIGN 3.13 C5).
  const empty = seen === 0 || !tipsOn;
  const hint = !tipsOn ? t('settings.tips.offHint') : done ? t('settings.tips.resetDone') : t('settings.tour.hint');
  return (
    <Setting label={t('settings.tour')} hint={hint} live>
      {(labelId) => (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button variant="secondary" size="sm" aria-describedby={labelId} onClick={() => void restartTour()}>
            {running ? t('settings.tour.restart') : t('settings.tour.start')}
          </Button>
          <div className="flex h-[var(--control-md)] items-center gap-2">
            <Toggle
              checked={tipsOn}
              onCheckedChange={(checked) => void update({ tipsEnabled: checked })}
              aria-labelledby={switchId}
            />
            <span id={switchId} className="t-body text-text" onClick={() => void update({ tipsEnabled: !tipsOn })}>
              {t('settings.tips.enabled')}
            </span>
          </div>
          <Tooltip label={t('settings.tips.reset')} note={t('settings.tips.offHint')} side="right" disabled={tipsOn}>
            <Button
              variant="ghost"
              size="sm"
              aria-describedby={labelId}
              disabled={empty}
              focusableWhenDisabled
              onClick={() => {
                if (empty) return;
                setDone(true);
                void resetTips();
              }}
            >
              {t('settings.tips.reset')}
            </Button>
          </Tooltip>
        </div>
      )}
    </Setting>
  );
}

/**
 * The author name row (DESIGN 3.25): the name put on the notes and markup the user adds. Saved when the field is left or Enter is
 * pressed; an invalid text is not saved and the field goes back to the saved name; empty is allowed (no author, ADR-034). Esc reverts the typing.
 */
function AuthorRow() {
  const t = useT();
  const saved = useSettings((state) => state.authorName);
  const setAuthorName = useSettings((state) => state.setAuthorName);
  const [text, setText] = useState<string | null>(null);

  const commit = () => {
    if (text === null) return;
    const next = text.trim();
    setText(null);
    if (next !== saved && isAuthorName(next)) void setAuthorName(next);
  };
  return (
    <Setting label={t('settings.author')} hint={t('settings.author.hint')}>
      {(labelId) => (
        <Field
          aria-labelledby={labelId}
          autoComplete="off"
          spellCheck={false}
          maxLength={AUTHOR_NAME_MAX}
          placeholder={t('settings.author.placeholder')}
          className="w-full!"
          // While there is typing to cancel, the first Esc is the field's (it reverts); the next one closes the popover.
          data-keep-escape={text !== null ? '' : undefined}
          value={text ?? saved}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape' && text !== null) {
              setText(null);
            }
          }}
        />
      )}
    </Setting>
  );
}

/**
 * The Smart links group (DESIGN 3.11 L8): one switch for every tab, default on, kept in the UI storage. Turning it on or off clears the
 * tabs' own choices (the Lesen toggle).
 */
function SmartLinksRow() {
  const t = useT();
  const on = useSmartLinks((state) => state.enabled);
  const labelId = useId();
  const descId = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="t-label text-text">
          {t('settings.smartLinks')}
        </span>
        <Toggle checked={on} onCheckedChange={setSmartLinksEverywhere} aria-labelledby={`${labelId} ${descId}`} />
      </div>
      <p id={descId} className="t-caption m-0 text-text-muted">
        {t('settings.smartLinks.toggle')}. {t('settings.smartLinks.hint')}
      </p>
    </div>
  );
}

/** The About group, after a divider: name and version, and the button that opens the About dialog (it closes this popover). */
function AboutRow() {
  const t = useT();
  const version = useSettings((state) => state.version);
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
      <span id={labelId} className="t-label text-text">
        {t('settings.about')}
      </span>
      <p className="t-caption m-0 text-text-muted">
        {version !== null ? `${APP_NAME} · ${t('about.version', { version })}` : APP_NAME}
      </p>
      <div>
        <Button variant="ghost" size="sm" aria-describedby={labelId} onClick={() => openAbout()}>
          {t('about.title', { app: APP_NAME })}
        </Button>
      </div>
    </div>
  );
}

/** The settings as segmented controls and the author field; each choice is saved and applied at once (the store answers `update_settings`). */
function SettingsForm() {
  const t = useT();
  const language = useSettings((state) => state.language);
  const error = useSettings((state) => state.error);
  const setLanguage = useSettings((state) => state.setLanguage);
  // ADR-053: an updater without its signing key shows no Updates group at all, and none until the local probe has answered.
  const updaterReady = useUpdate((state) => state.configured === true && state.check !== 'unconfigured');
  useEffect(() => {
    void useUpdate.getState().probe();
  }, []);

  const options = <Value extends string>(
    choices: readonly { value: Value; labelKey: PlainKey }[],
  ): SegmentOption<Value>[] => choices.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }));

  return (
    <div className="flex flex-col gap-3">
      <h2 className="t-title m-0 text-text">{t('settings.title')}</h2>
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
      <AuthorRow />
      <SmartLinksRow />
      {updaterReady && (
        <Setting label={t('settings.updates')} hint={t('settings.updates.hint')}>
          {(labelId) => <UpdateRow labelId={labelId} />}
        </Setting>
      )}
      <HelpRow />
      <AboutRow />
      {error !== null && (
        <p role="alert" className="t-caption m-0 text-error-text">
          {errorText(t, error)}
        </p>
      )}
    </div>
  );
}

/**
 * The settings popover (DESIGN 3.13): language as segmented controls in a G2 Popover under the toolbar.
 * It opens from the `settings` action, whichever way it was run (Ctrl or Cmd and comma, More, the macOS menu bar), through
 * `useSettingsPopover`. Mounted once, with the toolbar.
 */
export function SettingsPopover() {
  const t = useT();
  const open = useSettingsPopover((state) => state.open);
  const setOpen = useSettingsPopover((state) => state.setOpen);
  // Esc or an outside click closes it; with no trigger of its own, focus goes back to what had it when the command ran.
  const onOpenChange = (next: boolean) => {
    if (!next) {
      const back = takeSettingsOpener();
      if (back?.isConnected === true) window.setTimeout(() => back.focus({ preventScroll: true }), 0);
    }
    setOpen(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t('settings.title')}
      side="bottom"
      align="start"
      trigger={(props) => <ToolbarAnchor attach={props.ref} open={open} />}
    >
      <SettingsForm />
    </Popover>
  );
}
