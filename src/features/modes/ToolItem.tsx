import { ChevronDown } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';

import { shortcutFor } from '../../actions/registry';
import { Icon, Menu, Popover, Tooltip, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { ColourRow } from './ColourRow';
import type { SlotDef, VariantDef } from './model';

/** The main part of an item (DESIGN v2 3.2): 36 high, radius md, icon 18 + 6 + label; the active tool is Solar with Ink 600 (2.3). */
const MAIN =
  'flex h-control-md shrink-0 cursor-pointer items-center gap-2 rounded-md t-label font-medium text-text ' +
  'transition-colors duration-fast aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-control-hover not-aria-disabled:active:bg-control-pressed not-aria-disabled:active:scale-(--scale-press) ' +
  'data-[on=true]:bg-accent data-[on=true]:font-semibold not-aria-disabled:data-[on=true]:hover:bg-accent-hover';

/** The chevron part of a split item: 20 wide, its own tab stop. */
const CHEVRON =
  'flex h-control-md w-icon-20 shrink-0 cursor-pointer items-center justify-center rounded-e-md text-text transition-colors duration-fast ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-control-hover not-aria-disabled:aria-expanded:bg-control-hover ' +
  'group-data-[on=true]:not-aria-disabled:hover:bg-accent-hover group-data-[on=true]:not-aria-disabled:aria-expanded:bg-accent-hover';

const VARIANT =
  'flex h-(--space-8) w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-start text-md text-text ' +
  'hover:bg-control-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) aria-checked:font-semibold';

export interface ToolItemProps {
  slot: SlotDef;
  /** Step 2 of the overflow: icon only, 36 x 36, the label in the tooltip. */
  iconOnly: boolean;
  /** The roving key that is the row's one tab stop. */
  stop: string;
}

const asEntry = (variant: VariantDef): MenuEntry => ({
  id: variant.id,
  label: variant.label,
  ...(variant.icon === undefined ? {} : { icon: variant.icon }),
  ...(variant.leading === undefined ? {} : { leading: variant.leading }),
  ...(variant.on === true ? { checked: true } : {}),
  ...(variant.disabled === true ? { disabled: true } : {}),
  onSelect: variant.run,
});

/** One slot of the tool row: a tool, or an action; with variants and colours, a split item with a chevron part. */
export function ToolItem({ slot, iconOnly, stop }: ToolItemProps) {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? detectPlatform();
  const chevron = useRef<HTMLButtonElement>(null);
  const off = slot.disabledReason !== undefined;
  const split = slot.variants !== undefined || slot.colour !== undefined || slot.Options !== undefined;
  const found = slot.actionId === undefined ? undefined : shortcutFor(slot.actionId, platform, t);

  const onMainKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Alt+Down opens the variants of a split item.
    if (split && event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      chevron.current?.click();
    }
  };

  const main = (
    <button
      type="button"
      data-toolbar-item={slot.id}
      data-roving={slot.id}
      data-on={slot.on}
      aria-pressed={slot.kind === 'tool' ? slot.on : undefined}
      aria-disabled={off ? true : undefined}
      aria-keyshortcuts={found?.aria}
      aria-label={iconOnly ? slot.label : undefined}
      tabIndex={stop === slot.id ? 0 : -1}
      onKeyDown={onMainKey}
      onClick={() => {
        if (!off) slot.run();
      }}
      className={cx(MAIN, iconOnly ? 'w-control-md justify-center' : 'px-3', split && 'rounded-e-none')}
    >
      <Icon icon={slot.icon} size={18} />
      {!iconOnly && <span data-label="">{slot.label}</span>}
    </button>
  );

  const note = slot.disabledReason ?? slot.hint;
  const tipped = (
    <Tooltip
      label={slot.label}
      shortcut={found?.label}
      note={note}
      disabled={!iconOnly && found === undefined && note === undefined}
    >
      {main}
    </Tooltip>
  );
  if (!split) return tipped;

  const optionsLabel = t('modes.options', { tool: slot.label });
  // A tool's own options are there while the tool is on.
  const chevronOff = off || (slot.Options !== undefined && !slot.on);
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
    <div data-split={slot.id} data-on={slot.on} className="group flex shrink-0 rounded-md data-[on=true]:bg-accent">
      {tipped}
      {slot.Options !== undefined ? (
        <Popover label={optionsLabel} disabled={chevronOff} trigger={trigger}>
          <slot.Options />
        </Popover>
      ) : slot.colour === undefined ? (
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
                      <Icon icon={variant.icon} />
                      {variant.label}
                    </button>
                  ))}
                </div>
              )}
              <ColourRow kinds={slot.colour?.kinds ?? []} />
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
