import { useId, type KeyboardEvent } from 'react';

import type { Rgb } from '../../api/annotations';
import { Swatch, Tooltip } from '../../components';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import type { CreationKind } from '../../stores/tools';
import { PALETTES, type PaletteColour } from '../inspector/palette';
import { paletteNameOf, sameRgb } from '../inspector/palette';
import { styleFor, useStyleStore } from '../inspector/style';

export interface ColourRowProps {
  /** The annotation kinds the row sets (Formen sets all four shapes); the first one shows the current colour. */
  kinds: readonly CreationKind[];
}

/**
 * The swatch row of a colour tool's split menu (DESIGN v2 3.2, 1.4): the palette of the tool's kind, the colour a new annotation of it
 * gets (last used wins, DESIGN 3.3). A radio group: one tab stop, the arrows choose.
 */
export function ColourRow({ kinds }: ColourRowProps) {
  const t = useT();
  const labelId = useId();
  const first = kinds[0] ?? 'ink';
  const palette: readonly PaletteColour[] = PALETTES[paletteNameOf(first)];
  const current: Rgb = useStyleStore((state) => styleFor(first, state.overrides).color);
  const checked = palette.find((colour) => sameRgb(colour.rgb, current));

  const choose = (colour: PaletteColour) => {
    for (const kind of kinds) useStyleStore.getState().set(kind, { color: colour.rgb });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const group = event.currentTarget;
    if (!isOwnEvent(group, event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const radios = itemsOf(group, '[role="radio"]');
    const at = radios.findIndex((radio) => radio === event.target);
    const key = event.key === 'ArrowUp' ? 'ArrowLeft' : event.key === 'ArrowDown' ? 'ArrowRight' : event.key;
    const target = rovingTarget(key, at, radios.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    radios[target]?.focus();
    const colour = palette[target];
    if (colour !== undefined) choose(colour);
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <span id={labelId} className="t-caption text-text-muted">
        {t('modes.colour')}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown} className="flex gap-2">
        {palette.map((colour, index) => (
          <Tooltip key={colour.id} label={t(colour.nameKey)}>
            <Swatch
              label={t(colour.nameKey)}
              checked={colour === checked}
              fillClass={colour.bg}
              checkClass={colour.check}
              tabIndex={colour === checked || (checked === undefined && index === 0) ? 0 : -1}
              onClick={() => choose(colour)}
            />
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
