import { useId, type KeyboardEvent } from 'react';

import type { Rgb } from '../../api/annotations';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import type { CreationKind } from '../../stores/tools';
import { paletteNameOf } from '../inspector/palette';
import { styleFor, useStyleStore } from '../inspector/style';
import { ColourRow as Swatches } from '../minibar/Controls';

export interface ColourRowProps {
  /** The annotation kinds the row sets (Formen sets all four shapes); the first one shows the current colour. */
  kinds: readonly CreationKind[];
}

/**
 * The swatch row of a colour tool's split menu (DESIGN v2 3.2, 1.4, 3.5 B5): the palette of the tool's kind, up to 3 recent custom
 * colours and "More colours" (the mini bar's control, the same recent list), the colour a new annotation of it gets (last used wins,
 * DESIGN 3.3). A radio group: the arrows choose.
 */
export function ColourRow({ kinds }: ColourRowProps) {
  const t = useT();
  const labelId = useId();
  const first = kinds[0] ?? 'ink';
  const current: Rgb = useStyleStore((state) => styleFor(first, state.overrides).color);

  const choose = (rgb: Rgb) => {
    for (const kind of kinds) useStyleStore.getState().set(kind, { color: rgb });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const group = event.currentTarget;
    if (!isOwnEvent(group, event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const radios = itemsOf(group, '[role="radio"]');
    const at = radios.findIndex((radio) => radio === event.target);
    if (at < 0) return;
    const key = event.key === 'ArrowUp' ? 'ArrowLeft' : event.key === 'ArrowDown' ? 'ArrowRight' : event.key;
    const target = rovingTarget(key, at, radios.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    radios[target]?.focus();
    radios[target]?.click();
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <span id={labelId} className="t-caption text-text-muted">
        {t('modes.colour')}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown} className="flex items-center">
        <Swatches
          palette={paletteNameOf(first)}
          value={{ value: current, mixed: false }}
          disabled={false}
          onChange={choose}
          roving={false}
        />
      </div>
    </div>
  );
}
