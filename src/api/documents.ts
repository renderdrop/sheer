import { invoke } from '@tauri-apps/api/core';

import { toAppError } from './errors';

/** Result of opening a document. `id` is opaque; the frontend never sees file paths. */
export interface DocumentInfo {
  id: number;
  pageCount: number;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toAppError(error);
  }
}

/** Shows the native open dialog. Resolves to `null` if the user cancels. */
export function openDocumentDialog(): Promise<DocumentInfo | null> {
  return call<DocumentInfo | null>('open_document_dialog');
}

/**
 * Renders one page to PNG. `scale` is device pixels per PDF point (1 = 72 dpi); the backend accepts 0.1 to 8.
 * Tauri delivers the raw response body as an ArrayBuffer.
 */
export async function renderPage(docId: number, pageIndex: number, scale: number): Promise<Uint8Array<ArrayBuffer>> {
  const body = await call<ArrayBuffer>('render_page', { docId, pageIndex, scale });
  return new Uint8Array(body);
}

export function closeDocument(docId: number): Promise<void> {
  return call<void>('close_document', { docId });
}
