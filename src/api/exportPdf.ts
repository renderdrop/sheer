import { call } from './call';
import { newChannel, parseJobId, type JobEvent, type JobId } from './jobs';
import type { SaveAck } from './save';

/*
 * Export a copy (docs/ARCHITECTURE.md section 5, "Convert and output", ADR-049; commands/export_pdf.rs): the document as it is now,
 * written to a file chosen in Rust's Save As dialog. The open document and its path stay as they are, and nothing opens.
 */

export interface PdfExportOptions {
  annotations: 'keep' | 'flatten' | 'remove';
  removeMetadata: boolean;
}

/**
 * Starts the export; progress and the result come on `onEvent` (`done.warnings` may hold `signaturesRemoved`). Resolves to `null` when
 * the Save As dialog was cancelled. Rejects with `needs_confirmation` (`breaksSignature`, `rewriteEncrypted`: retry with `ack`),
 * `read_only` `permission` or `invalid_argument` `exportTarget` (the target is the open document).
 */
export async function exportPdf(
  docId: number,
  opts: PdfExportOptions,
  ack: SaveAck,
  onEvent: (event: JobEvent) => void,
): Promise<JobId | null> {
  return parseJobId(await call<unknown>('export_pdf', { docId, opts, ack, onEvent: newChannel(onEvent) }));
}
