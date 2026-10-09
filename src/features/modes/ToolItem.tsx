import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';

import { shortcutFor } from '../../actions/registry';
import { Icon, Menu, Popover, Tooltip, type MenuEntry, type PopoverApi } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { ColourRow } from './ColourRow';
import type { SlotDef, VariantDef } from './model';

/**
 * The main part of an item (DESIGN 3.18 E4, F21.9): one square for every tool (`--tool-square`, compact `--tool-square-compact`),
 * radius `--tool-item-radius`, icon 18 centred; with "Show labels" one width (`--tool-labelled-width`) and 56 high, icon over the
 * label (13/18), one line, truncated. The active tool is Solar with Ink 600 and the edge.
 */
const MAIN =
  'relative flex shrink-0 cursor-pointer flex-col items-center justify-center ' +
  'whitespace-nowrap rounded-(--tool-item-radius) t-label font-medium text-text ' +
  'transition-colors duration-fast aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-panel not-aria-disabled:not-data-[on=true]:active:bg-pressed not-aria-disabled:active:scale-(--scale-press) ' +
  'data-[on=true]:font-semibold data-[on=true]:text-ink not-aria-disabled:data-[on=true]:hover:bg-accent-hover not-aria-disabled:data-[on=true]:active:bg-accent-hover';

/** The three sizes of the strip's fit (F21.9): labelled (step 1 with "Show labels"), square (step 1), compact (steps 2 and 3). */
export type ToolSize = 'labelled' | 'square' | 'compact';

/** The box of an item per size; a split item's wrapper has the same box, so every slot takes the same room. */
export const BOX: Readonly<Record<ToolSize, string>> = {
  labelled: 'h-tool-item w-tool-labelled',
  square: 'size-tool-square',
  compact: 'size-tool-square-compact',
};

const PAD: Readonly<Record<ToolSize, string>> = {
  labelled: 'gap-[calc(var(--space-1)+var(--spacing-half))] px-1 pt-2 pb-[calc(var(--space-1)+var(--spacing-half))]',
  square: 'p-0',
  compact: 'p-0',
};

/** The main part of a split item fills the wrapper's square; never scaled, so nothing spills past the contour. */
export const SPLIT_PART = 'size-full! not-aria-disabled:active:scale-100!';

/**
 * The chevron of a split item (F21.9): a badge `--tool-badge` inside the same square, at its bottom end (top end with labels), with
 * its own hover and its own tab stop; Alt+Down on the main part opens it too.
 */
export const CHEVRON =
  'absolute end-half flex size-tool-badge cursor-pointer items-center justify-center rounded-sm text-text-muted transition-colors duration-fast ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-card not-aria-disabled:hover:text-text not-aria-disabled:aria-expanded:bg-card not-aria-disabled:active:bg-pressed ' +
  'group-data-[on=true]:text-ink group-data-[on=true]:not-aria-disabled:hover:bg-accent-hover group-data-[on=true]:not-aria-disabled:aria-expanded:bg-accent-hover ' +
  'group-data-[on=true]:not-aria-disabled:active:bg-accent-hover';

/** The one active-tool rule of all five modes (DESIGN Q2): Solar fill, Ink label and the hairline; a split item wears it as a whole. */
const ACTIVE = 'data-[on=true]:bg-accent data-[on=true]:shadow-(--tool-active-edge)';

/**
 * A split item wears the active rule once, on its outer contour (F19.27): the hairline is the ::after of the wrapper, painted above both
 * parts, so a hover fill of one part can never cover or change it. Neither part has a border, outline or shadow of its own.
 */
export const SPLIT_OUTER =
  'group relative flex shrink-0 overflow-hidden rounded-(--tool-item-radius) data-[on=true]:bg-accent ' +
  'data-[on=true]:after:pointer-events-none data-[on=true]:after:absolute data-[on=true]:after:inset-0 ' +
  'data-[on=true]:after:rounded-(--tool-item-radius) data-[on=true]:after:shadow-(--tool-active-edge)';

/** A toggle (Smart links, DESIGN 3.18 E4): White, Stone border, Ink label and icon while pressed; never the Solar fill, which is the active tool's alone. It has no `data-on`, so the glide pill skips it. */
const TOGGLE =
  'border border-transparent aria-pressed:border-border-control aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:text-ink';

const VARIANT =
  'flex h-(--space-8) w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-start text-md text-text ' +
  'hover:bg-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) aria-checked:font-semibold';

export interface ToolItemProps {
  slot: SlotDef;
  /** The fit's size: labels only with `labelled`; otherwise icon only, the label in the tooltip and `aria-label`. */
  size: ToolSize;
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

/** Closes the popover it is in as soon as the tool is off: Apply, Cancel and Esc end the tool, and its options must not stay as an empty panel. */
function CloseWhenOff({ on, close }: { on: boolean; close: PopoverApi['close'] }) {
  useEffect(() => {
    if (!on) close('programmatic');
  }, [on, close]);
  return null;
}

/** One slot of the tool strip: a tool, or an action; with variants and colours, a split item with a chevron badge in the same square. */
export function ToolItem({ slot, size, stop }: ToolItemProps) {
  const t = useT();
  const iconOnly = size !== 'labelled';
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
      data-on={slot.kind === 'toggle' ? undefined : slot.on}
      aria-pressed={slot.kind === 'action' ? undefined : slot.on}
      aria-disabled={off ? true : undefined}
      aria-keyshortcuts={found?.aria}
      aria-label={iconOnly ? slot.label : undefined}
      data-options-when-on={slot.optionsWhenOn === true ? '' : undefined}
      tabIndex={stop === slot.id ? 0 : -1}
      onKeyDown={(event) => {
        onMainKey(event);
        if (pop !== undefined && !off && event.altKey && event.key === 'ArrowDown') pop.onKeyDown(event);
      }}
      onClick={(event) => {
        if (off) return;
        // `slot.on` is the state before this click.
        const opens = slot.optionsWhenOn !== true || slot.on;
        slot.run();
        if (pop !== undefined && opens) pop.onClick(event);
      }}
      className={cx(MAIN, BOX[size], PAD[size], split ? SPLIT_PART : ACTIVE, slot.kind === 'toggle' && TOGGLE)}
    >
      <Icon icon={slot.icon} size={18} />
      {!iconOnly && (
        <span data-label="" className="max-w-full truncate">
          {slot.label}
        </span>
      )}
    </button>
  );

  const note = slot.disabledReason ?? slot.hint;
  const tip = (child: ReactElement) => (
    // Always on: a label under the icon may be truncated at the one labelled width.
    <Tooltip label={slot.label} shortcut={found?.label} note={note}>
      {child}
    </Tooltip>
  );
  if (optionsOnly && slot.Options !== undefined) {
    const Options = slot.Options;
    return (
      <Popover
        label={t('modes.options', { tool: slot.label })}
        disabled={off}
        trigger={(props) => tip(mainButton(props))}
      >
        {({ close }) => (
          <>
            <CloseWhenOff on={slot.on} close={close} />
            <Options />
          </>
        )}
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
      className={cx(CHEVRON, size === 'labelled' ? 'top-half' : 'bottom-half')}
    >
      <Icon icon={ChevronDown} className="size-3!" />
    </button>
  );

  return (
    <div data-split={slot.id} data-on={slot.on} className={cx(SPLIT_OUTER, BOX[size])}>
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
              <ColourRow kinds={slot.colour?.kinds ?? []} label={slot.colour?.label} />
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
