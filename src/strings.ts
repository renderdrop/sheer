import type { AppError, ErrorCode } from './api/errors';

/** User-facing text per backend error code (`error.<code>` in the i18n scaffold). Exhaustive by construction. */
const errorMessages: Record<ErrorCode, string> = {
  invalid_argument: 'That request was not valid.',
  limit_exceeded: 'A size or count limit was reached.',
  not_found: 'That item is no longer available.',
  not_a_pdf: 'This file is not a valid PDF.',
  damaged_file: 'This PDF is damaged and could not be displayed.',
  too_large: 'This file is too large to open.',
  unsupported_feature: 'This PDF is not supported.',
  password_required: 'This PDF is password protected.',
  io_permission_denied: 'This file cannot be read: access was denied.',
  io_not_found: 'The file could not be found.',
  io_in_use: 'The file is in use by another program. Close it there and try again.',
  engine_timeout: 'The PDF engine took too long to respond.',
  engine_crashed: 'The PDF engine hit a problem with this document. Open it again to retry.',
  engine_unavailable: 'The PDF engine is not available.',
  internal: 'Something went wrong.',
};

/** More specific texts for codes that cover several cases, keyed `<code>.<params.what>`. */
const errorDetailMessages: Readonly<Record<string, string>> = {
  'not_found.document': 'This document is no longer open.',
  'invalid_argument.page': 'This page does not exist.',
  'invalid_argument.scale': 'This zoom level is not supported.',
  'limit_exceeded.pixels': 'This page is too large to display at this zoom level.',
  'limit_exceeded.dimension': 'This page is too large to display at this zoom level.',
  'limit_exceeded.documents': 'Too many documents are open. Close one and try again.',
};

function errorMessage(error: AppError): string {
  const what = error.params?.what;
  return (what !== undefined ? errorDetailMessages[`${error.code}.${what}`] : undefined) ?? errorMessages[error.code];
}

/** All user-visible strings in one place until the i18n scaffold (en, de) lands in Phase 3. */
export const strings = {
  toolbarLabel: 'Document controls',
  open: 'Open',
  openHint: 'Open a PDF (Ctrl+O)',
  opening: 'Opening…',
  rendering: 'Rendering…',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  zoomOut: 'Zoom out (Ctrl+−)',
  zoomIn: 'Zoom in (Ctrl++)',
  zoomReset: 'Reset zoom to 100% (Ctrl+0)',
  documentRegion: 'Document',
  emptyTitle: 'No document open',
  emptyHint: 'Open a PDF to start. Nothing leaves your computer.',
  dismiss: 'Dismiss',
  page: (page: number, total: number) => `Page ${page} of ${total}`,
  pageImageAlt: (page: number, total: number) => `Page ${page} of ${total}`,
  noPages: 'This document has no pages.',
  error: errorMessage,
} as const;
