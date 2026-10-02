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
  'invalid_argument.settings': 'That setting is not valid.',
  'limit_exceeded.pixels': 'This page is too large to display at this zoom level.',
  'limit_exceeded.dimension': 'This page is too large to display at this zoom level.',
  'limit_exceeded.documents': 'Too many documents are open. Close one and try again.',
};

function errorMessage(error: AppError): string {
  const what = error.params?.what;
  return (what !== undefined ? errorDetailMessages[`${error.code}.${what}`] : undefined) ?? errorMessages[error.code];
}

/** All user-visible strings in one place until the i18n scaffold (en, de) lands in Phase 3. Shortcuts are not part of them: see src/lib/shortcuts.ts. */
export const strings = {
  // Toolbar (DESIGN 3.3)
  toolbarLabel: 'Tools',
  groupPanels: 'Panels',
  groupSelect: 'Select',
  groupMarkup: 'Markup',
  groupFillAndSign: 'Fill and sign',
  groupPages: 'Pages',
  groupZoom: 'Zoom',
  groupInspector: 'Inspector',
  toolSelect: 'Select',
  toolHighlight: 'Highlight',
  toolComment: 'Comment',
  toolDraw: 'Draw',
  toolForm: 'Form',
  toolSignature: 'Signature',
  toolPages: 'Pages',
  leftPanelToggle: 'Left panel',
  inspectorToggle: 'Inspector',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  zoomLevel: 'Zoom level',
  zoomMenu: 'Zoom',
  zoomActualSize: 'Actual size',
  open: 'Open…',
  opening: 'Opening…',
  rendering: 'Rendering…',

  // Left panel and inspector (DESIGN 3.6, 3.9)
  leftPanel: 'Left panel',
  leftPanelViews: 'Left panel views',
  resizeLeftPanel: 'Resize left panel',
  tabThumbnails: 'Thumbnails',
  tabOutline: 'Outline',
  tabComments: 'Comments',
  tabSearch: 'Search',
  tabThumbnailsEmpty: 'Page thumbnails appear here.',
  tabOutlineEmpty: 'The document outline appears here.',
  tabCommentsEmpty: 'Comments appear here.',
  tabSearchEmpty: 'Search results appear here.',
  inspector: 'Inspector',
  inspectorTitle: 'Tool options',
  inspectorEmpty: 'Select an object or choose a tool to see its options.',

  // Canvas and status bar (DESIGN 2, 3.10)
  documentRegion: 'Document',
  status: 'Status',
  noPages: 'This document has no pages.',
  untitled: 'Untitled',
  goToPage: 'Go to page',
  pageNumber: 'Page number',
  goToPageSubmit: 'Go',
  dropToOpen: 'Drop to open',
  page: (page: number, total: number) => `Page ${page} of ${total}`,
  pageImageAlt: (page: number, total: number) => `Page ${page} of ${total}`,

  // Empty state (DESIGN 3.11)
  emptyTitle: 'Open a PDF',
  emptyHint: 'Drop a file anywhere in this window or choose one.',
  recentHeading: 'Recent',
  recentPlaceholder: 'Files you open appear here.',
  recentPrivacy: 'Recent files are stored only on this device.',

  // Window chrome (DESIGN 2.2)
  windowControls: 'Window controls',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',

  // Banner (DESIGN 3.12)
  dismiss: 'Dismiss',
  error: errorMessage,
} as const;
