import { Check, Palette } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import { Icon, Popover, Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { itemsOf } from '../../components/roving';
import { useT, type PlainKey } from '../../i18n';
import { PALETTE_SET_NAMES, PALETTE_SETS, rgbToCss, usePaletteSet } from './palette';

const PRESET_KEYS = [
  'palette.preset1',
  'palette.preset2',
  'palette.preset3',
  'palette.preset4',
] as const satisfies readonly PlainKey[];

/**
 * The palette chooser (F19.19, ADR-143): a small palette icon button that opens one row of five swatches per preset set, without names
 * or hex (the accessible names are "Palette 1" to "Palette 4"). The current set is marked by a check and `aria-checked`; a click
 * replaces the five colours at once and never touches an annotation. Arrow keys move over the rows.
 */
export function PaletteChooser({
  triggerAttrs,
  disabled = false,
}: {
  triggerAttrs?: Record<string, string>;
  disabled?: boolean;
}) {
  const t = useT();
  const active = usePaletteSet((state) => state.set);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const rows = itemsOf(event.currentTarget, '[role="radio"]');
    const at = rows.findIndex((row) => row === event.target);
    if (at < 0) return;
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + step))]?.focus();
  };

  return (
    <Popover
      label={t('palette.choose')}
      disabled={disabled}
      trigger={(trigger) => (
        <Tooltip label={t('palette.choose')}>
          <button
            {...trigger}
            {...triggerAttrs}
            type="button"
            aria-label={t('palette.choose')}
            aria-disabled={disabled ? true : undefined}
            data-palette-chooser=""
            className={cx(
              'relative mx-1 flex size-swatch shrink-0 cursor-pointer items-center justify-center rounded-pill border border-control-border bg-surface text-text',
              'hover:border-text aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)',
              "before:absolute before:-inset-1 before:content-['']",
            )}
          >
            <Icon icon={Palette} />
          </button>
        </Tooltip>
      )}
    >
      {(api) => (
        <div role="radiogroup" aria-label={t('palette.choose')} onKeyDown={onKeyDown} className="flex flex-col gap-1">
          {PALETTE_SET_NAMES.map((name, index) => {
            const checked = name === active;
            const label = t(PRESET_KEYS[index] ?? 'palette.preset1');
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={label}
                tabIndex={checked ? 0 : -1}
                data-palette-set={name}
                onClick={() => {
                  usePaletteSet.getState().choose(name);
                  api.close('select');
                }}
                className={cx(
                  'flex h-control-md cursor-pointer items-center gap-2 rounded-button border px-2 hover:bg-subtle',
                  checked ? 'border-text bg-selected' : 'border-transparent',
                )}
              >
                <span aria-hidden="true" className="flex items-center gap-1">
                  {PALETTE_SETS[name].highlight.map((colour) => (
                    <span
                      key={colour.id}
                      className="block size-4 rounded-pill border border-control-border"
                      style={{ backgroundColor: rgbToCss(colour.rgb) }}
                    />
                  ))}
                </span>
                {checked && <Icon icon={Check} />}
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
