import { useMemo } from 'react';
import { create } from 'zustand';

import type { LineEnd, Rgb } from '../../api/annotations';
import { creationKind, useTools, type CreationKind } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { DEFAULT_COLOURS, HIGHLIGHT_OPACITY, migrateColour, paletteNameOf } from './palette';

/**
 * The style a new annotation gets (DESIGN 3.24): what the inspector's tool options edit while no annotation is selected. One style per
 * kind of annotation, so Highlight keeps yellow while Draw keeps blue. Package P6 (creation) reads it with `useAnnotationStyle()`.
 */
export interface AnnotationStyle {
  color: Rgb;
  /** 0.1 to 1. */
  opacity: number;
  /** Line width in points: 1, 2, 4 or 8 (the presets). Used by Draw, Rectangle, Ellipse, Line and Arrow. */
  width: number;
  /** Free text size in points, 6 to 144. */
  fontSize: number;
  /** The head of a line or arrow. */
  head: LineEnd;
}

export const STROKE_PRESETS = [1, 2, 4, 8] as const;
export const FONT_SIZES = [8, 10, 12, 14, 18, 24, 36] as const;
export const FONT_SIZE_RANGE = { min: 6, max: 144 } as const;
export const OPACITY_RANGE = { min: 0.1, max: 1, step: 0.05 } as const;

const BASE = { opacity: 1, width: 2, fontSize: 12, head: 'none' } as const;

/** The defaults of every kind a tool creates. */
export const DEFAULT_STYLES: Readonly<Record<CreationKind, AnnotationStyle>> = {
  highlight: { ...BASE, opacity: HIGHLIGHT_OPACITY, color: DEFAULT_COLOURS.highlight },
  underline: { ...BASE, color: DEFAULT_COLOURS.underline },
  strikeout: { ...BASE, color: DEFAULT_COLOURS.strikeout },
  note: { ...BASE, color: DEFAULT_COLOURS.note },
  freeText: { ...BASE, color: DEFAULT_COLOURS.freeText },
  ink: { ...BASE, color: DEFAULT_COLOURS.ink },
  rect: { ...BASE, color: DEFAULT_COLOURS.shape },
  ellipse: { ...BASE, color: DEFAULT_COLOURS.shape },
  line: { ...BASE, color: DEFAULT_COLOURS.shape },
  arrow: { ...BASE, color: DEFAULT_COLOURS.shape, head: 'openArrow' },
};

export interface StyleStoreState {
  /** What the user changed, per kind; a kind that is not here has its default. */
  overrides: Readonly<Partial<Record<CreationKind, Partial<AnnotationStyle>>>>;
  /** Changes the style of a kind. */
  set: (kind: CreationKind, change: Partial<AnnotationStyle>) => void;
  reset: () => void;
}

const COLOUR_KEY = 'sheer.styleColours';

/**
 * The last-used colour per kind from the previous session. One that is no longer in the palette of its kind (the Okabe-Ito colours of
 * v1.1, or garbage) is dropped, so the kind falls back to its default.
 */
export function loadStoredColours(raw: string | null): Partial<Record<CreationKind, Partial<AnnotationStyle>>> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Partial<Record<CreationKind, Partial<AnnotationStyle>>> = {};
  for (const kind of Object.keys(DEFAULT_STYLES) as CreationKind[]) {
    const fallback = DEFAULT_STYLES[kind].color;
    const color = migrateColour((parsed as Record<string, unknown>)[kind], paletteNameOf(kind), fallback);
    if (color !== fallback) out[kind] = { color };
  }
  return out;
}

function readColours(): StyleStoreState['overrides'] {
  try {
    return loadStoredColours(localStorage.getItem(COLOUR_KEY));
  } catch {
    return {};
  }
}

function writeColours(overrides: StyleStoreState['overrides']): void {
  try {
    const colours = Object.fromEntries(
      Object.entries(overrides).flatMap(([kind, style]) => (style?.color === undefined ? [] : [[kind, style.color]])),
    );
    localStorage.setItem(COLOUR_KEY, JSON.stringify(colours));
  } catch {
    // Storage may be unavailable; the colour then lasts for the session.
  }
}

export const useStyleStore = create<StyleStoreState>()((set) => ({
  overrides: readColours(),
  set: (kind, change) =>
    set((state) => {
      const overrides = { ...state.overrides, [kind]: { ...state.overrides[kind], ...change } };
      if (change.color !== undefined) writeColours(overrides);
      return { overrides };
    }),
  reset: () => {
    writeColours({});
    set({ overrides: {} });
  },
}));

/** The style for `kind` now (outside React). */
export function styleFor(
  kind: CreationKind,
  overrides: StyleStoreState['overrides'] = useStyleStore.getState().overrides,
): AnnotationStyle {
  return { ...DEFAULT_STYLES[kind], ...overrides[kind] };
}

/**
 * The style a new annotation of `kind` gets; without `kind`, of the active tool's (Select, which creates nothing, answers the
 * Draw style). The same object while nothing it depends on changes.
 */
export function useAnnotationStyle(kind?: CreationKind): AnnotationStyle {
  const activeTool = useUi((state) => state.activeTool);
  const markup = useTools((state) => state.markup);
  const shapes = useTools((state) => state.shapes);
  const overrides = useStyleStore((state) => state.overrides);
  const resolved = kind ?? creationKind(activeTool, { markup, shapes }) ?? 'ink';
  return useMemo(() => styleFor(resolved, overrides), [resolved, overrides]);
}
