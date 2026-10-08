import type { Rgb } from '../../api/annotations';
import { TAG_PALETTE } from '../../api/cite';
import { cx } from '../../components/cx';
import type { PlainKey } from '../../i18n';
import { PALETTES } from '../inspector/palette';

/** The five colours a tag may have (DESIGN 3.7 C6): the highlight swatches, with their fill classes and names. */
export const TAG_COLOURS: readonly { fill: string; name: PlainKey }[] = PALETTES.highlight.map((colour) => ({
  fill: colour.bg,
  name: colour.nameKey,
}));

/** The index of `color` in the palette, or -1 (an unknown colour reads as neutral). */
export function paletteIndex(color: Rgb | null): number {
  if (color === null) return -1;
  return TAG_PALETTE.findIndex((entry) => entry[0] === color[0] && entry[1] === color[1] && entry[2] === color[2]);
}

/** The fill class of a tag colour; neutral when it is none of the five. */
export function fillOf(color: Rgb | null): string {
  return TAG_COLOURS[paletteIndex(color)]?.fill ?? 'bg-subtle';
}

/** The colour dot of a tag (DESIGN 3.7 C6): `--tag-dot` wide, in the tag colour, with a 1 px Stone ring. Decorative: the name carries the meaning. */
export function TagDot({ color, className }: { color: Rgb | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-[var(--tag-dot,var(--space-2))] shrink-0 rounded-pill ring-1 ring-control-border',
        fillOf(color),
        className,
      )}
    />
  );
}
