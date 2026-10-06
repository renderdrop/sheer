import { ChevronDown } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactElement } from 'react';

import { shortcutFor } from '../../actions/registry';
import { Icon, Menu, Popover, Tooltip, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { ColourRow } from './ColourRow';
import { RecogniseSwitch } from './RecogniseSwitch';
import type { SlotDef, VariantDef } from './model';

/** The main part of an item (DESIGN v2 3.2): 36 high, radius md, icon 18 + 6 + label; the active tool is Solar with Ink 600 (2.3). */
const MAIN =
  'flex h-control-md shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md t-label font-medium text-text ' +
  'transition-colors duration-fast aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-panel not-aria-disabled:not-data-[on=true]:active:bg-pressed not-aria-disabled:active:scale-(--scale-press) ' +
  'data-[on=true]:font-semibold data-[on=true]:text-ink not-aria-disabled:data-[on=true]:hover:bg-accent-hover not-aria-disabled:data-[on=true]:active:bg-accent-hover';

/** The main part of a split item: square (the outer contour rounds it) and never scaled, so nothing spills past the contour. */
const SPLIT_PART = 'rounded-none! not-aria-disabled:active:scale-100!';

/** The chevron part of a split item: 20 wide, its own tab stop. */
const CHEVRON =
  'flex h-control-md w-icon-20 shrink-0 cursor-pointer items-center justify-center border-s border-border-subtle text-text transition-colors duration-fast ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-panel not-aria-disabled:aria-expanded:bg-panel not-aria-disabled:active:bg-pressed ' +
  'group-data-[on=true]:text-ink group-data-[on=true]:not-aria-disabled:hover:bg-accent-hover group-data-[on=true]:not-aria-disabled:aria-expanded:bg-accent-hover ' +
  'group-data-[on=true]:not-aria-disabled:active:bg-accent-hover';

/** The one active-tool rule of all five modes (DESIGN Q2): Solar fill, Ink label and the hairline; a split item wears it as a whole. */
const ACTIVE = 'data-[on=true]:bg-accent data-[on=true]:shadow-(--tool-active-edge)';

const VARIANT =
  'flex h-(--space-8) w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-start text-md text-text ' +
  'hover:bg-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) aria-checked:font-semibold';

export interface ToolItemProps {
  slot: SlotDef;
  /** Step 2 of the overflow: icon only, 36 x 36, the label in the tooltip. */
  iconOnly: boolean;
  /** The roving key that is the row's one tab stop. */
  stop: string;
}

export const asEntry = (variant: VariantDef): MenuEntry => ({
  id: variant.id,
  label: variant.label,
  ...(variant.icon === undefined ? {} : { icon: variant.icon }),
  ...(variant.leading === undefined ? {} : { leading: variant.leading }),
  ...(variant.radio === true
    ? { checked: variant.on === true, radio: true }
    : variant.on === true
      ? { checked: true }
      : {}),
  ...(variant.caption === undefined ? {} : { caption: variant.caption }),
  ...(variant.disabled === true ? { disabled: true } : {}),
  onSelect: variant.run,
});

/** One slot of the tool row: a tool, or an action; with variants and colours, a split item with a chevron part. */
export function ToolItem({ slot, iconOnly, stop }: ToolItemProps) {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? detectPlatform();
  const chevron = useRef<HTMLButtonElement>(null);
  const off = slot.disabledReason !== undefined;
  const found = slot.actionId === undefined ? undefined : shortcutFor(slot.actionId, platform, t);

  // A tool whose only extra is its own options has no chevron part (DESIGN 3.2: no variants): the main part opens them.
  const optionsOnly = slot.Options !== undefined && slot.variants === undefined && slot.colour === undefined;
  const split = !optionsOnly && (slot.variants !== undefined || slot.colour !== undefined);

  const onMainKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Alt+Down opens the variants of a split item.
    if (split && event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      chevron.current?.click();
    }
  };

  const mainButton = (pop?: Parameters<Parameters<typeof Popover>[0]['trigger']>[0]) => (
    <button
      {...(pop === undefined
        ? {}
        : {
            ref: pop.ref,
            'aria-haspopup': pop['aria-haspopup'],
            'aria-expanded': pop['aria-expanded'],
            'aria-controls': pop['aria-controls'],
          })}
      type="button"
      data-toolbar-item={slot.id}
      data-testid={slot.testId}
      data-roving={slot.id}
      data-on={slot.on}
      aria-pressed={slot.kind === 'action' ? undefined : slot.on}
      aria-disabled={off ? true : undefined}
      aria-keyshortcuts={found?.aria}
      aria-label={iconOnly ? slot.label : undefined}
      tabIndex={stop === slot.id ? 0 : -1}
      onKeyDown={(event) => {
        onMainKey(event);
        if (pop !== undefined && !off && event.altKey && event.key === 'ArrowDown') pop.onKeyDown(event);
      }}
      onClick={(event) => {
        if (off) return;
        slot.run();
        if (pop !== undefined) pop.onClick(event);
      }}
      className={cx(MAIN, iconOnly ? 'w-control-md justify-center' : 'px-3', split ? SPLIT_PART : ACTIVE)}
    >
      <Icon icon={slot.icon} size={18} />
      {!iconOnly && <span data-label="">{slot.label}</span>}
    </button>
  );

  const note = slot.disabledReason ?? slot.hint;
  const tip = (child: ReactElement) => (
    <Tooltip
      label={slot.label}
      shortcut={found?.label}
      note={note}
      disabled={!iconOnly && found === undefined && note === undefined}
    >
      {child}
    </Tooltip>
  );
  if (optionsOnly && slot.Options !== undefined) {
    return (
      <Popover
        label={t('modes.options', { tool: slot.label })}
        disabled={off}
        trigger={(props) => tip(mainButton(props))}
      >
        <slot.Options />
      </Popover>
    );
  }
  const tipped = tip(mainButton());
  if (!split) return tipped;

  const optionsLabel = t('modes.options', { tool: slot.label });
  const chevronOff = off;
  const trigger = (props: Parameters<Parameters<typeof Popover>[0]['trigger']>[0]) => (
    <button
      {...props}
      ref={(element) => {
        chevron.current = element as HTMLButtonElement | null;
        props.ref(element);
      }}
      type="button"
      data-roving={`${slot.id}:more`}
      aria-label={optionsLabel}
      aria-disabled={chevronOff ? true : undefined}
      tabIndex={stop === `${slot.id}:more` ? 0 : -1}
      onClick={(event) => {
        if (!chevronOff) props.onClick(event);
      }}
      onKeyDown={(event) => {
        if (!chevronOff) props.onKeyDown(event);
      }}
      className={CHEVRON}
    >
      <Icon icon={ChevronDown} />
    </button>
  );

  return (
    <div
      data-split={slot.id}
      data-on={slot.on}
      className={cx('group flex shrink-0 rounded-md overflow-hidden', ACTIVE)}
    >
      {tipped}
      {slot.colour === undefined ? (
        <Menu label={optionsLabel} disabled={off} entries={(slot.variants ?? []).map(asEntry)} trigger={trigger} />
      ) : (
        <Popover label={optionsLabel} disabled={off} trigger={trigger}>
          {({ close }) => (
            <div className="flex flex-col">
              {slot.variants !== undefined && (
                <div role="group" aria-label={slot.label} className="flex flex-col p-1">
                  {slot.variants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      role="radio"
                      aria-checked={variant.on === true}
                      onClick={() => {
                        variant.run();
                        close('select');
                      }}
                      className={VARIANT}
                    >
                      {variant.icon !== undefined && <Icon icon={variant.icon} />}
                      {variant.label}
                    </button>
                  ))}
                </div>
              )}
              <ColourRow kinds={slot.colour?.kinds ?? []} />
              {slot.recogniseSwitch === true && <RecogniseSwitch className="border-t border-border-subtle p-2" />}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
