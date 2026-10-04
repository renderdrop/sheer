import type {
  Annotation,
  AnnotationDraft,
  AnnotationPatch,
  ContentAnnotation,
  DocCommand,
  MarkGlyph,
  Rgb,
  TextAlign,
} from '../../api/annotations';
import type { CreationKind, KindDefault } from '../../stores/tools';
import { LABEL_CHANGE, shared, widthOf, type Shared } from '../inspector/properties';
import { sameRgb, HIGHLIGHT_OPACITY } from '../inspector/palette';
import type { AnnotationStyle } from '../inspector/style';

/** Anything the mini bar can be about: an annotation of the model, a text box, an image or a redaction mark. */
export type MiniObject = Annotation | ContentAnnotation;

/** The groups of selection that have the same controls (DESIGN v2 3.3 table). */
export type BarKind = 'markup' | 'note' | 'text' | 'freeText' | 'stroke' | 'shape' | 'mark' | 'plain';

/** The controls of the bar; Löschen is always last and not listed. */
export type ControlId =
  | 'colourHighlight'
  | 'colourStroke'
  | 'kindMarkup'
  | 'kindMark'
  | 'comment'
  | 'fontSize'
  | 'align'
  | 'textBorder'
  | 'textFill'
  | 'strokeWidth'
  | 'opacity'
  | 'fill';

/** The order the controls have in the bar. */
const ORDER: readonly ControlId[] = [
  'colourHighlight',
  'colourStroke',
  'kindMarkup',
  'kindMark',
  'strokeWidth',
  'opacity',
  'fill',
  'fontSize',
  'align',
  'textBorder',
  'textFill',
  'comment',
];

export function barKindOf(object: MiniObject): BarKind | null {
  switch (object.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return 'markup';
    case 'note':
      return 'note';
    case 'freeText':
      return 'freeText';
    case 'textBox':
      return 'text';
    case 'ink':
    case 'line':
      return 'stroke';
    case 'rect':
    case 'ellipse':
      return 'shape';
    case 'mark':
      return 'mark';
    case 'signature':
    case 'image':
    case 'redactMark':
      return 'plain';
    default:
      // An annotation of a kind the app does not edit: never changed, so the bar has nothing for it.
      return null;
  }
}

const CONTROLS: Readonly<Record<BarKind, readonly ControlId[]>> = {
  markup: ['colourHighlight', 'kindMarkup', 'comment'],
  note: ['colourHighlight', 'comment'],
  text: ['colourStroke', 'fontSize'],
  freeText: ['colourStroke', 'fontSize', 'align', 'textBorder', 'textFill'],
  stroke: ['colourStroke', 'strokeWidth', 'opacity'],
  shape: ['colourStroke', 'strokeWidth', 'opacity', 'fill'],
  mark: ['kindMark'],
  plain: [],
};

/** The controls the whole selection has in common (several selected: only those; the comment belongs to one object). */
export function controlsOf(objects: readonly MiniObject[]): readonly ControlId[] {
  const kinds = objects.map(barKindOf);
  if (kinds.length === 0 || kinds.some((kind) => kind === null)) return [];
  const lists = kinds.map((kind) => (kind === null ? [] : CONTROLS[kind]));
  return ORDER.filter(
    (control) => (control !== 'comment' || objects.length === 1) && lists.every((list) => list.includes(control)),
  );
}

/** What the controls show; `mixed` when the selection differs. */
export interface MiniValues {
  color: Shared<Rgb>;
  width: Shared<number>;
  opacity: Shared<number>;
  fontSize: Shared<number>;
  /** The fill of a shape or a text comment. */
  fill: Shared<Rgb | null>;
  /** Text comment: the alignment, the border width (0 is none) and the border colour (the text colour if it has none). */
  align: Shared<TextAlign>;
  borderWidth: Shared<number>;
  borderColour: Shared<Rgb>;
  /** The markup kind or mark glyph. */
  kind: Shared<string>;
}

export function valuesOf(objects: readonly MiniObject[]): MiniValues {
  const numbers = (pick: (o: MiniObject) => number | null): number[] =>
    objects.flatMap((o) => {
      const value = pick(o);
      return value === null ? [] : [value];
    });
  return {
    color: shared(
      objects.map((o) => o.color),
      sameRgb,
    ),
    width: shared(
      numbers((o) => (o.kind === 'textBox' || o.kind === 'image' || o.kind === 'redactMark' ? null : widthOf(o))),
    ),
    opacity: shared(numbers((o) => Math.round(o.opacity * 100) / 100)),
    fontSize: shared(numbers((o) => (o.kind === 'freeText' || o.kind === 'textBox' ? o.fontSize : null))),
    fill: shared(
      objects.flatMap((o) => (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'freeText' ? [o.fill] : [])),
      (a, b) => (a === null || b === null ? a === b : sameRgb(a, b)),
    ),
    align: shared(objects.flatMap((o) => (o.kind === 'freeText' ? [o.align ?? 'left'] : []))),
    borderWidth: shared(numbers((o) => (o.kind === 'freeText' ? o.borderWidth : null))),
    borderColour: shared(
      objects.flatMap((o) => (o.kind === 'freeText' ? [o.borderColor ?? o.color] : [])),
      sameRgb,
    ),
    kind: shared(objects.map((o) => (o.kind === 'mark' ? o.glyph : o.kind))),
  };
}

/** A change made in the bar: the style fields of the inspector plus the fill of a shape or text comment, and the text comment's own. */
export type MiniChange = Partial<AnnotationStyle> & {
  fill?: Rgb | null;
  align?: TextAlign;
  /** 0 switches the border off. */
  borderWidth?: number;
  borderColor?: Rgb;
};

/** The font sizes of the bar's dropdown (DESIGN v2 3.3: 8 to 72 pt). */
export const MINI_FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48, 72] as const;
/** What the font size field accepts when typed (DESIGN 3.5 B4). */
export const MINI_FONT_SIZE_RANGE = { min: 6, max: 144 } as const;
export const MINI_STROKES = [0.5, 1, 2, 4, 8] as const;
export const MINI_OPACITIES = [25, 50, 75, 100] as const;

/** The model's patch for one object: only the fields its group has. */
export function patchOf(object: MiniObject, change: MiniChange): AnnotationPatch {
  const kind = barKindOf(object);
  const patch: { -readonly [K in keyof AnnotationPatch]: AnnotationPatch[K] } = {};
  if (kind === null || kind === 'mark' || kind === 'plain') return patch;
  const text = kind === 'text' || kind === 'freeText';
  if (change.color !== undefined) patch.color = change.color;
  if (change.opacity !== undefined && (kind === 'stroke' || kind === 'shape')) patch.opacity = change.opacity;
  if (change.width !== undefined && (kind === 'stroke' || kind === 'shape')) patch.width = change.width;
  if (change.fill !== undefined && (kind === 'shape' || kind === 'freeText')) patch.fill = change.fill;
  if (change.fontSize !== undefined && text) patch.fontSize = change.fontSize;
  if (kind === 'freeText') {
    if (change.align !== undefined) patch.align = change.align;
    if (change.borderWidth !== undefined) patch.borderWidth = change.borderWidth;
    if (change.borderColor !== undefined) patch.borderColor = change.borderColor;
  }
  return patch;
}

/** One update for one object, one batch (one undo step) for several, `null` when nothing applies. Locked objects are left alone. */
export function changeCommand(objects: readonly MiniObject[], change: MiniChange): DocCommand | null {
  const commands: DocCommand[] = objects.flatMap((object) => {
    if (object.locked) return [];
    const patch = patchOf(object, change);
    return Object.keys(patch).length === 0 ? [] : [{ type: 'updateAnnotation' as const, id: object.id, patch }];
  });
  const [only, ...more] = commands;
  if (only === undefined) return null;
  return more.length === 0 ? only : { type: 'batch', label: LABEL_CHANGE, commands };
}

/** The creation kind whose default an object's change sets; none for marks, signatures, images and redaction marks. */
export function creationKindOf(object: MiniObject): CreationKind | null {
  switch (object.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'note':
    case 'freeText':
    case 'ink':
    case 'rect':
    case 'ellipse':
      return object.kind;
    case 'line':
      return object.head === 'none' ? 'line' : 'arrow';
    default:
      return null;
  }
}

/** The part of a change that is a default of the kind (what the next annotation of it gets); `null` when there is none. */
export function defaultOf(object: MiniObject, change: MiniChange): Partial<AnnotationStyle> | null {
  const patch = patchOf(object, change);
  const out: { -readonly [K in keyof AnnotationStyle]?: AnnotationStyle[K] } = {};
  if (patch.color !== undefined) out.color = patch.color;
  if (patch.opacity !== undefined) out.opacity = patch.opacity;
  if (patch.width !== undefined) out.width = patch.width;
  if (patch.fontSize !== undefined) out.fontSize = patch.fontSize;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * What a change to a text comment sets as the default of the next one (DESIGN 3.5 B4, 3.3): the alignment, the border (on with its
 * width and colour, or off) and the fill (on with its colour, or off). `null` when the change has none of them.
 */
export function textDefaultOf(object: MiniObject, change: MiniChange): KindDefault | null {
  if (object.kind !== 'freeText') return null;
  const patch = patchOf(object, change);
  const out: { -readonly [K in keyof KindDefault]?: KindDefault[K] } = {};
  if (patch.align !== undefined) out.align = patch.align;
  if (patch.borderWidth !== undefined) {
    out.border = patch.borderWidth > 0;
    if (patch.borderWidth > 0) out.borderWidth = patch.borderWidth;
  }
  if (patch.borderColor !== undefined) out.borderColor = patch.borderColor;
  if (patch.fill !== undefined) {
    out.fillOn = patch.fill !== null;
    if (patch.fill !== null) out.fillColor = patch.fill;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Turns markups into another kind or marks into another glyph: the model has no patch for it, so one batch deletes each object and
 * creates its replacement (one undo step). `null` for objects that have no such kind.
 */
export function kindCommand(objects: readonly MiniObject[], kind: string): DocCommand | null {
  const commands: DocCommand[] = [];
  for (const object of objects) {
    if (object.locked) continue;
    const draft = replacement(object, kind);
    if (draft === null) continue;
    commands.push({ type: 'deleteAnnotations', ids: [object.id] }, { type: 'createAnnotation', draft });
  }
  return commands.length === 0 ? null : { type: 'batch', label: LABEL_CHANGE, commands };
}

function replacement(object: MiniObject, kind: string): AnnotationDraft | null {
  const common = {
    pageId: object.pageId,
    color: object.color,
    contents: object.contents,
    author: object.author,
    inReplyTo: null,
  };
  if (object.kind === 'highlight' || object.kind === 'underline' || object.kind === 'strikeout') {
    if (kind !== 'highlight' && kind !== 'underline' && kind !== 'strikeout') return null;
    if (kind === object.kind) return null;
    return { ...common, kind, opacity: kind === 'highlight' ? HIGHLIGHT_OPACITY : 1, quads: object.quads };
  }
  if (object.kind === 'mark') {
    if (kind !== 'check' && kind !== 'cross' && kind !== 'dot') return null;
    const glyph: MarkGlyph = kind;
    if (glyph === object.glyph) return null;
    return { ...common, opacity: object.opacity, kind: 'mark', box: object.box, glyph };
  }
  return null;
}
