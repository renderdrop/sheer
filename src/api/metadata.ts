import { applyCommand, type ChangeSet } from './annotations';
import { call } from './call';
import { toAppError } from './errors';
import { isRecord, isUint } from './wire';

/**
 * Document metadata (ARCHITECTURE section 5, "Edit and protect"; ADR-047 section 5; src-tauri/src/commands/metadata.rs). `getMetadata`
 * reads the file once; `setMetadata` and `removeMetadata` are undoable commands that take effect on the next save. All text comes from
 * the file: show it as text only.
 */

/** Longest value of an editable field in characters (`MAX_METADATA_FIELD_CHARS`). */
export const MAX_METADATA_FIELD_CHARS = 1_000;

export type MetadataPending = 'none' | 'edited' | 'remove';

export interface DocMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  /** ISO 8601, or `null` if the file has none or it could not be read. */
  created: string | null;
  modified: string | null;
  pdfVersion: string;
  fileBytes: number;
  /** The XMP packet is only looked at for its presence and size, never parsed. */
  xmp: { present: boolean; bytes: number };
  /** A field was longer than the limit and was cut. */
  truncated: boolean;
  pending: MetadataPending;
}

/** A change to the editable fields: a string sets it, `null` clears it, a missing key leaves it. At most 1 000 characters, controls stripped. */
export type MetadataPatch = Partial<Record<'title' | 'author' | 'subject' | 'keywords', string | null>>;

const TEXT_KEYS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'created', 'modified'] as const;
const PENDING: ReadonlySet<unknown> = new Set<MetadataPending>(['none', 'edited', 'remove']);

/** Validates the answer of `get_metadata`; `null` if it is not a `DocMetadata`. Extra keys are dropped. */
export function parseDocMetadata(value: unknown): DocMetadata | null {
  if (!isRecord(value)) return null;
  const text: Partial<Record<(typeof TEXT_KEYS)[number], string | null>> = {};
  for (const key of TEXT_KEYS) {
    const field = value[key];
    // A UTF-16 string of N characters is at most 2N units.
    if (!(field === null || (typeof field === 'string' && field.length <= 2 * MAX_METADATA_FIELD_CHARS))) return null;
    text[key] = field;
  }
  const { pdfVersion, fileBytes, xmp, truncated, pending } = value;
  if (
    typeof pdfVersion !== 'string' ||
    pdfVersion.length > 16 ||
    !isUint(fileBytes, Number.MAX_SAFE_INTEGER) ||
    !isRecord(xmp) ||
    typeof xmp.present !== 'boolean' ||
    !isUint(xmp.bytes, Number.MAX_SAFE_INTEGER) ||
    typeof truncated !== 'boolean' ||
    !PENDING.has(pending)
  )
    return null;
  return {
    ...(text as Record<(typeof TEXT_KEYS)[number], string | null>),
    pdfVersion,
    fileBytes,
    xmp: { present: xmp.present, bytes: xmp.bytes },
    truncated,
    pending: pending as MetadataPending,
  };
}

/** The document's metadata with what is staged. The first call reads the file (up to 30 s). */
export async function getMetadata(docId: number): Promise<DocMetadata> {
  const metadata = parseDocMetadata(await call<unknown>('get_metadata', { docId }));
  if (metadata === null) throw toAppError(null);
  return metadata;
}

/** Edits the title, author, subject or keywords as one undo step (`metadata.set`); `changes.doc` has `metadata`. */
export function setMetadata(docId: number, patch: MetadataPatch): Promise<ChangeSet> {
  return applyCommand(docId, { type: 'setMetadata', patch });
}

/** Stages the removal of all metadata as one undo step (`metadata.remove`); the next save is a full rewrite. */
export function removeMetadata(docId: number): Promise<ChangeSet> {
  return applyCommand(docId, { type: 'removeMetadata' });
}
