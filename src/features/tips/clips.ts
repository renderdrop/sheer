import type { TipId } from './model';

/**
 * The clip assets of the four clip tips (DESIGN 3.13): `src/assets/tips/{id}.png` (an APNG, `num_plays` 1) and `{id}-poster.png`
 * (its last frame). A glob, so a missing file is not a build error: the tip is then the text-only card (C3 "Error").
 */
const assets = import.meta.glob<string>('../../assets/tips/*.png', { eager: true, query: '?url', import: 'default' });

function find(name: string): string | null {
  const key = Object.keys(assets).find((path) => path.endsWith(`/${name}.png`));
  return key === undefined ? null : (assets[key] ?? null);
}

export interface Clip {
  /** The animation. */
  src: string;
  /** Its last frame: shown with reduced motion and when the animation fails after the tip showed. */
  poster: string;
}

/** The clip of a tip, or `null` when it has none (or its files are missing). Tests mock this module. */
export function clipOf(id: TipId): Clip | null {
  const src = find(id);
  const poster = find(`${id}-poster`);
  return src === null || poster === null ? null : { src, poster };
}
