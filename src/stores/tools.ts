import { create } from 'zustand';

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
export type CreationKind = MarkupVariant | 'note' | 'freeText' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow';

const STORAGE_KEY = 'sheer.toolVariants';

export interface ToolsState {
  markup: MarkupVariant;
  shapes: ShapeVariant;
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

export const useTools = create<ToolsState>()((set, get) => ({
  ...load(),
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
