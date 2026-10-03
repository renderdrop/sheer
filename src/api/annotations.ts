import { call } from './call';
import { toAppError } from './errors';
import { parseSlots, type PageCommand, type PageSlotInfo } from './pages';
import {
  isCoordinate,
  isRecord,
  isUint,
  parsePoint,
  parseQuad,
  parseRect,
  type Point,
  type Quad,
  type Rect,
} from './wire';

/**
 * The annotations of a document and the commands that change them (ARCHITECTURE section 5, "Annotations"; ADR-003;
 * src-tauri/src/commands/annotations.rs and src-tauri/src/model). Rust owns the model and the undo history. The UI keeps a replica
 * (`src/stores/annotations.ts`) that it updates only with the `ChangeSet` each command, undo and redo answers with, so it never
 * guesses what the backend did. Every answer goes through a parser here; one that does not have the documented shape is an
 * internal error, like any other malformed answer.
 */

/** Annotations of one document in the model, and of one page (`MAX_ANNOTATIONS_PER_DOC`, `MAX_ANNOTATIONS_PER_PAGE`). */
export const MAX_ANNOTATIONS_PER_DOC = 20_000;
export const MAX_ANNOTATIONS_PER_PAGE = 2_000;
/** Rectangles of one text markup, strokes of one ink annotation, points of one stroke, lines of one free text. */
export const MAX_ANNOT_QUADS = 512;
export const MAX_INK_STROKES = 256;
export const MAX_INK_POINTS_PER_STROKE = 10_000;
export const MAX_FREE_TEXT_LINES = 500;
/** Longest contents of an annotation in characters (`MAX_ANNOT_CONTENTS_CHARS`); a UTF-16 string is at most twice as long in units. */
export const MAX_ANNOT_CONTENTS_CHARS = 32_768;
/** Entries of the undo stack (`MAX_HISTORY_ENTRIES`). */
export const MAX_HISTORY_ENTRIES = 500;

export type Rgb = readonly [number, number, number];
export type LineEnd = 'none' | 'openArrow' | 'closedArrow';
export type NoteIcon = 'comment' | 'note' | 'help';
/** Whether the annotation is in the file as it is: `new` (this session), `clean`, or `modified` (in the file, changed since). */
export type SyncState = 'new' | 'clean' | 'modified';

export interface Stroke {
  points: readonly Point[];
  /** The polygon that is filled (perfect-freehand output); the points are what the user drew. */
  outline: readonly Point[];
}

export interface AnnotationCommon {
  id: number;
  pageId: number;
  /** The bounding box, computed by the backend. */
  rect: Rect;
  color: Rgb;
  opacity: number;
  contents: string;
  author: string | null;
  /** ISO 8601 for what was changed in this session; a PDF date (`D:...`) for what the file says. */
  modified: string | null;
  inReplyTo: number | null;
  locked: boolean;
  sync: SyncState;
}

export type AnnotationBody =
  | { kind: 'highlight' | 'underline' | 'strikeout'; quads: readonly Quad[] }
  | { kind: 'note'; at: Point; icon: NoteIcon }
  | { kind: 'freeText'; box: Rect; lines: readonly string[]; fontSize: number; fill: Rgb | null; borderWidth: number }
  | { kind: 'ink'; strokes: readonly Stroke[]; width: number }
  | { kind: 'rect' | 'ellipse'; box: Rect; width: number; fill: Rgb | null; dashed: boolean }
  | { kind: 'line'; from: Point; to: Point; width: number; head: LineEnd; tail: LineEnd }
  /** An annotation of a kind the app does not edit: shown and selectable, never changed. */
  | { kind: 'opaque'; subtype: string };

export type Annotation = AnnotationCommon & AnnotationBody;
export type AnnotationKind = Annotation['kind'];

/** The kinds the user can create (everything but `opaque`). */
export type DraftBody = Exclude<AnnotationBody, { kind: 'opaque' }>;

/** An annotation to create: the backend assigns `id`, `rect`, `sync` and `modified`. */
export type AnnotationDraft = {
  pageId: number;
  color: Rgb;
  opacity?: number;
  contents?: string;
  author?: string | null;
  inReplyTo?: number | null;
  locked?: boolean;
} & DraftBody;

/**
 * A change to an annotation: only the fields present change; `fill` and `author` may be `null` to clear them. A field that does not
 * belong to the annotation's kind is refused by the backend.
 */
export interface AnnotationPatch {
  color?: Rgb;
  opacity?: number;
  contents?: string;
  author?: string | null;
  locked?: boolean;
  quads?: readonly Quad[];
  at?: Point;
  icon?: NoteIcon;
  box?: Rect;
  lines?: readonly string[];
  fontSize?: number;
  fill?: Rgb | null;
  borderWidth?: number;
  strokes?: readonly Stroke[];
  width?: number;
  dashed?: boolean;
  from?: Point;
  to?: Point;
  head?: LineEnd;
  tail?: LineEnd;
}

/**
 * A command on the document's annotations. One command is one undo step; a `batch` is one step made of several and happens
 * completely or not at all. `label` of a batch is a key of the catalogs (`[A-Za-z0-9._-]`, at most 64 characters), shown with Undo.
 * Updates of one annotation with the same `coalesce` key within 1.5 s are one step (a slider, a colour being dragged).
 */
export type DocCommand =
  | { type: 'createAnnotation'; draft: AnnotationDraft }
  | { type: 'updateAnnotation'; id: number; patch: AnnotationPatch; coalesce?: string }
  | { type: 'deleteAnnotations'; ids: readonly number[] }
  | { type: 'moveAnnotations'; ids: readonly number[]; dx: number; dy: number }
  | { type: 'batch'; label: string; commands: readonly DocCommand[] }
  | PageCommand;

/** What the UI needs for its Undo and Redo commands. */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Keys of the catalogs (`annotation.create`, ...), or a batch's own label. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** There are changes that are not saved. */
  dirty: boolean;
}

/** What a command, an undo or a redo changed. */
export interface ChangeSet {
  /** The revision of the document after the change; it grows with every change, undo and redo. */
  rev: number;
  upserted: readonly Annotation[];
  removed: readonly number[];
  /** The full page list, only when it changed (ADR-036); `null` otherwise. */
  pages: readonly PageSlotInfo[] | null;
  history: HistoryState;
}

// --- Parsers ---------------------------------------------------------------------------------------------------------

const LINE_ENDS: ReadonlySet<unknown> = new Set<LineEnd>(['none', 'openArrow', 'closedArrow']);
const NOTE_ICONS: ReadonlySet<unknown> = new Set<NoteIcon>(['comment', 'note', 'help']);
const SYNC_STATES: ReadonlySet<unknown> = new Set<SyncState>(['new', 'clean', 'modified']);

function parseRgb(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [r, g, b] = value as unknown[];
  return isUint(r, 255) && isUint(g, 255) && isUint(b, 255) ? [r, g, b] : null;
}

function parseOptionalRgb(value: unknown): Rgb | null | undefined {
  return value === null ? null : (parseRgb(value) ?? undefined);
}

function parsePoints(value: unknown, max: number): Point[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const points: Point[] = [];
  for (const item of value as unknown[]) {
    const point = parsePoint(item);
    if (point === null) return null;
    points.push(point);
  }
  return points;
}

function parseStrokes(value: unknown): Stroke[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INK_STROKES) return null;
  const strokes: Stroke[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return null;
    const points = parsePoints(item.points, MAX_INK_POINTS_PER_STROKE);
    const outline = parsePoints(item.outline, MAX_INK_POINTS_PER_STROKE);
    if (points === null || outline === null) return null;
    strokes.push({ points, outline });
  }
  return strokes;
}

function parseQuads(value: unknown): Quad[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANNOT_QUADS) return null;
  const quads: Quad[] = [];
  for (const item of value as unknown[]) {
    const quad = parseQuad(item);
    if (quad === null) return null;
    quads.push(quad);
  }
  return quads;
}

const isWidth = (value: unknown): value is number => isCoordinate(value) && value >= 0;

function parseBody(value: Record<string, unknown>): AnnotationBody | null {
  const { kind } = value;
  switch (kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      const quads = parseQuads(value.quads);
      return quads === null ? null : { kind, quads };
    }
    case 'note': {
      const at = parsePoint(value.at);
      return at !== null && NOTE_ICONS.has(value.icon) ? { kind, at, icon: value.icon as NoteIcon } : null;
    }
    case 'freeText': {
      const box = parseRect(value.box);
      const { lines, fontSize, borderWidth } = value;
      const fill = parseOptionalRgb(value.fill);
      if (
        box === null ||
        fill === undefined ||
        !Array.isArray(lines) ||
        lines.length > MAX_FREE_TEXT_LINES ||
        !(lines as unknown[]).every((line) => typeof line === 'string') ||
        !isWidth(fontSize) ||
        !isWidth(borderWidth)
      )
        return null;
      return { kind, box, lines: lines as string[], fontSize, fill, borderWidth };
    }
    case 'ink': {
      const strokes = parseStrokes(value.strokes);
      return strokes !== null && isWidth(value.width) ? { kind, strokes, width: value.width } : null;
    }
    case 'rect':
    case 'ellipse': {
      const box = parseRect(value.box);
      const fill = parseOptionalRgb(value.fill);
      const { width, dashed } = value;
      return box !== null && fill !== undefined && isWidth(width) && typeof dashed === 'boolean'
        ? { kind, box, width, fill, dashed }
        : null;
    }
    case 'line': {
      const from = parsePoint(value.from);
      const to = parsePoint(value.to);
      const { width, head, tail } = value;
      return from !== null && to !== null && isWidth(width) && LINE_ENDS.has(head) && LINE_ENDS.has(tail)
        ? { kind, from, to, width, head: head as LineEnd, tail: tail as LineEnd }
        : null;
    }
    case 'opaque':
      return typeof value.subtype === 'string' ? { kind, subtype: value.subtype } : null;
    default:
      return null;
  }
}

/** Validates one annotation; `null` if it is not one. Keys that are not part of it are dropped. */
export function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value)) return null;
  const { id, pageId, opacity, contents, author, modified, inReplyTo, locked, sync } = value;
  const rect = parseRect(value.rect);
  const color = parseRgb(value.color);
  const body = parseBody(value);
  if (
    !isUint(id) ||
    !isUint(pageId) ||
    rect === null ||
    color === null ||
    body === null ||
    typeof opacity !== 'number' ||
    !(opacity >= 0 && opacity <= 1) ||
    typeof contents !== 'string' ||
    contents.length > 2 * MAX_ANNOT_CONTENTS_CHARS ||
    !(author === null || typeof author === 'string') ||
    !(modified === null || typeof modified === 'string') ||
    !(inReplyTo === null || isUint(inReplyTo)) ||
    typeof locked !== 'boolean' ||
    !SYNC_STATES.has(sync)
  )
    return null;
  return {
    id,
    pageId,
    rect,
    color,
    opacity,
    contents,
    author,
    modified,
    inReplyTo,
    locked,
    sync: sync as SyncState,
    ...body,
  };
}

/** Validates the answer of `list_annotations`: at most 2 000 annotations. `null` if it is not a list of annotations. */
export function parseAnnotations(value: unknown): Annotation[] | null {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS_PER_PAGE) return null;
  const annotations: Annotation[] = [];
  for (const item of value as unknown[]) {
    const annotation = parseAnnotation(item);
    if (annotation === null) return null;
    annotations.push(annotation);
  }
  return annotations;
}

function parseLabel(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined;
}

/** Validates the history part of a change set; `null` if it is not one. */
export function parseHistoryState(value: unknown): HistoryState | null {
  if (!isRecord(value)) return null;
  const { canUndo, canRedo, dirty } = value;
  const undoLabel = parseLabel(value.undoLabel);
  const redoLabel = parseLabel(value.redoLabel);
  if (
    typeof canUndo !== 'boolean' ||
    typeof canRedo !== 'boolean' ||
    typeof dirty !== 'boolean' ||
    undoLabel === undefined ||
    redoLabel === undefined
  )
    return null;
  return { canUndo, canRedo, undoLabel, redoLabel, dirty };
}

/** Validates the answer of `apply_command`, `undo` and `redo`; `null` if it is not a change set. */
export function parseChangeSet(value: unknown): ChangeSet | null {
  if (!isRecord(value)) return null;
  const { rev, upserted, removed, pages } = value;
  const history = parseHistoryState(value.history);
  const parsedPages = pages === null || pages === undefined ? null : parseSlots(pages);
  if (
    !isUint(rev, Number.MAX_SAFE_INTEGER) ||
    history === null ||
    !Array.isArray(upserted) ||
    upserted.length > MAX_ANNOTATIONS_PER_DOC ||
    !Array.isArray(removed) ||
    removed.length > MAX_ANNOTATIONS_PER_DOC ||
    !(removed as unknown[]).every((id) => isUint(id)) ||
    (pages !== null && pages !== undefined && parsedPages === null)
  )
    return null;
  const parsed: Annotation[] = [];
  for (const item of upserted as unknown[]) {
    const annotation = parseAnnotation(item);
    if (annotation === null) return null;
    parsed.push(annotation);
  }
  return { rev, upserted: parsed, removed: removed as number[], pages: parsedPages, history };
}

// --- Commands --------------------------------------------------------------------------------------------------------

/**
 * The annotations of a page, by id. The first call for a page makes the backend read them from the file; later calls answer from
 * its model. Rejects with `invalid_argument` (`page`) for a page the document does not have and `not_found` for a document that
 * is not open.
 */
export async function listAnnotations(docId: number, pageId: number): Promise<Annotation[]> {
  const annotations = parseAnnotations(await call<unknown>('list_annotations', { docId, pageId }));
  if (annotations === null) throw toAppError(null);
  return annotations;
}

/**
 * Runs a command on the document's annotations. Resolves with the change set; rejects, with nothing changed, with
 * `invalid_argument` (`what` names the field), `not_found` (`annotation`), or `limit_exceeded`.
 */
export async function applyCommand(docId: number, command: DocCommand): Promise<ChangeSet> {
  const changes = parseChangeSet(await call<unknown>('apply_command', { docId, command }));
  if (changes === null) throw toAppError(null);
  return changes;
}

/** Takes back the last step. With nothing to undo the change set is empty and its `rev` is the current one. */
export async function undo(docId: number): Promise<ChangeSet> {
  const changes = parseChangeSet(await call<unknown>('undo', { docId }));
  if (changes === null) throw toAppError(null);
  return changes;
}

/** Does the last undone step again. With nothing to redo the change set is empty. */
export async function redo(docId: number): Promise<ChangeSet> {
  const changes = parseChangeSet(await call<unknown>('redo', { docId }));
  if (changes === null) throw toAppError(null);
  return changes;
}

// --- The document's annotations as a list (the comments panel) -----------------------------------------------------------

/** Longest excerpt of the contents in a summary, in characters (`SUMMARY_EXCERPT_CHARS`). */
export const MAX_SUMMARY_EXCERPT_CHARS = 240;

/**
 * What the comments panel needs of an annotation (`list_document_annotations`): no geometry, only the start of the contents.
 * `contents`, `author` and `modified` come from the file: text only, never markup.
 */
export interface AnnotationSummary {
  id: number;
  pageId: number;
  kind: AnnotationKind;
  color: Rgb;
  contents: string;
  author: string | null;
  modified: string | null;
  inReplyTo: number | null;
}

const KINDS: readonly string[] = [
  'highlight',
  'underline',
  'strikeout',
  'note',
  'freeText',
  'ink',
  'rect',
  'ellipse',
  'line',
  'opaque',
] satisfies AnnotationKind[];

function parseSummary(value: unknown): AnnotationSummary | null {
  if (!isRecord(value)) return null;
  const { id, pageId, kind, color, contents, author, modified, inReplyTo } = value;
  if (
    !isUint(id) ||
    !isUint(pageId) ||
    typeof kind !== 'string' ||
    !KINDS.includes(kind) ||
    !Array.isArray(color) ||
    color.length !== 3 ||
    !(color as unknown[]).every((c) => isUint(c, 255)) ||
    typeof contents !== 'string' ||
    contents.length > MAX_SUMMARY_EXCERPT_CHARS * 2 ||
    !(author === null || typeof author === 'string') ||
    !(modified === null || typeof modified === 'string') ||
    !(inReplyTo === null || isUint(inReplyTo))
  )
    return null;
  return {
    id,
    pageId,
    kind: kind as AnnotationKind,
    color: color as unknown as Rgb,
    contents,
    author,
    modified,
    inReplyTo,
  };
}

/** Validates the answer of `list_document_annotations`: at most 20 000 summaries. `null` if it is not a list of them. */
export function parseAnnotationSummaries(value: unknown): AnnotationSummary[] | null {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS_PER_DOC) return null;
  const summaries: AnnotationSummary[] = [];
  for (const item of value as unknown[]) {
    const summary = parseSummary(item);
    if (summary === null) return null;
    summaries.push(summary);
  }
  return summaries;
}

/**
 * The annotations of every page as summaries, by page and id. Pages the backend has not read yet are read from the file at
 * background priority, so this can take a moment on a large document. Rejects with `not_found` for a document that is not open.
 */
export async function listDocumentAnnotations(docId: number): Promise<AnnotationSummary[]> {
  const summaries = parseAnnotationSummaries(await call<unknown>('list_document_annotations', { docId }));
  if (summaries === null) throw toAppError(null);
  return summaries;
}
