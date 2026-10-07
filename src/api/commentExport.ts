import { call } from './call';
import { newChannel, parseJobId, type JobEvent, type JobId } from './jobs';
import type { PageSelection } from './pageSelection';

/*
 * Comment export (docs/ARCHITECTURE.md section 16.3, DESIGN 3.16; commands/comment_export.rs): the comments, citations and
 * highlights of the selected pages as a PDF summary or a Markdown file, written to a file chosen in Rust's save dialog. Rust gathers
 * and reads the quotes; the UI sends the filter, the format, the language and the citation lines formatted by `format/` (never bytes
 * or paths).
 */

export type CommentExportFormat = 'pdf' | 'markdown';

/**
 * What goes in: `comments` (notes, text comments and text markup that has a comment), `highlights` (also underline and strikethrough),
 * `citations`, `stamps`, `shapes` (rectangle, ellipse, line) and `drawings` (freehand). Signatures and form content never.
 */
export const COMMENT_EXPORT_INCLUDE = ['comments', 'highlights', 'citations', 'stamps', 'shapes', 'drawings'] as const;
export type CommentExportInclude = (typeof COMMENT_EXPORT_INCLUDE)[number];

export type CommentExportStatus = 'all' | 'open' | 'resolved';

/** The citation line (DESIGN 3.17) for the citation annotation `id`; any annotation of a citation group stands for the group. */
export interface CommentCitationLine {
  id: number;
  text: string;
}

export interface CommentExportOptions {
  format: CommentExportFormat;
  /** At least one. */
  include: readonly CommentExportInclude[];
  pages: PageSelection;
  lang: 'en' | 'de';
  /** Authors to take; `''` is "no author". Absent: all. */
  authors?: readonly string[];
  /** Tags to take, ignoring case; `''` is "untagged". Absent: all. */
  tags?: readonly string[];
  /** Absent: all. */
  status?: CommentExportStatus;
  /** Formatted citation lines (the UI owns the citation styles). */
  citationLines?: readonly CommentCitationLine[];
}

/**
 * Validates, shows Rust's save dialog (`<name> – comments.pdf|.md`) and starts the job. Progress and the result come on `onEvent`
 * (phases `read` and `write`; `done.outputs` is 1, or 0 with the warning `nothingToExport`; further warnings `quotesOmitted` and
 * `glyphsReplaced`). Resolves to `null` when the dialog was cancelled. Rejects with `invalid_argument` (`include`, `lang`,
 * `pageSelection`, `exportTarget`), `limit_exceeded` `commentExport` (too many items, a second export of the document at once) or
 * `engine_timeout` (ask again).
 */
export async function exportComments(
  docId: number,
  opts: CommentExportOptions,
  onEvent: (event: JobEvent) => void,
): Promise<JobId | null> {
  return parseJobId(await call<unknown>('export_comments', { docId, opts, onEvent: newChannel(onEvent) }));
}
