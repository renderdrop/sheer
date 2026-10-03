/**
 * Wire names of the backend's `ErrorCode` (src-tauri/src/error.rs). Keep in sync; `errors.test.ts` fails when a code is added on
 * one side only, and `tsc` fails when a code has no `error.<code>` text in src/i18n/locales/en.json (src/i18n/errors.ts).
 */
export const ERROR_CODES = [
  'invalid_argument',
  'limit_exceeded',
  'not_found',
  'not_a_pdf',
  'damaged_file',
  'too_large',
  'unsupported_feature',
  'password_required',
  'io_permission_denied',
  'io_not_found',
  'io_in_use',
  'io_disk_full',
  'read_only',
  'unsaved_changes',
  'needs_confirmation',
  'save_failed',
  'engine_timeout',
  'engine_crashed',
  'engine_unavailable',
  'cancelled',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whitelisted context from the backend: `what` is a fixed vocabulary word, `limit` the bound that was exceeded. */
export interface ErrorParams {
  what: string;
  limit?: number;
}

/**
 * What every rejected IPC call is turned into. There is no message text: the UI translates `key` (`error.<code>`),
 * and the backend never sends paths, stack traces or internal ids.
 */
export interface AppError {
  code: ErrorCode;
  key: `error.${ErrorCode}`;
  retryable: boolean;
  params?: ErrorParams;
}

const GENERIC: AppError = { code: 'internal', key: 'error.internal', retryable: false };

const CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

/** `what` is a `&'static str` in the backend (a snake_case or lowerCamelCase word); anything else is not from us. */
const WHAT = /^[a-z][a-zA-Z_]{0,31}$/;

function toParams(value: unknown): ErrorParams | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { what, limit } = value as { what?: unknown; limit?: unknown };
  if (typeof what !== 'string' || !WHAT.test(what)) return undefined;
  if (typeof limit === 'number' && Number.isFinite(limit)) return { what, limit };
  return { what };
}

/** Normalizes whatever `invoke` rejected with. Anything that is not a backend `UiError` becomes the generic error. */
export function toAppError(error: unknown): AppError {
  if (typeof error !== 'object' || error === null) return GENERIC;
  const { code, retryable, params } = error as { code?: unknown; retryable?: unknown; params?: unknown };
  if (typeof code !== 'string' || !CODES.has(code)) return GENERIC;
  const known = code as ErrorCode;
  const result: AppError = { code: known, key: `error.${known}`, retryable: retryable === true };
  const parsed = toParams(params);
  if (parsed !== undefined) result.params = parsed;
  return result;
}
