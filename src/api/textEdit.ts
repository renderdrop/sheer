import { call } from './call';
import { toAppError } from './errors';
import { MAX_TEXT_CHARS } from './text';
import { isRecord, isUint, parseRect, type Rect } from './wire';

/**
 * Editing existing text (ADR-125, ARCHITECTURE section 13.5; src-tauri/src/commands/text_edit.rs): which lines of a page can be edited, and
 * the `editTextLine` command (a member of `DocCommand`, sent with `applyCommand`). A line is named by a `LineKey` that is only valid
 * for one edit revision of its page. Input and answers are plain data; the file never reaches the UI.
 */

/** Most characters in the text of one line (`TEXT_EDIT_LINE_CHARS`). */
export const MAX_LINE_CHARS = 2_000;
/** Most lines `textEditLines` returns for a page (`TEXT_EDIT_LINES_PER_PAGE`). */
export const MAX_LINES_PER_PAGE = 5_000;

/** Names a line: `rev` is the page's edit revision, `line` the index in reading order. */
export interface LineKey {
  rev: number;
  line: number;
}

/** Why a line cannot be edited; the UI maps it to a refusal tooltip (DESIGN 3.10 E5). */
export type TextEditRefusal =
  | 'signed'
  | 'permission'
  | 'type3'
  | 'invisible'
  | 'clip'
  | 'vertical'
  | 'cmap'
  | 'inForm'
  | 'actualText'
  | 'script'
  | 'notFileSource'
  | 'unmapped'
  | 'tooComplex';

/** The bundled substitute family: Arimo, Tinos or Cousine. */
export type FallbackFace = 'sans' | 'serif' | 'mono';

/** Whether the line can be edited, and in which font the new text would be drawn. */
export type LineEditable =
  { type: 'same' } | { type: 'fallback'; face: FallbackFace } | { type: 'no'; reason: TextEditRefusal };

export type LineAlign = 'left' | 'center' | 'right';

/** One line of text on a page. `text` is the document's: render it as text only. */
export interface TextLineInfo {
  key: LineKey;
  /** At most 2 000 characters. */
  text: string;
  /** The union of the glyph boxes, in page space. */
  box: Rect;
  /** Index of the paragraph the line belongs to (reading order). */
  paragraph: number;
  justified: boolean;
  /** Alignment of the line's paragraph; absent means left. */
  align?: LineAlign;
  /** `name` is for display: the subset tag is removed; `subset` tells it was there. */
  font: { name: string; size: number; embedded: boolean; subset?: boolean };
  editable: LineEditable;
}

/** The answer of `textEditLines`: every line of the page in reading order (page, paragraph, line). */
export interface PageTextLines {
  lines: readonly TextLineInfo[];
}

/** The `DocCommand` that replaces the text of a line. One committed line is one undo step (label `editText.undo`). */
export interface EditTextLine {
  type: 'editTextLine';
  pageId: number;
  key: LineKey;
  /** At most 2 000 characters; an empty text removes the line. */
  text: string;
  fit: 'keepStart' | 'squeeze';
  /** `paragraph` (re-break) arrives with v1.5.2. */
  scope: 'line' | 'paragraph';
}

/** What an applied edit tells besides the change (`ChangeSet.warnings`). */
export type ChangeWarning = 'textOverflow' | 'fontFallback';

// --- Parsers ---------------------------------------------------------------------------------------------------------

const REFUSALS: ReadonlySet<unknown> = new Set<TextEditRefusal>([
  'signed',
  'permission',
  'type3',
  'invisible',
  'clip',
  'vertical',
  'cmap',
  'inForm',
  'actualText',
  'script',
  'notFileSource',
  'unmapped',
  'tooComplex',
]);
const FACES: ReadonlySet<unknown> = new Set<FallbackFace>(['sans', 'serif', 'mono']);
const WARNINGS: ReadonlySet<unknown> = new Set<ChangeWarning>(['textOverflow', 'fontFallback']);

/** Validates a line key; `null` if it is not one. */
export function parseLineKey(value: unknown): LineKey | null {
  if (!isRecord(value)) return null;
  const { rev, line } = value;
  return isUint(rev) && isUint(line, MAX_LINES_PER_PAGE) ? { rev, line } : null;
}

function parseEditable(value: unknown): LineEditable | null {
  if (!isRecord(value)) return null;
  if (value.type === 'same') return { type: 'same' };
  if (value.type === 'fallback' && FACES.has(value.face)) return { type: 'fallback', face: value.face as FallbackFace };
  if (value.type === 'no' && REFUSALS.has(value.reason)) return { type: 'no', reason: value.reason as TextEditRefusal };
  return null;
}

/** Validates one line; `null` if it is not one. Extra keys are dropped. */
export function parseTextLineInfo(value: unknown): TextLineInfo | null {
  if (!isRecord(value)) return null;
  const { text, paragraph, justified, font } = value;
  const key = parseLineKey(value.key);
  const box = parseRect(value.box);
  const editable = parseEditable(value.editable);
  if (key === null || box === null || editable === null) return null;
  if (typeof text !== 'string' || text.length > MAX_LINE_CHARS || text.length > MAX_TEXT_CHARS) return null;
  if (!isUint(paragraph, MAX_LINES_PER_PAGE) || typeof justified !== 'boolean' || !isRecord(font)) return null;
  const { name, size, embedded, subset } = font;
  if (typeof name !== 'string' || name.length > 256 || typeof embedded !== 'boolean') return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  const align: LineAlign = value.align === 'center' || value.align === 'right' ? value.align : 'left';
  return {
    key,
    text,
    box,
    paragraph,
    justified,
    align,
    font: { name, size, embedded, subset: subset === true },
    editable,
  };
}

/** Validates the answer of `text_edit_lines`: at most 5 000 lines; `null` if it is not that. */
export function parsePageTextLines(value: unknown): PageTextLines | null {
  if (!isRecord(value) || !Array.isArray(value.lines) || value.lines.length > MAX_LINES_PER_PAGE) return null;
  const lines: TextLineInfo[] = [];
  for (const item of value.lines as unknown[]) {
    const line = parseTextLineInfo(item);
    if (line === null) return null;
    lines.push(line);
  }
  return { lines };
}

/** The known warnings of a change set; unknown ones are dropped (a note is never worth an error). */
export function parseChangeWarnings(value: unknown): ChangeWarning[] {
  return Array.isArray(value) ? (value as unknown[]).filter((w): w is ChangeWarning => WARNINGS.has(w)) : [];
}

// --- Commands --------------------------------------------------------------------------------------------------------

/**
 * The line at UTF-16 index `unit` of the page's text layer (`TextLayer.text`). An answer that does not have the documented shape is an
 * internal error. Rejects with `invalid_argument` for a page or index that does not exist and `not_found` for a document that is
 * not open. A line that cannot be edited is an answer (`editable.type === 'no'`), not a rejection.
 */
export async function textEditProbe(docId: number, pageId: number, unit: number): Promise<TextLineInfo> {
  const info = parseTextLineInfo(await call<unknown>('text_edit_probe', { docId, pageId, unit }));
  if (info === null) throw toAppError(null);
  return info;
}

/** Every line of a page in reading order, for keyboard navigation. Same errors as `textEditProbe`. */
export async function textEditLines(docId: number, pageId: number): Promise<PageTextLines> {
  const lines = parsePageTextLines(await call<unknown>('text_edit_lines', { docId, pageId }));
  if (lines === null) throw toAppError(null);
  return lines;
}
