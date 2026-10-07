import type { AppEvent } from './app';
import { call } from './call';
import { toAppError } from './errors';
import type { PageSelection } from './pageSelection';
import { isRecord, isUint } from './wire';

/**
 * Text recognition for scans (ADR-134, ARCHITECTURE section 15; src-tauri/src/commands/ocr.rs). The recognized text never crosses
 * this boundary: the backend keeps it in the document and writes it at the next save. The UI only learns ids, counts and classes.
 * Progress arrives as `ocrProgress` and `ocrFinished` pushes on the channel of `subscribeApp`; `handleOcrEvent` sorts them out.
 */

export type OcrBackend = 'windows' | 'vision' | 'none';
export type OcrLanguageTag = 'de-DE' | 'en-US';
export type PageOcrClass = 'scan' | 'hasTextLayer' | 'sheerLayer' | 'text' | 'empty';

export interface OcrLanguage {
  tag: OcrLanguageTag;
  available: boolean;
}

export interface OcrCapabilities {
  backend: OcrBackend;
  languages: OcrLanguage[];
  /** The longest side the recognizer takes, in pixels; `null` without a recognizer. */
  maxImageDimension: number | null;
}

export interface PageClass {
  page: number;
  class: PageOcrClass;
}

/** `languageFallback`: the requested language is not installed and `langUsed` is another one. */
export type OcrNotice = 'languageFallback';

export interface OcrStarted {
  job: number;
  langUsed: OcrLanguageTag;
  notice: OcrNotice | null;
}

export interface OcrProgress {
  type: 'ocrProgress';
  doc: number;
  job: number;
  done: number;
  total: number;
  failed: number;
}

/** Sent once per job, also after a cancel or when every page failed. `skipped` pages were not scans (or already had a layer). */
export interface OcrFinished {
  type: 'ocrFinished';
  doc: number;
  job: number;
  applied: number;
  skipped: number;
  failed: number;
}

export type OcrEvent = OcrProgress | OcrFinished;

const BACKENDS: readonly unknown[] = ['windows', 'vision', 'none'];
const TAGS: readonly unknown[] = ['de-DE', 'en-US'];
const CLASSES: readonly unknown[] = ['scan', 'hasTextLayer', 'sheerLayer', 'text', 'empty'];
/** Most languages and pages an answer may list (`MAX_PAGES` in limits.rs). */
const MAX_LANGUAGES = 8;
const MAX_PAGES = 50_000;

function bad(what: string): never {
  throw toAppError(new Error(`ocr: unexpected ${what}`));
}

export function parseOcrCapabilities(value: unknown): OcrCapabilities {
  if (!isRecord(value) || !BACKENDS.includes(value.backend)) return bad('capabilities');
  const { languages, maxImageDimension } = value;
  if (!Array.isArray(languages) || languages.length > MAX_LANGUAGES) return bad('languages');
  const parsed = languages.map((entry): OcrLanguage => {
    if (!isRecord(entry) || !TAGS.includes(entry.tag) || typeof entry.available !== 'boolean') return bad('language');
    return { tag: entry.tag as OcrLanguageTag, available: entry.available };
  });
  if (maxImageDimension !== null && !isUint(maxImageDimension)) return bad('maxImageDimension');
  return { backend: value.backend as OcrBackend, languages: parsed, maxImageDimension };
}

export function parsePageClasses(value: unknown): PageClass[] {
  if (!Array.isArray(value) || value.length > MAX_PAGES) return bad('classes');
  return value.map((entry): PageClass => {
    if (!isRecord(entry) || !isUint(entry.page) || !CLASSES.includes(entry.class)) return bad('class');
    return { page: entry.page, class: entry.class as PageOcrClass };
  });
}

export function parseOcrStarted(value: unknown): OcrStarted {
  if (
    !isRecord(value) ||
    !isUint(value.job) ||
    !TAGS.includes(value.langUsed) ||
    !(value.notice === null || value.notice === 'languageFallback')
  ) {
    return bad('start answer');
  }
  return { job: value.job, langUsed: value.langUsed as OcrLanguageTag, notice: value.notice };
}

/** An `ocrProgress` or `ocrFinished` push; `null` for anything else (including counts that are not whole numbers). */
export function parseOcrEvent(message: unknown): OcrEvent | null {
  if (!isRecord(message)) return null;
  const { type, doc, job } = message;
  if (!isUint(doc) || !isUint(job)) return null;
  if (type === 'ocrProgress') {
    const { done, total, failed } = message;
    return isUint(done) && isUint(total) && isUint(failed) ? { type, doc, job, done, total, failed } : null;
  }
  if (type === 'ocrFinished') {
    const { applied, skipped, failed } = message;
    return isUint(applied) && isUint(skipped) && isUint(failed) ? { type, doc, job, applied, skipped, failed } : null;
  }
  return null;
}

export interface OcrHandlers {
  onProgress?: (event: OcrProgress) => void;
  onFinished?: (event: OcrFinished) => void;
}

/**
 * Turns the handlers into a listener for `subscribeApp`: `subscribeApp((event) => { handle(event); ... })`. Events of other kinds are
 * ignored. Returns whether the event was an OCR event.
 */
export function handleOcrEvent(event: AppEvent, handlers: OcrHandlers): boolean {
  if (event.type === 'ocrProgress') handlers.onProgress?.(event);
  else if (event.type === 'ocrFinished') handlers.onFinished?.(event);
  else return false;
  return true;
}

/** What the recognizer of this computer can do. */
export async function ocrCapabilities(): Promise<OcrCapabilities> {
  return parseOcrCapabilities(await call<unknown>('ocr_capabilities'));
}

/** The OCR class of each page asked for (all pages without `pages`), by page id. */
export async function ocrClassifyPages(docId: number, pages?: number[]): Promise<PageClass[]> {
  const args: Record<string, unknown> = pages === undefined ? { docId } : { docId, pages };
  return parsePageClasses(await call<unknown>('ocr_classify_pages', args));
}

/**
 * Starts recognition on pages. Refused: `read_only` (signed, or the file forbids editing), `unsupported_feature` (`ocrUnavailable`:
 * no OCR language on this computer), `limit_exceeded` (a job runs), `invalid_argument`. `redo` also takes pages that have a layer
 * of this session.
 */
export async function ocrStart(
  docId: number,
  pages: PageSelection,
  lang: OcrLanguageTag,
  redo: boolean,
): Promise<OcrStarted> {
  return parseOcrStarted(await call<unknown>('ocr_start', { docId, pages, lang, redo }));
}

/** Stops a job after its current page; pages that are done stay applied. An unknown job is not an error. */
export async function ocrCancel(job: number): Promise<void> {
  await call<void>('ocr_cancel', { job });
}

/** Opens the system's language settings (Windows; the target is fixed in the backend). Refused elsewhere (`unsupported_feature`). */
export async function openLanguageSettings(): Promise<void> {
  await call<void>('ocr_open_language_settings');
}
