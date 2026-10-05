import { create } from 'zustand';

import type { LineEnd, Rgb, TextAlign } from '../api/annotations';
import type { Morph } from '../features/annotations/create/recognise';
import type { ToolId } from './ui';

/**
 * The variants of the tools that have some (DESIGN 3.22, ADR-029): Markup is Highlight, Underline or Strikethrough; Shapes is
 * Rectangle, Ellipse, Line or Arrow. The last one chosen per family is remembered (in this webview's storage; nothing of it
 * leaves the machine). Which tool is active, and whether it is locked, stays in the `ui` store (`activeTool`, `toolLocked`);
 * `creationKind` below turns the two into what the creation layer makes.
 */
export const MARKUP_VARIANTS = ['highlight', 'underline', 'strikeout'] as const;
export const SHAPE_VARIANTS = ['rect', 'ellipse', 'line', 'arrow'] as const;
export type MarkupVariant = (typeof MARKUP_VARIANTS)[number];
export type ShapeVariant = (typeof SHAPE_VARIANTS)[number];

/** The tools that have variants. */
export type ToolFamily = 'highlight' | 'shapes';

/** What a creation tool makes: the annotation kinds of the model, with the shapes' arrow as a line with an arrow head. */
export type CreationKind =
  MarkupVariant | 'citation' | 'note' | 'freeText' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow';

const STORAGE_KEY = 'sheer.toolVariants';
const DEFAULTS_KEY = 'sheer.toolDefaults';
const KINDS: readonly CreationKind[] = [...MARKUP_VARIANTS, 'citation', 'note', 'freeText', 'ink', ...SHAPE_VARIANTS];
const HEADS: readonly LineEnd[] = ['none', 'openArrow', 'closedArrow'];
const ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];
const isColour = (c: unknown): c is Rgb => Array.isArray(c) && c.length === 3 && c.every(isByte);

const isByte = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;
const isNum = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

/** The stored defaults, field by field validated (storage is outside input); whatever is wrong is dropped. */
export function parseDefaults(raw: unknown): KindDefaults {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Partial<Record<CreationKind, KindDefault>> = {};
  for (const kind of KINDS) {
    const entry = (raw as Record<string, unknown>)[kind];
    if (typeof entry !== 'object' || entry === null) continue;
    const {
      color,
      opacity,
      width,
      fontSize,
      head,
      bothEnds,
      align,
      border,
      borderWidth,
      borderColor,
      fillOn,
      fillColor,
    } = entry as Record<string, unknown>;
    const value: { -readonly [K in keyof KindDefault]: KindDefault[K] } = {};
    if (isColour(color)) value.color = color;
    const knownAlign = ALIGNS.find((a) => a === align);
    if (knownAlign !== undefined) value.align = knownAlign;
    if (typeof border === 'boolean') value.border = border;
    if (isNum(borderWidth, 0.5, 72)) value.borderWidth = borderWidth;
    if (isColour(borderColor)) value.borderColor = borderColor;
    if (typeof fillOn === 'boolean') value.fillOn = fillOn;
    if (isColour(fillColor)) value.fillColor = fillColor;
    if (isNum(opacity, 0.1, 1)) value.opacity = opacity;
    if (isNum(width, 0.5, 72)) value.width = width;
    if (isNum(fontSize, 6, 144)) value.fontSize = fontSize;
    const known = HEADS.find((h) => h === head);
    if (known !== undefined) value.head = known;
    if (typeof bothEnds === 'boolean') value.bothEnds = bothEnds;
    if (Object.keys(value).length > 0) out[kind] = value;
  }
  return out;
}

function loadDefaults(): KindDefaults {
  try {
    return parseDefaults(JSON.parse(globalThis.localStorage.getItem(DEFAULTS_KEY) ?? 'null'));
  } catch {
    return {};
  }
}

function saveDefaults(defaults: KindDefaults): void {
  try {
    globalThis.localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
  } catch {
    // Storage unavailable or full: the defaults last for the session.
  }
}

/**
 * What the next annotation of a kind gets (DESIGN v2 3.3): the last value the user chose, in the mini bar or in the split menu's swatch
 * row. A field that is not here has the first-run default (highlight Solar, strokes Ink 2 pt, text 12 pt; `DEFAULT_STYLES`).
 */
export interface KindDefault {
  color?: Rgb;
  opacity?: number;
  width?: number;
  fontSize?: number;
  head?: LineEnd;
  /** An arrow has its head at both ends (DESIGN 3.5 B11). */
  bothEnds?: boolean;
  /** Text comment (DESIGN 3.5 B4): alignment, border on/off with its width and colour, fill on/off with its colour. */
  align?: TextAlign;
  border?: boolean;
  borderWidth?: number;
  borderColor?: Rgb;
  fillOn?: boolean;
  fillColor?: Rgb;
}

export type KindDefaults = Readonly<Partial<Record<CreationKind, KindDefault>>>;

export interface ToolsState {
  markup: MarkupVariant;
  shapes: ShapeVariant;
  /** The last used style per creation kind. */
  defaults: KindDefaults;
  /** Whether Zeichnen turns a rough shape into a real one when the pen pauses (DESIGN 3.5 B11); default on. */
  straightenShapes: boolean;
  setStraightenShapes: (on: boolean) => void;
  /** The last stroke straightened into a shape (from/to), for the morph animation; null when none (F17.5). */
  morph: Morph | null;
  setMorph: (morph: Morph | null) => void;
  /** Remembers a change as the default of a kind (merged into what the kind has). */
  setDefault: (kind: CreationKind, change: KindDefault) => void;
  setMarkup: (variant: MarkupVariant) => void;
  setShapes: (variant: ShapeVariant) => void;
  /** The key of the tool again while it is active: the next variant of its family. */
  cycle: (family: ToolFamily) => void;
}

function load(): Pick<ToolsState, 'markup' | 'shapes'> {
  const fallback = { markup: MARKUP_VARIANTS[0], shapes: SHAPE_VARIANTS[0] };
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return fallback;
    const { markup, shapes } = raw as Record<string, unknown>;
    return {
      markup: MARKUP_VARIANTS.find((v) => v === markup) ?? fallback.markup,
      shapes: SHAPE_VARIANTS.find((v) => v === shapes) ?? fallback.shapes,
    };
  } catch {
    return fallback;
  }
}

function save(state: Pick<ToolsState, 'markup' | 'shapes'>): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({ markup: state.markup, shapes: state.shapes }));
  } catch {
    // Storage unavailable or full: the choice lasts for the session.
  }
}

const next = <T extends string>(all: readonly T[], current: T): T =>
  all[(all.indexOf(current) + 1) % all.length] ?? current;

/** UI storage of the shape recognition switch (DESIGN 3.5 B11): "0" is off, anything else on. */
export const RECOGNISE_KEY = 'sheer.tools.shapeRecognition';

function loadRecognise(): boolean {
  try {
    return globalThis.localStorage.getItem(RECOGNISE_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useTools = create<ToolsState>()((set, get) => ({
  ...load(),
  defaults: loadDefaults(),
  straightenShapes: loadRecognise(),
  morph: null,
  setMorph: (morph) => {
    set({ morph });
  },
  setStraightenShapes: (on) => {
    set({ straightenShapes: on });
    try {
      globalThis.localStorage.setItem(RECOGNISE_KEY, on ? '1' : '0');
    } catch {
      // Storage unavailable or full: the choice lasts for the session.
    }
  },
  setDefault: (kind, change) => {
    const defaults = { ...get().defaults, [kind]: { ...get().defaults[kind], ...change } };
    set({ defaults });
    saveDefaults(defaults);
  },
  setMarkup: (markup) => {
    set({ markup });
    save(get());
  },
  setShapes: (shapes) => {
    set({ shapes });
    save(get());
  },
  cycle: (family) => {
    if (family === 'highlight') get().setMarkup(next(MARKUP_VARIANTS, get().markup));
    else get().setShapes(next(SHAPE_VARIANTS, get().shapes));
  },
}));

/** What the active tool creates, `null` for Select and the tools that make no annotation (Form, Signature, Pages). */
export function creationKind(tool: ToolId, tools: Pick<ToolsState, 'markup' | 'shapes'>): CreationKind | null {
  switch (tool) {
    case 'highlight':
      return tools.markup;
    case 'cite':
      return 'citation';
    case 'note':
      return 'note';
    case 'text':
      return 'freeText';
    case 'draw':
      return 'ink';
    case 'shapes':
      return tools.shapes;
    default:
      return null;
  }
}

/** The family of a tool that has variants. */
export function familyOf(tool: ToolId): ToolFamily | null {
  return tool === 'highlight' || tool === 'shapes' ? tool : null;
}

/** The `tool.*` catalog key that names the tool as it is now (its variant, for Markup and Shapes). */
export function toolNameKey(
  tool: ToolId,
  tools: Pick<ToolsState, 'markup' | 'shapes'>,
):
  | 'tool.highlight'
  | 'tool.underline'
  | 'tool.cite'
  | 'tool.strike'
  | 'tool.note'
  | 'tool.text'
  | 'tool.draw'
  | 'tool.rect'
  | 'tool.ellipse'
  | 'tool.line'
  | 'tool.arrow'
  | null {
  switch (tool) {
    case 'highlight':
      return tools.markup === 'highlight'
        ? 'tool.highlight'
        : tools.markup === 'underline'
          ? 'tool.underline'
          : 'tool.strike';
    case 'cite':
      return 'tool.cite';
    case 'note':
      return 'tool.note';
    case 'text':
      return 'tool.text';
    case 'draw':
      return 'tool.draw';
    case 'shapes':
      return `tool.${tools.shapes}`;
    default:
      return null;
  }
}
