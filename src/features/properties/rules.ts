import type { MetadataPatch } from '../../api/metadata';

export interface EditableFields {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

/** The fields that differ from `before`; an emptied field is `null` (cleared). */
export function buildPatch(before: EditableFields, after: EditableFields): MetadataPatch {
  const patch: MetadataPatch = {};
  for (const key of ['title', 'author', 'subject', 'keywords'] as const) {
    if (after[key] !== before[key]) patch[key] = after[key] === '' ? null : after[key];
  }
  return patch;
}

/** An ISO 8601 date as medium date and short time in `locale`; `missing` if there is none, the raw text if it does not parse. */
export function formatDate(iso: string | null, locale: string, missing: string): string {
  if (iso === null) return missing;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
