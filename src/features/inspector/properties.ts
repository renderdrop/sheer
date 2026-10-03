import type { Annotation, AnnotationKind, AnnotationPatch, DocCommand, LineEnd, Rgb } from '../../api/annotations';
import type { CreationKind } from '../../stores/tools';
import { sameRgb } from './palette';
import { FONT_SIZE_RANGE, type AnnotationStyle } from './style';

/** The parts of the inspector (DESIGN 3.24). */
export type Section = 'colour' | 'opacity' | 'stroke' | 'fontSize' | 'lineEnd';

const STROKE_KINDS: ReadonlySet<AnnotationKind> = new Set(['ink', 'rect', 'ellipse', 'line']);

/** The sections one kind of annotation has. `opaque` annotations are shown and never changed, so they have none. */
export function sectionsOfKind(kind: AnnotationKind): readonly Section[] {
  if (kind === 'opaque') return [];
  // Marks and vector signatures take a colour only (DESIGN 3.34); a picture ignores it.
  if (kind === 'signature' || kind === 'mark') return ['colour'];
  return [
    'colour',
    'opacity',
    ...(STROKE_KINDS.has(kind) ? (['stroke'] as const) : []),
    ...(kind === 'freeText' ? (['fontSize'] as const) : []),
    ...(kind === 'line' ? (['lineEnd'] as const) : []),
  ];
}

/** Multi-selection (DESIGN 3.24): only the sections every selected kind has. */
export function sectionsOfSelection(annotations: readonly Annotation[]): readonly Section[] {
  const [first, ...rest] = annotations;
  if (first === undefined) return [];
  return sectionsOfKind(first.kind).filter((section) => rest.every((a) => sectionsOfKind(a.kind).includes(section)));
}

/** The sections the options of a tool have: the sections of the kind it creates (the arrow has a line end, the plain line none). */
export function sectionsOfTool(kind: CreationKind): readonly Section[] {
  switch (kind) {
    case 'arrow':
      return sectionsOfKind('line');
    case 'line':
      return sectionsOfKind('line').filter((section) => section !== 'lineEnd');
    default:
      return sectionsOfKind(kind);
  }
}

/** A value the selection shares, or `mixed`. */
export interface Shared<T> {
  value: T | null;
  mixed: boolean;
}

export function shared<T>(values: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): Shared<T> {
  const [first, ...rest] = values;
  if (first === undefined) return { value: null, mixed: false };
  return rest.every((value) => same(first, value)) ? { value: first, mixed: false } : { value: null, mixed: true };
}

/** The stroke width of an annotation that has one. */
export function widthOf(annotation: Annotation): number | null {
  return annotation.kind === 'ink' ||
    annotation.kind === 'rect' ||
    annotation.kind === 'ellipse' ||
    annotation.kind === 'line'
    ? annotation.width
    : null;
}

/** What the selection shows in each section. */
export interface SelectionValues {
  color: Shared<Rgb>;
  opacity: Shared<number>;
  width: Shared<number>;
  fontSize: Shared<number>;
  head: Shared<LineEnd>;
}

export function valuesOfSelection(annotations: readonly Annotation[]): SelectionValues {
  const numbers = (pick: (a: Annotation) => number | null): number[] =>
    annotations.flatMap((a) => {
      const value = pick(a);
      return value === null ? [] : [value];
    });
  return {
    color: shared(
      annotations.map((a) => a.color),
      sameRgb,
    ),
    // Opacity compares as a whole percent: a file's 0.4999 and 0.5 are the same to the eye and to the field.
    opacity: shared(
      annotations.map((a) => Math.round(a.opacity * 100) / 100),
      (a, b) => a === b,
    ),
    width: shared(numbers(widthOf)),
    fontSize: shared(numbers((a) => (a.kind === 'freeText' ? a.fontSize : null))),
    head: shared(annotations.flatMap((a) => (a.kind === 'line' ? [a.head] : []))),
  };
}

export function valuesOfStyle(style: AnnotationStyle): SelectionValues {
  const one = <T>(value: T): Shared<T> => ({ value, mixed: false });
  return {
    color: one(style.color),
    opacity: one(style.opacity),
    width: one(style.width),
    fontSize: one(style.fontSize),
    head: one(style.head),
  };
}

/** The label of the undo step of a change made to several annotations at once (a key of the catalogs). */
export const LABEL_CHANGE = 'annotation.update';

/** The model's patch for a change of style, limited to the fields the annotation's kind has. */
export function patchFor(annotation: Annotation, change: Partial<AnnotationStyle>): AnnotationPatch {
  const sections = sectionsOfKind(annotation.kind);
  const patch: { -readonly [K in keyof AnnotationPatch]: AnnotationPatch[K] } = {};
  if (change.color !== undefined && sections.includes('colour')) patch.color = change.color;
  if (change.opacity !== undefined && sections.includes('opacity')) patch.opacity = change.opacity;
  if (change.width !== undefined && sections.includes('stroke')) patch.width = change.width;
  if (change.fontSize !== undefined && sections.includes('fontSize')) {
    patch.fontSize = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, change.fontSize));
  }
  if (change.head !== undefined && sections.includes('lineEnd')) patch.head = change.head;
  return patch;
}

/**
 * The command for a change to the selection: one update for one annotation, one batch (one undo step) for several. `null` when the
 * change touches nothing (nothing selected, or no field applies).
 */
export function commandFor(annotations: readonly Annotation[], change: Partial<AnnotationStyle>): DocCommand | null {
  const commands: DocCommand[] = annotations.flatMap((annotation) => {
    const patch = patchFor(annotation, change);
    return Object.keys(patch).length === 0 ? [] : [{ type: 'updateAnnotation' as const, id: annotation.id, patch }];
  });
  const [only, ...more] = commands;
  if (only === undefined) return null;
  return more.length === 0 ? only : { type: 'batch', label: LABEL_CHANGE, commands };
}
