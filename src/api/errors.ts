/** Mirrors `ErrorCode` in src-tauri/src/error.rs. */
export type ErrorCode =
  | 'unknown_document'
  | 'page_out_of_range'
  | 'scale_out_of_range'
  | 'render_too_large'
  | 'file_unreadable'
  | 'invalid_pdf'
  | 'password_required'
  | 'unsupported'
  | 'too_many_documents'
  | 'engine_unavailable'
  | 'engine_timeout'
  | 'internal';

/** What every rejected IPC call is turned into. `message` is a fixed English string from the backend, without paths. */
export interface AppError {
  code: ErrorCode;
  message: string;
}

const GENERIC: AppError = { code: 'internal', message: 'Something went wrong.' };

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'unknown_document',
  'page_out_of_range',
  'scale_out_of_range',
  'render_too_large',
  'file_unreadable',
  'invalid_pdf',
  'password_required',
  'unsupported',
  'too_many_documents',
  'engine_unavailable',
  'engine_timeout',
  'internal',
]);

/** Normalizes whatever `invoke` rejected with. Anything that is not a backend `{ code, message }` becomes generic. */
export function toAppError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && CODES.has(code) && typeof message === 'string') {
      return { code: code as ErrorCode, message };
    }
  }
  return GENERIC;
}
