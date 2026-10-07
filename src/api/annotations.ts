import { call } from './call';
import { parseCite, parseTagNames, type Cite } from './cite';
import type { SetBibliographyCommand } from './citations';
import type { SetHeaderFooterCommand } from './headerFooter';
import { toAppError } from './errors';
import { parseFieldStates, type FieldState, type SetFieldValueCommand } from './forms';
import type { SignatureRole } from './library';
import type { MetadataPatch } from './metadata';
import { parseSlots, type CropPagesCommand, type PageCommand, type PageSlotInfo } from './pages';
import type { RedactMarkSpec } from './redaction';
import { parseChangeWarnings, type ChangeWarning, type EditTextLine } from './textEdit';
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
/** Characters and laid-out lines of a text box, its font size range in points, the smallest side of a text box or image in points (ADR-047). */
export const MAX_TEXT_BOX_CHARS = 8_192;
export const MAX_TEXT_BOX_LINES = 500;
export const MIN_TEXT_BOX_FONT_PT = 4;
export const MAX_TEXT_BOX_FONT_PT = 144;
export const MIN_CONTENT_BOX_PT = 4;
/** Longest contents of an annotation in characters (`MAX_ANNOT_CONTENTS_CHARS`); a UTF-16 string is at most twice as long in units. */
export const MAX_ANNOT_CONTENTS_CHARS = 32_768;
/** Entries of the undo stack (`MAX_HISTORY_ENTRIES`). */
export const MAX_HISTORY_ENTRIES = 500;

export type Rgb = readonly [number, number, number];
export type LineEnd = 'none' | 'openArrow' | 'closedArrow';
export type NoteIcon = 'comment' | 'note' | 'help';
export type MarkGlyph = 'check' | 'cross' | 'dot';

/** The stamps the picker offers (`custom` is the user's own text) and the two colours of a stamp (ARCHITECTURE 16.1). */
export type StampKind = 'draft' | 'approved' | 'confidential' | 'received' | 'custom';
export type StampTone = 'solar' | 'ink';
/** Longest stamp text and date, in characters (the backend refuses more). */
export const MAX_STAMP_TEXT_CHARS = 64;
export const MAX_STAMP_DATE_CHARS = 32;
const STAMP_KINDS: ReadonlySet<string> = new Set<StampKind>([
  'draft',
  'approved',
  'confidential',
  'received',
  'custom',
]);
/** The faces of a text box: Helvetica, Times-Roman and Courier, WinAnsi characters only (ADR-047). */
export type StdFont = 'sans' | 'serif' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';
/** Where a redaction mark came from: a text search or selection, or an area the user drew. */
export type RedactSource = 'text' | 'area';
/** Where a signature's picture comes from: an asset of the document (`useSignature`), or the file. Aspect is width over height. */
export type SignatureArtRef = { type: 'asset'; assetId: number; aspect: number } | { type: 'file' };
/** Smallest side of a signature or mark in points, and the range of a signature's aspect (the backend refuses beyond them). */
export const MIN_SIGNATURE_SIDE_PT = 4;
export const MIN_SIGNATURE_ASPECT = 0.01;
export const MAX_SIGNATURE_ASPECT = 100;
/**
 * The review state a reply gives the annotation it replies to (PDF `/StateModel /Review`, `/State`): Resolve is `completed`,
 * Reopen is `none`. The status of a comment is the state of its newest reply that has one.
 */
export type ReviewState = 'none' | 'accepted' | 'rejected' | 'cancelled' | 'completed';
export const REVIEW_STATES: readonly ReviewState[] = ['none', 'accepted', 'rejected', 'cancelled', 'completed'];
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
  /** Set on a review reply: it only gives its parent a state and is not drawn on the page. */
  state?: ReviewState;
  locked: boolean;
  sync: SyncState;
  /** Set on a citation (a highlight with a quote, ADR-119); absent on every other annotation. */
  cite?: Cite;
  /** The tag names of the annotation (at most 8); absent when none. */
  tags?: readonly string[];
}

export type AnnotationBody =
  | { kind: 'highlight' | 'underline' | 'strikeout'; quads: readonly Quad[] }
  | { kind: 'note'; at: Point; icon: NoteIcon }
  | {
      kind: 'freeText';
      box: Rect;
      lines: readonly string[];
      fontSize: number;
      /** The opaque background (`/C`), `null` for none. */
      fill: Rgb | null;
      /** 0 is no border. */
      borderWidth: number;
      /** How each line sits in the box (`/Q`); the backend always sends it, a draft may leave it out (left). */
      align?: TextAlign;
      /** The border's colour; `null` or missing draws it in the text colour. */
      borderColor?: Rgb | null;
    }
  | { kind: 'ink'; strokes: readonly Stroke[]; width: number }
  | { kind: 'rect' | 'ellipse'; box: Rect; width: number; fill: Rgb | null; dashed: boolean }
  | { kind: 'line'; from: Point; to: Point; width: number; head: LineEnd; tail: LineEnd }
  /** A signature or initials (ADR-041 section 5). `art.type = 'file'` is what a reloaded file has: the picture is in the file and is kept. */
  | { kind: 'signature'; box: Rect; role: SignatureRole; art: SignatureArtRef; angle?: number }
  /** A check, a cross or a dot of Fill & Sign, drawn in the annotation's colour. */
  | { kind: 'mark'; box: Rect; glyph: MarkGlyph; angle?: number }
  /**
   * A stamp (ADR-139): a `/Stamp` with its own appearance. `text` is the visible label, localized by the UI; `date` an optional second
   * line, formatted by the UI. The colour of the annotation is always the tone's.
   */
  | { kind: 'stamp'; box: Rect; stamp: StampKind; text: string; date: string | null; tone: StampTone }
  /** An annotation of a kind the app does not edit: shown and selectable, never changed. */
  | { kind: 'opaque'; subtype: string };

export type Annotation = AnnotationCommon & AnnotationBody;
export type AnnotationKind = Annotation['kind'];

/**
 * The kinds of ADR-047 that are not comments: text boxes and images (page content that the next save burns in) and redaction marks
 * (model only). The backend sends them like any annotation, in `upserted` and in the page lists, but they are kept apart from
 * `Annotation` in these types: the comment features (list, inspector, panel) handle exactly the kinds above, and a content or redaction
 * feature reads these through `ChangeSet.content` and `listContentObjects`.
 */
export type ContentBody =
  /** A text box. `lines` is the backend layout of `text` (read-only); it grows the box height to fit. The colour is the text colour. */
  | {
      kind: 'textBox';
      box: Rect;
      text: string;
      lines: readonly string[];
      font: StdFont;
      fontSize: number;
      align: TextAlign;
    }
  /** An image; the pixels are a document asset (`insertImageDialog`), aspect is width over height. */
  | { kind: 'image'; box: Rect; assetId: number; aspect: number }
  /** A mark for true redaction: in the model only, never written to a file or read from one. */
  | { kind: 'redactMark'; quads: readonly Quad[]; source: RedactSource };

export type ContentAnnotation = AnnotationCommon & ContentBody;
export type ContentKind = ContentBody['kind'];

/** The kinds the user can create (everything but `opaque`). */
export type DraftBody =
  | Exclude<AnnotationBody, { kind: 'opaque' } | { kind: 'signature' } | { kind: 'stamp' }>
  /** A new stamp; a box of size 0 by 0 gets the natural size at its position. `date` is required for `received`. */
  | { kind: 'stamp'; box: Rect; stamp: StampKind; text: string; date?: string | null; tone: StampTone }
  /** A new signature always brings its own art; art that is "in the file" only comes from a reload. */
  | {
      kind: 'signature';
      box: Rect;
      role: SignatureRole;
      art: Extract<SignatureArtRef, { type: 'asset' }>;
      angle?: number;
    };

/** The fields every draft has. */
interface DraftCommon {
  pageId: number;
  color: Rgb;
  opacity?: number;
  contents?: string;
  author?: string | null;
  inReplyTo?: number | null;
  /** Makes the draft a review reply: a note with `inReplyTo`, no contents. */
  state?: ReviewState;
  locked?: boolean;
}

/** An annotation to create: the backend assigns `id`, `rect`, `sync` and `modified`. */
export type AnnotationDraft = DraftCommon & DraftBody;

/** What a new content object or mark is made of. A text box has no `lines` (the backend lays them out) and its height is ignored. */
export type ContentDraftBody =
  Omit<Extract<ContentBody, { kind: 'textBox' }>, 'lines'> | Extract<ContentBody, { kind: 'image' | 'redactMark' }>;

/** A text box, image or redaction mark to create. */
export type ContentDraft = DraftCommon & ContentDraftBody;

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
  /** The border colour of a free text. */
  borderColor?: Rgb;
  strokes?: readonly Stroke[];
  width?: number;
  dashed?: boolean;
  from?: Point;
  to?: Point;
  head?: LineEnd;
  tail?: LineEnd;
  /** Text box fields (`fontSize` and `box` are shared with other kinds); `lines` is not patchable for a text box. */
  text?: string;
  font?: StdFont;
  align?: TextAlign;
  /** The turn of a signature or a mark in degrees, clockwise on the page (ADR-105). */
  angle?: number;
  /** Replaces the tag names (at most 8; ADR-119). Coalesce key `tags`. */
  tags?: readonly string[];
  /** Replaces the quote of a citation (1 to 2 000 characters; ADR-119). A patch for another kind is refused. */
  quote?: string;
  /** The text, the date line and the tone of a stamp. Coalesce key `stamp` while typing. */
  stampText?: string;
  stampDate?: string | null;
  stampTone?: StampTone;
}

/**
 * A command on the document's annotations. One command is one undo step; a `batch` is one step made of several and happens
 * completely or not at all. `label` of a batch is a key of the catalogs (`[A-Za-z0-9._-]`, at most 64 characters), shown with Undo.
 * Updates of one annotation with the same `coalesce` key within 1.5 s are one step (a slider, a colour being dragged).
 */
export type DocCommand =
  | { type: 'createAnnotation'; draft: AnnotationDraft | ContentDraft }
  | { type: 'updateAnnotation'; id: number; patch: AnnotationPatch; coalesce?: string }
  | { type: 'deleteAnnotations'; ids: readonly number[] }
  | { type: 'moveAnnotations'; ids: readonly number[]; dx: number; dy: number }
  | { type: 'batch'; label: string; commands: readonly DocCommand[] }
  | SetFieldValueCommand
  | PageCommand
  | CropPagesCommand
  /** Marks areas for true redaction, up to 10 000 as one step (ADR-047). */
  | { type: 'markRedactions'; marks: readonly RedactMarkSpec[] }
  /** Edits the metadata written at the next save (ADR-047). */
  | { type: 'setMetadata'; patch: MetadataPatch }
  | { type: 'removeMetadata' }
  /** Sets the bibliographic record written at the next save (ADR-119). */
  | SetBibliographyCommand
  /** Stages the headers and footers the next save writes, or their removal (ADR-139). */
  | SetHeaderFooterCommand
  /** Replaces the text of one line of existing page text (ADR-125). */
  | EditTextLine;

/** What else a command changed besides annotations, pages and fields: the UI reads it again with `getMetadata` or `getProtection`. */
export type DocPart = 'metadata' | 'protection' | 'bibliography' | 'ocr' | 'headerFooter';

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
  /** The form fields whose value changed (ADR-041); empty when none did. */
  fields?: readonly FieldState[];
  /** The text boxes, images and redaction marks among the upserted objects (ADR-047); they are not in `upserted`. Omitted when none. */
  content?: readonly ContentAnnotation[];
  /** Metadata or protection changed (ADR-047); the backend always sends the list, a fixture may leave it out. */
  doc?: readonly DocPart[];
  /** Notes of the change (ADR-125): `textOverflow`, `fontFallback`. Omitted when none. */
  warnings?: readonly ChangeWarning[];
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

/** The turn of a signature or a mark if the backend sent a finite one (ADR-105); an answer without it is not turned. */
function parseAngle(value: unknown): { angle?: number } {
  return typeof value === 'number' && Number.isFinite(value) ? { angle: value } : {};
}

function parseSignatureArt(value: unknown): SignatureArtRef | null {
  if (!isRecord(value)) return null;
  if (value.type === 'file') return { type: 'file' };
  const { assetId, aspect } = value;
  return value.type === 'asset' &&
    isUint(assetId) &&
    typeof aspect === 'number' &&
    aspect >= MIN_SIGNATURE_ASPECT &&
    aspect <= MAX_SIGNATURE_ASPECT
    ? { type: 'asset', assetId, aspect }
    : null;
}

const STD_FONTS: ReadonlySet<unknown> = new Set<StdFont>(['sans', 'serif', 'mono']);
const TEXT_ALIGNS: ReadonlySet<unknown> = new Set<TextAlign>(['left', 'center', 'right']);
const REDACT_SOURCES: ReadonlySet<unknown> = new Set<RedactSource>(['text', 'area']);
const DOC_PARTS: ReadonlySet<unknown> = new Set<DocPart>([
  'metadata',
  'protection',
  'bibliography',
  'ocr',
  'headerFooter',
]);
const CONTENT_KINDS: ReadonlySet<unknown> = new Set<ContentKind>(['textBox', 'image', 'redactMark']);

function parseContentBody(value: Record<string, unknown>): ContentBody | null {
  const { kind } = value;
  switch (kind) {
    case 'textBox': {
      const box = parseRect(value.box);
      const { text, lines, font, fontSize, align } = value;
      if (
        box === null ||
        typeof text !== 'string' ||
        text.length > 2 * MAX_TEXT_BOX_CHARS ||
        !Array.isArray(lines) ||
        lines.length > MAX_TEXT_BOX_LINES ||
        !(lines as unknown[]).every((line) => typeof line === 'string') ||
        !STD_FONTS.has(font) ||
        !isWidth(fontSize) ||
        !TEXT_ALIGNS.has(align)
      )
        return null;
      return { kind, box, text, lines: lines as string[], font: font as StdFont, fontSize, align: align as TextAlign };
    }
    case 'image': {
      const box = parseRect(value.box);
      const { assetId, aspect } = value;
      return box !== null &&
        isUint(assetId) &&
        typeof aspect === 'number' &&
        aspect >= MIN_SIGNATURE_ASPECT &&
        aspect <= MAX_SIGNATURE_ASPECT
        ? { kind, box, assetId, aspect }
        : null;
    }
    case 'redactMark': {
      const quads = parseQuads(value.quads);
      return quads !== null && REDACT_SOURCES.has(value.source)
        ? { kind, quads, source: value.source as RedactSource }
        : null;
    }
    default:
      return null;
  }
}

/** Whether a wire annotation is one of the content kinds (text box, image, redaction mark). */
export function isContentWire(value: unknown): boolean {
  return isRecord(value) && CONTENT_KINDS.has(value.kind);
}

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
      const borderColor = parseOptionalRgb(value.borderColor ?? null);
      // A file from before the alignment existed has none: left.
      const align = value.align ?? 'left';
      if (
        box === null ||
        fill === undefined ||
        borderColor === undefined ||
        !TEXT_ALIGNS.has(align) ||
        !Array.isArray(lines) ||
        lines.length > MAX_FREE_TEXT_LINES ||
        !(lines as unknown[]).every((line) => typeof line === 'string') ||
        !isWidth(fontSize) ||
        !isWidth(borderWidth)
      )
        return null;
      return {
        kind,
        box,
        lines: lines as string[],
        fontSize,
        fill,
        borderWidth,
        align: align as TextAlign,
        borderColor,
      };
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
    case 'signature': {
      const box = parseRect(value.box);
      const art = parseSignatureArt(value.art);
      return box !== null && art !== null && (value.role === 'signature' || value.role === 'initials')
        ? { kind, box, role: value.role, art, ...parseAngle(value.angle) }
        : null;
    }
    case 'mark': {
      const box = parseRect(value.box);
      return box !== null && (value.glyph === 'check' || value.glyph === 'cross' || value.glyph === 'dot')
        ? { kind, box, glyph: value.glyph, ...parseAngle(value.angle) }
        : null;
    }
    case 'stamp': {
      const box = parseRect(value.box);
      const { stamp, text, date, tone } = value;
      return box !== null &&
        typeof stamp === 'string' &&
        STAMP_KINDS.has(stamp) &&
        typeof text === 'string' &&
        text.length <= 2 * MAX_STAMP_TEXT_CHARS &&
        (date === null ||
          date === undefined ||
          (typeof date === 'string' && date.length <= 2 * MAX_STAMP_DATE_CHARS)) &&
        (tone === 'solar' || tone === 'ink')
        ? { kind, box, stamp: stamp as StampKind, text, date: date ?? null, tone }
        : null;
    }
    case 'opaque':
      return typeof value.subtype === 'string' ? { kind, subtype: value.subtype } : null;
    default:
      return null;
  }
}

/** The fields every annotation has, and a body parser for the kinds it may be; `null` if either does not fit. */
function parseWith<Body>(
  value: unknown,
  parseBodyOf: (value: Record<string, unknown>) => Body | null,
): (AnnotationCommon & Body) | null {
  if (!isRecord(value)) return null;
  const { id, pageId, opacity, contents, author, modified, inReplyTo, locked, sync, state } = value;
  const rect = parseRect(value.rect);
  const color = parseRgb(value.color);
  const body = parseBodyOf(value);
  // The file is the source of both: a cite record that does not fit reads as a plain highlight, an odd tag is dropped.
  const cite = parseCite(value.cite);
  const tags = parseTagNames(value.tags);
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
    !SYNC_STATES.has(sync) ||
    !(state === undefined || REVIEW_STATES.includes(state as ReviewState))
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
    ...(state === undefined ? {} : { state: state as ReviewState }),
    ...(cite === null ? {} : { cite }),
    ...(tags.length === 0 ? {} : { tags }),
    ...body,
  };
}

/** Validates one annotation; `null` if it is not one. Keys that are not part of it are dropped. */
export function parseAnnotation(value: unknown): Annotation | null {
  return parseWith(value, parseBody);
}

/** Validates one text box, image or redaction mark; `null` if it is not one. */
export function parseContentAnnotation(value: unknown): ContentAnnotation | null {
  return parseWith(value, parseContentBody);
}

/**
 * Validates the answer of `list_annotations`: at most 2 000 annotations. `null` if it is not a list of annotations. The text boxes,
 * images and redaction marks of the page are left out (`parseContentAnnotations` reads them).
 */
export function parseAnnotations(value: unknown): Annotation[] | null {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS_PER_PAGE) return null;
  const annotations: Annotation[] = [];
  for (const item of value as unknown[]) {
    if (isContentWire(item)) continue;
    const annotation = parseAnnotation(item);
    if (annotation === null) return null;
    annotations.push(annotation);
  }
  return annotations;
}

/** The text boxes, images and redaction marks of an answer of `list_annotations`; the comments among them are left out. */
export function parseContentAnnotations(value: unknown): ContentAnnotation[] | null {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS_PER_PAGE) return null;
  const objects: ContentAnnotation[] = [];
  for (const item of value as unknown[]) {
    if (!isContentWire(item)) continue;
    const object = parseContentAnnotation(item);
    if (object === null) return null;
    objects.push(object);
  }
  return objects;
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
  const fields = parseFieldStates(value.fields);
  const doc = value.doc;
  if (
    !(
      doc === undefined ||
      (Array.isArray(doc) && doc.length <= 3 && (doc as unknown[]).every((part) => DOC_PARTS.has(part)))
    ) ||
    !isUint(rev, Number.MAX_SAFE_INTEGER) ||
    history === null ||
    fields === null ||
    !Array.isArray(upserted) ||
    upserted.length > MAX_ANNOTATIONS_PER_DOC ||
    !Array.isArray(removed) ||
    removed.length > MAX_ANNOTATIONS_PER_DOC ||
    !(removed as unknown[]).every((id) => isUint(id)) ||
    (pages !== null && pages !== undefined && parsedPages === null)
  )
    return null;
  const parsed: Annotation[] = [];
  const content: ContentAnnotation[] = [];
  for (const item of upserted as unknown[]) {
    if (isContentWire(item)) {
      const object = parseContentAnnotation(item);
      if (object === null) return null;
      content.push(object);
      continue;
    }
    const annotation = parseAnnotation(item);
    if (annotation === null) return null;
    parsed.push(annotation);
  }
  const changes: ChangeSet = {
    rev,
    upserted: parsed,
    removed: removed as number[],
    pages: parsedPages,
    fields,
    history,
  };
  if (content.length > 0) changes.content = content;
  if (doc !== undefined) changes.doc = doc as DocPart[];
  const warnings = parseChangeWarnings(value.warnings);
  if (warnings.length > 0) changes.warnings = warnings;
  return changes;
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
 * The text boxes, images and redaction marks of a page (ADR-047), from the same answer as `listAnnotations`, which leaves them out.
 */
export async function listContentObjects(docId: number, pageId: number): Promise<ContentAnnotation[]> {
  const objects = parseContentAnnotations(await call<unknown>('list_annotations', { docId, pageId }));
  if (objects === null) throw toAppError(null);
  return objects;
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
  /** Review replies only. */
  state?: ReviewState;
  /** A mark's glyph (`check`, `cross`, `dot`), a stamp's kind, a signature's role (`signature`, `initials`), `arrow` for a line with an end. */
  detail?: string;
  /** The tag names (ADR-119); absent when none. */
  tags?: readonly string[];
  /** A citation (ADR-119); absent otherwise. */
  cite?: true;
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
  'signature',
  'mark',
  'stamp',
  'opaque',
] satisfies AnnotationKind[];

function parseSummary(value: unknown): AnnotationSummary | null {
  if (!isRecord(value)) return null;
  const { id, pageId, kind, color, contents, author, modified, inReplyTo, state, detail } = value;
  const tags = parseTagNames(value.tags);
  if (
    !(state === undefined || REVIEW_STATES.includes(state as ReviewState)) ||
    !(detail === undefined || (typeof detail === 'string' && detail.length <= 16)) ||
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
    ...(state === undefined ? {} : { state: state as ReviewState }),
    ...(detail === undefined ? {} : { detail }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(value.cite === true ? { cite: true as const } : {}),
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

/** An annotation import that was not complete: `skipped` annotations of `page` stay in the file but cannot be edited here. */
export interface ImportWarning {
  type: 'pageTruncated';
  page: number;
  skipped: number;
}

/** Validates the answer of `import_warnings`; entries of another shape are dropped (a note is never worth an error). */
export function parseImportWarnings(raw: unknown): ImportWarning[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportWarning[] = [];
  for (const item of raw as unknown[]) {
    if (isRecord(item) && item.type === 'pageTruncated' && isUint(item.page) && isUint(item.skipped)) {
      out.push({ type: 'pageTruncated', page: item.page, skipped: item.skipped });
    }
  }
  return out;
}

/** What the reading of the document's annotations left out so far. Rejects with `not_found` for a document that is not open. */
export async function importWarnings(docId: number): Promise<ImportWarning[]> {
  return parseImportWarnings(await call<unknown>('import_warnings', { docId }));
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

/** Longest quote the backend sends, in characters. */
export const MAX_QUOTE_CHARS = 280;

/**
 * The text of the page under a highlight, underline or strikeout (`get_annotation_quote`): at most 280 characters, whitespace collapsed;
 * `null` for another kind or when there is no text there. Rejects with `not_found` (`annotation`) for an id the model does not have.
 */
export async function getAnnotationQuote(docId: number, annotationId: number): Promise<string | null> {
  const raw = await call<unknown>('get_annotation_quote', { docId, annotationId });
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > MAX_QUOTE_CHARS * 2) throw toAppError(null);
  return raw;
}
