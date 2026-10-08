import { call } from './call';
import { newChannel, parseJobId, type JobEvent, type JobId } from './jobs';

/*
 * "Save as text PDF" (F19.22; docs/ARCHITECTURE.md section 15.6; commands/text_pdf.rs): the recognized text of the document as a new
 * PDF of flowing text, headings and paragraphs by the recognized size, in Inter or Tinos, optionally with each original page as a
 * picture after its text. Rust reads the text, asks for the target in its own save dialog and writes the file; the UI sends the
 * options only (never bytes or paths).
 */

export type TextPdfFont = 'inter' | 'tinos';

export interface TextPdfOptions {
  font: TextPdfFont;
  /** Each page's text is followed by the original page as a picture. */
  keepImages: boolean;
  /** The language of the suggested file name. */
  lang: 'en' | 'de';
}

/**
 * Validates, shows Rust's save dialog (`<name> – text.pdf`) and starts the job. Progress and the result come on `onEvent` (phases
 * `read`, `render` with kept pictures, `write`; `done.outputs` is 1, or 0 with the warning `nothingToExport`; `glyphsReplaced` when
 * the face lacks a character). Resolves to `null` when the dialog was cancelled. Rejects with `invalid_argument` (`lang`,
 * `exportTarget`), `read_only` (`permission`: the file forbids copying), `limit_exceeded` (`textPdf`: a second export of the
 * document at once, or the output is too large) or `engine_timeout` (ask again).
 */
export async function exportTextPdf(
  docId: number,
  opts: TextPdfOptions,
  onEvent: (event: JobEvent) => void,
): Promise<JobId | null> {
  return parseJobId(await call<unknown>('export_text_pdf', { docId, opts, onEvent: newChannel(onEvent) }));
}
