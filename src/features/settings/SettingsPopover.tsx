import { useId, useLayoutEffect, useState, type ReactNode } from 'react';

import { Button, Field, Popover } from '../../components';
import { AUTHOR_NAME_MAX, isAuthorName, openDefaultAppsSettings } from '../../api/app';
import { APP_NAME } from '../../config/app';
import type { AppError } from '../../api/errors';
import { errorText, useT, type Language, type PlainKey } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';
import { openSignatureLibrary } from '../signatures/library';
import { resetTips } from '../tips/runtime';
import { restartTour } from '../tour/runtime';
import { useTour } from '../tour/store';
import { UpdateRow } from '../update/UpdateRow';
import { useSettingsPopover } from './state';

/** The values of each setting with the catalog key of their text, in the order the segments show them. */
const LANGUAGE_CHOICES: readonly { value: Language; labelKey: PlainKey }[] = [
  { value: 'system', labelKey: 'settings.language.system' },
  { value: 'en', labelKey: 'settings.language.en' },
  { value: 'de', labelKey: 'settings.language.de' },
];

/** Where the popover is anchored: Home's Settings row, else the toolbar's More button (the command's home, `data-toolbar-item="more"`), else the toolbar, else (Home has no toolbar) the Home strip. */
const ANCHORS = ['[data-home-settings]', '[data-toolbar-item="more"]', '[role="toolbar"]', '[data-slot="home-strip"]'];

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
      <span id={labelId} className="text-sm font-semibold text-text-muted">
        {label}
      </span>
      {children(labelId)}
      {hint !== undefined && (
        <p aria-live={live ? 'polite' : undefined} className="m-0 text-sm text-text-muted">
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
  const [done, setDone] = useState(false);
  const empty = seen === 0;
  return (
    <Setting label={t('settings.help')} hint={done ? t('settings.tips.resetDone') : t('settings.tour.hint')} live>
      {(labelId) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" aria-describedby={labelId} onClick={() => void restartTour()}>
            {running ? t('settings.tour.restart') : t('settings.tour.start')}
          </Button>
          <Button
            variant="secondary"
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
        </div>
      )}
    </Setting>
  );
}

/** The signature library row (DESIGN 3.35): the popover closes and the library dialog opens. */
function SignaturesRow() {
  const t = useT();
  return (
    <Setting label={t('settings.signatures')} hint={t('settings.signatures.hint')}>
      {(labelId) => (
        <Button variant="secondary" size="sm" aria-describedby={labelId} onClick={() => openSignatureLibrary()}>
          {t('lib.manage')}
        </Button>
      )}
    </Setting>
  );
}

/**
 * The default PDF app row: opens the OS page where the user picks the app (Windows only; macOS has no such page, so the row
 * is hidden there and wherever the platform is unknown). A failure is shown in the popover's alert line.
 */
function DefaultAppRow() {
  const t = useT();
  const platform = useSettings((state) => state.platform);
  const [error, setError] = useState<AppError | null>(null);
  if (platform !== 'windows') return null;
  return (
    <Setting label={t('settings.defaultApp')} hint={t('settings.defaultApp.hint', { app: APP_NAME })}>
      {(labelId) => (
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-describedby={labelId}
            onClick={() => {
              setError(null);
              openDefaultAppsSettings().catch((e: AppError) => setError(e));
            }}
          >
            {t('settings.defaultApp.button', { app: APP_NAME })}
          </Button>
          {error !== null && (
            <p role="alert" className="m-0 text-sm text-error-text">
              {errorText(t, error)}
            </p>
          )}
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
          style={{ width: '100%' }}
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

/** The settings as segmented controls and the author field; each choice is saved and applied at once (the store answers `update_settings`). */
function SettingsForm() {
  const t = useT();
  const language = useSettings((state) => state.language);
  const error = useSettings((state) => state.error);
  const setLanguage = useSettings((state) => state.setLanguage);

  const options = <Value extends string>(
    choices: readonly { value: Value; labelKey: PlainKey }[],
  ): SegmentOption<Value>[] => choices.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }));

  return (
    <div className="flex flex-col gap-4 p-2">
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
      <SignaturesRow />
      <DefaultAppRow />
      <Setting label={t('settings.updates')} hint={t('settings.updates.hint')}>
        {(labelId) => <UpdateRow labelId={labelId} />}
      </Setting>
      <HelpRow />
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-error-text">
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
