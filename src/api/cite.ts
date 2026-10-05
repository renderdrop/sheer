import type { Rgb } from './annotations';
import { isRecord, isUint } from './wire';

/**
 * The small wire shapes of citations and tags that annotations, summaries and settings carry (ADR-119; src-tauri/src/model/quote.rs and
 * tags.rs). `src/api/citations.ts` has the commands. Everything here parses leniently where the file is the source (an unreadable tag
 * is dropped, an unreadable cite record reads as a plain highlight) and strictly where the backend itself made the value.
 */

/** Longest quote of a citation in characters (`limits::CITE_QUOTE_MAX`); a UTF-16 string is at most twice as long in units. */
export const CITE_QUOTE_MAX = 2_000;
/** Most tag definitions, longest tag name in characters, most tags on one annotation (`limits::TAGS_MAX`, `TAG_NAME_MAX`, `TAGS_PER_ANNOT`). */
export const TAGS_MAX = 64;
export const TAG_NAME_MAX = 40;
export const TAGS_PER_ANNOT = 8;

/** What makes a highlight a citation (`Annotation.cite`): its quote and the group a selection across pages shares (8 hex characters). */
export interface Cite {
  quote: string;
  group?: string;
}

/** One tag definition: global, kept in the settings. The colour is one of `TAG_PALETTE`. */
export interface TagDef {
  name: string;
  color: Rgb;
}

/** The five highlight swatches a tag may have (`model::tags::TAG_PALETTE`; a test keeps it equal to the inspector's highlight palette). */
export const TAG_PALETTE: readonly Rgb[] = [
  [255, 248, 77],
  [125, 235, 181],
  [163, 222, 255],
  [255, 199, 215],
  [220, 207, 255],
];

function parseRgb(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [r, g, b] = value as unknown[];
  return isUint(r, 255) && isUint(g, 255) && isUint(b, 255) ? [r, g, b] : null;
}

/** Validates a cite record; `null` for anything that is not one (the annotation then counts as a plain highlight). */
export function parseCite(value: unknown): Cite | null {
  if (!isRecord(value)) return null;
  const { quote, group } = value;
  if (typeof quote !== 'string' || quote.length === 0 || quote.length > 2 * CITE_QUOTE_MAX) return null;
  if (group === undefined || group === null) return { quote };
  if (typeof group !== 'string' || group.length === 0 || group.length > 16) return null;
  return { quote, group };
}

/** The tag names of an annotation: a missing key is none, entries that are not names are dropped, at most `TAGS_PER_ANNOT` stay. */
export function parseTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = (value as unknown[]).filter(
    (name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 2 * TAG_NAME_MAX,
  );
  return names.slice(0, TAGS_PER_ANNOT);
}

/** Validates one tag definition; `null` if it is not one. */
export function parseTagDef(value: unknown): TagDef | null {
  if (!isRecord(value)) return null;
  const { name } = value;
  const color = parseRgb(value.color);
  if (typeof name !== 'string' || name.length === 0 || name.length > 2 * TAG_NAME_MAX || color === null) return null;
  return { name, color };
}

/** Validates the tag list of the settings: at most `TAGS_MAX`. `null` if it is not a list of definitions. */
export function parseTagDefs(value: unknown): TagDef[] | null {
  if (!Array.isArray(value) || value.length > TAGS_MAX) return null;
  const defs: TagDef[] = [];
  for (const item of value as unknown[]) {
    const def = parseTagDef(item);
    if (def === null) return null;
    defs.push(def);
  }
  return defs;
}
